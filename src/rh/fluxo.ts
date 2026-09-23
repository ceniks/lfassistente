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
import { enviarPeloGmail, temGmail } from "./gmail.js";
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

/**
 * O texto do e-mail, no formato que a L&F usa.
 *
 * O tratamento vem do primeiro nome. O palpite por terminação erra em nomes
 * como Nicolly e Myrella, então a lista de exceções existe e cresce com a
 * realidade — e na página de RH cada linha pode ser corrigida à mão antes de
 * enviar.
 */
const ELES = new Set(["jose", "silvio", "ronierik", "augusto", "bruno", "antonio", "carlos", "joao", "luis", "luiz", "pedro", "paulo", "marcos", "rafael", "thiago", "tiago", "felipe", "andre", "eduardo", "gabriel", "matheus", "lucas", "daniel", "fernando", "roberto", "ricardo", "rodrigo", "vinicius", "wellington", "wesley", "anderson", "alex", "cesar", "claudio", "douglas", "edson", "fabio", "flavio", "gustavo", "henrique", "igor", "jonas", "julio", "leandro", "leonardo", "marcelo", "mauricio", "nelson", "otavio", "renato", "sergio", "valdir", "wagner", "alexandre", "vicente", "jorge", "jaime", "felipe", "davi", "david", "samuel", "moises", "elias", "israel", "gilberto", "adilson", "nilson"]);
const ELAS = new Set(["nicolly", "myrella", "mirella", "ester", "esther", "raquel", "isabel", "eliane", "ivete", "lucimar", "meire", "neide", "solange", "elisete", "marlene", "marilene", "rosinete", "nair", "miriam", "mirian", "ines", "luci", "lourdes", "carmen", "leticia", "cris", "jennifer", "jaqueline", "michele", "michelle", "millena", "gabrielly", "emilly", "evelyn", "kelly", "kimberly", "sthefany", "stefany", "yasmin", "nicole", "heloisa", "aline", "daiane", "simone", "luciene", "cristiane", "viviane", "juliane", "roseane", "alice", "beatriz", "ingrid", "karen", "mabel", "mercedes"]);

const semAcento = (s: string) =>
  s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();

/** Terminações que em português quase sempre são de nome feminino. */
const FINAIS_DELAS = ["ane", "ene", "iane", "ete", "ite", "elly", "elle", "lly"];

export function tratamentoDe(nome: string): "Prezado" | "Prezada" {
  const primeiro = semAcento(nome.split(" ")[0] ?? "");
  if (ELES.has(primeiro)) return "Prezado";
  if (ELAS.has(primeiro)) return "Prezada";
  if (primeiro.endsWith("a")) return "Prezada";
  if (FINAIS_DELAS.some((f) => primeiro.endsWith(f))) return "Prezada";
  return "Prezado";
}

export function corpoDoEmail(nome: string, mes: string): string {
  const primeiro = nome.split(" ")[0] ?? "";
  return (
    `${tratamentoDe(nome)} ${primeiro},\n\n` +
    `Segue em anexo seu holerite referente ao mês de ${mes}.\n\n` +
    "Agradecemos o seu empenho e dedicação!\n\n" +
    "Atenciosamente,\nL E FASHION EIRELI\n"
  );
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
      const mensagem = {
        para: d.email,
        assunto: c.HOLERITE_ASSUNTO.replace("{mes}", lote.mes).replace("{nome}", d.nome),
        corpo: corpoDoEmail(d.nome, lote.mes),
        anexo: { nome: arquivoDe(d.nome, lote.mes), conteudo: d.pdf },
      };
      // Gmail quando autorizado; SMTP continua valendo para quem preferir senha
      // de app.
      if (temGmail()) await enviarPeloGmail(mensagem);
      else await enviarEmail(mensagem);
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
export async function pendenciasDeConfiguracao(): Promise<string[]> {
  const falta: string[] = [];
  if (!(await temCadastro())) falta.push("o cadastro de funcionárias (suba o CSV na página de RH)");
  if (!temGmail() && !temEnvioDeEmail()) falta.push("a autorização de envio de e-mail");
  return falta;
}
