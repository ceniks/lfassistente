/**
 * O registro do que foi enviado, mês a mês.
 *
 * Existe para responder "a Célia recebeu o de agosto?" sem depender da memória
 * de ninguém — e para que um reenvio seja decisão, não acidente.
 *
 * Duas limitações ditas na cara: o disco do Railway é efêmero, então um deploy
 * novo apaga o arquivo se não houver volume montado (ver DEPLOY.md); e o
 * registro diz que o e-mail foi aceito pelo Gmail, não que a pessoa leu. A
 * prova durável de cada envio continua sendo a caixa "Enviados" da conta.
 */
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";

const ARQUIVO = process.env.RH_HISTORICO ?? "dados/envios-holerite.json";

/** Guarda os últimos lotes. Passa disso, o mais antigo sai. */
const LIMITE = 240;

export interface EnvioRegistrado {
  nome: string;
  email: string;
  ok: boolean;
  erro?: string;
}

export interface LoteRegistrado {
  quando: string;
  mes: string;
  arquivo?: string;
  envios: EnvioRegistrado[];
}

export async function listarHistorico(): Promise<LoteRegistrado[]> {
  try {
    return JSON.parse(await readFile(ARQUIVO, "utf8")) as LoteRegistrado[];
  } catch {
    return [];
  }
}

export async function registrarEnvio(lote: LoteRegistrado): Promise<void> {
  try {
    const todos = [lote, ...(await listarHistorico())].slice(0, LIMITE);
    await mkdir(dirname(ARQUIVO), { recursive: true });
    await writeFile(`${ARQUIVO}.tmp`, JSON.stringify(todos, null, 1));
    await rename(`${ARQUIVO}.tmp`, ARQUIVO);
  } catch (e) {
    // Falhar o registro não pode derrubar o envio, que já aconteceu.
    console.error("[rh] não consegui gravar o histórico:", e);
  }
}

/**
 * Quem já recebeu em cada mês — para a página avisar antes de repetir.
 *
 * Guarda e-mail E nome: corrigir o endereço de alguém na tabela não pode
 * apagar o fato de que aquela pessoa já recebeu o holerite do mês.
 */
export async function jaRecebeuEm(mes: string): Promise<Set<string>> {
  const chaves = new Set<string>();
  for (const lote of await listarHistorico()) {
    if (chaveDeMes(lote.mes) !== chaveDeMes(mes)) continue;
    for (const e of lote.envios) {
      if (!e.ok) continue;
      chaves.add(e.email.toLowerCase());
      chaves.add(chaveDeNome(e.nome));
    }
  }
  return chaves;
}

/** "Agosto/2026", "agosto de 2026" e "08/2026" são o mesmo mês. */
function chaveDeMes(mes: string): string {
  const m = mes
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+de\s+/g, "/")
    .replace(/\s+/g, "");
  const meses = ["janeiro","fevereiro","marco","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];
  const achado = meses.findIndex((x) => m.startsWith(x));
  const ano = m.match(/\d{4}/)?.[0] ?? "";
  return achado >= 0 ? `${achado + 1}/${ano}` : m;
}

export function chaveDeNome(nome: string): string {
  return nome
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
