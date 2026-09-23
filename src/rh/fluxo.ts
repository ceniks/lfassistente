/**
 * O caminho do holerite: PDF no WhatsApp → um arquivo por pessoa → e-mail.
 *
 * A peça central é a confirmação. O sistema divide, casa cada nome com o
 * cadastro e **para**, mostrando quem vai receber o quê. Só depois de um
 * "confirmo" ele envia. Holerite traz salário: um nome casado errado não é um
 * relatório torto, é o contracheque de alguém na caixa de outra pessoa. O custo
 * de esperar trinta segundos por uma resposta é baixo demais para não pagar.
 *
 * O lote fica na memória do processo, com validade de uma hora. Se o serviço
 * reiniciar antes da confirmação, o lote se perde e é só reenviar o PDF — é
 * deliberado: um lote velho esperando "confirmo" é a receita para alguém
 * confirmar o mês errado.
 */
import { dividir, type Holerite } from "./divisor.js";
import {
  acharFuncionaria,
  carregarCadastro,
  temCadastro,
  type Funcionaria,
} from "./cadastro.js";
import { enviarEmail, temEnvioDeEmail } from "./email.js";
import { config } from "../config.js";

export interface Destinatario {
  nome: string;
  email: string;
  paginas: number[];
  pdf: Buffer;
}

export interface Lote {
  criadoEm: number;
  /** Mês de referência, como "setembro de 2026". */
  mes: string;
  prontos: Destinatario[];
  semCadastro: Holerite[];
  paginasSemNome: number[];
  totalDePaginas: number;
}

const VALIDADE = 60 * 60 * 1000;

/** Um lote por número de WhatsApp: cada dono confirma o que ele mesmo mandou. */
const pendentes = new Map<string, Lote>();

export function loteDe(quem: string): Lote | null {
  const lote = pendentes.get(quem);
  if (!lote) return null;
  if (Date.now() - lote.criadoEm > VALIDADE) {
    pendentes.delete(quem);
    return null;
  }
  return lote;
}

export function descartarLote(quem: string): void {
  pendentes.delete(quem);
}

const MESES = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

/**
 * O mês de referência.
 *
 * Tenta o nome do arquivo ("holerites-09-2026.pdf", "folha setembro.pdf") e,
 * sem isso, usa o mês anterior ao de hoje — que é quando a folha é paga.
 */
export function mesDeReferencia(nomeDoArquivo: string, hoje = new Date()): string {
  const limpo = nomeDoArquivo.toLowerCase();

  const numerico = limpo.match(/(0[1-9]|1[0-2])[-_./](20\d{2})/);
  if (numerico) return `${MESES[Number(numerico[1]) - 1]} de ${numerico[2]}`;

  const porNome = MESES.findIndex((m) => limpo.includes(m));
  if (porNome >= 0) {
    const ano = limpo.match(/20\d{2}/)?.[0] ?? String(hoje.getFullYear());
    return `${MESES[porNome]} de ${ano}`;
  }

  const d = new Date(hoje);
  d.setMonth(d.getMonth() - 1);
  return `${MESES[d.getMonth()]} de ${d.getFullYear()}`;
}

const arquivoDe = (nome: string, mes: string) =>
  `holerite-${mes.replace(/\s+de\s+/, "-").replace(/\s/g, "-")}-${nome
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^A-Za-z]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()}.pdf`;

export async function prepararLote(
  quem: string,
  pdf: Buffer,
  nomeDoArquivo: string,
): Promise<Lote> {
  const divisao = await dividir(pdf);
  const cadastro = await carregarCadastro();

  const prontos: Destinatario[] = [];
  const semCadastro: Holerite[] = [];

  for (const h of divisao.holerites) {
    const f: Funcionaria | null = acharFuncionaria(h.nome, cadastro);
    if (!f) {
      semCadastro.push(h);
      continue;
    }
    prontos.push({ nome: h.nome, email: f.email, paginas: h.paginas, pdf: h.pdf });
  }

  const lote: Lote = {
    criadoEm: Date.now(),
    mes: mesDeReferencia(nomeDoArquivo),
    prontos,
    semCadastro,
    paginasSemNome: divisao.paginasSemNome,
    totalDePaginas: divisao.totalDePaginas,
  };

  pendentes.set(quem, lote);
  return lote;
}

/** O texto que vai ao WhatsApp pedindo a confirmação. */
export function resumoDoLote(lote: Lote): string {
  const linhas = [
    `📄 *Holerites de ${lote.mes}* — ${lote.totalDePaginas} página(s) no PDF.`,
    "",
    `Prontos para enviar: ${lote.prontos.length}`,
  ];

  for (const d of lote.prontos) {
    linhas.push(`• ${d.nome} → ${d.email} (pág. ${d.paginas.join(", ")})`);
  }

  if (lote.semCadastro.length) {
    linhas.push("", `⚠️ Sem e-mail no cadastro: ${lote.semCadastro.length}`);
    for (const h of lote.semCadastro) {
      linhas.push(`• ${h.nome} (pág. ${h.paginas.join(", ")})`);
    }
    linhas.push("Estes ninguém recebe. Cadastre na planilha e mande o PDF de novo.");
  }

  if (lote.paginasSemNome.length) {
    linhas.push(
      "",
      `⚠️ Páginas sem nome reconhecido: ${lote.paginasSemNome.join(", ")}`,
      "Elas ficaram de fora — melhor conferir antes de enviar o resto.",
    );
  }

  linhas.push(
    "",
    lote.prontos.length
      ? 'Responda *confirmo* para enviar, ou *cancelar* para descartar.'
      : "Nada a enviar.",
  );

  return linhas.join("\n");
}

export interface Resultado {
  enviados: string[];
  falhas: Array<{ nome: string; email: string; erro: string }>;
}

export async function enviarLote(quem: string): Promise<Resultado> {
  const lote = loteDe(quem);
  if (!lote) throw new Error("não há lote esperando confirmação");

  const c = config();
  const enviados: string[] = [];
  const falhas: Resultado["falhas"] = [];

  for (const d of lote.prontos) {
    try {
      await enviarEmail({
        para: d.email,
        assunto: c.HOLERITE_ASSUNTO.replace("{mes}", lote.mes),
        corpo:
          `Olá, ${d.nome.split(" ")[0]}!\n\n` +
          `Segue em anexo o seu holerite de ${lote.mes}.\n\n` +
          "Qualquer dúvida, é só responder este e-mail.\n\nL&F",
        anexo: { nome: arquivoDe(d.nome, lote.mes), conteudo: d.pdf },
      });
      enviados.push(d.nome);
    } catch (e) {
      falhas.push({
        nome: d.nome,
        email: d.email,
        erro: e instanceof Error ? e.message : String(e),
      });
    }
  }

  descartarLote(quem);
  return { enviados, falhas };
}

/** O que falta configurar para o fluxo funcionar, em linguagem de gente. */
export function pendenciasDeConfiguracao(): string[] {
  const falta: string[] = [];
  if (!temCadastro()) falta.push("a planilha de funcionárias (RH_SPREADSHEET_ID + service account)");
  if (!temEnvioDeEmail()) falta.push("o e-mail de envio (SMTP_USER + SMTP_PASSWORD)");
  return falta;
}
