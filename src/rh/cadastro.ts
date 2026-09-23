/**
 * O cadastro de funcionárias: nome no holerite → e-mail.
 *
 * Fica numa planilha do Google, não no código, porque quem contrata e demite é
 * o RH e não vai abrir um `git commit` para isso. Mesma service account das
 * metas: cria a conta, compartilha a planilha com o e-mail dela, acabou.
 *
 * Formato esperado (primeira aba, com ou sem cabeçalho):
 *
 *   A                        B                         C
 *   Maria Aparecida Silva    maria@exemplo.com.br      Maria Silva
 *
 * A coluna C é opcional: serve quando o nome no holerite é diferente do nome
 * que todo mundo usa. Qualquer uma das duas grafias casa.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { google } from "googleapis";
import { config } from "../config.js";

/**
 * Onde o cadastro enviado pelo site fica guardado.
 *
 * A planilha do Google continua valendo e tem preferência quando está
 * configurada. Mas exigir service account para mandar holerite era uma barreira
 * grande demais: com o arquivo local, sobe-se o CSV uma vez pela página e
 * acabou. Ele é descartável — sumiu no deploy, sobe de novo.
 */
const ARQUIVO = process.env.CADASTRO_RH ?? "dados/funcionarios.json";

export interface Funcionaria {
  nome: string;
  email: string;
  apelido?: string;
}

const TTL = 5 * 60 * 1000;
let cache: { carregadoEm: number; lista: Funcionaria[] } | null = null;

const PARTICULAS = new Set(["de", "da", "do", "das", "dos", "e"]);

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

export function temPlanilha(): boolean {
  const c = config();
  return Boolean(c.GOOGLE_SERVICE_ACCOUNT_JSON && c.RH_SPREADSHEET_ID);
}

export async function temCadastro(): Promise<boolean> {
  return (await carregarCadastro()).length > 0;
}

/**
 * Lê um CSV de cadastro e guarda no disco.
 *
 * Aceita vírgula ou ponto e vírgula, com ou sem aspas e com ou sem cabeçalho —
 * o arquivo sai de uma exportação de planilha, e cada programa escolhe um
 * separador. A coluna do e-mail é achada pelo "@", não pela posição, porque
 * planilha de gente troca a ordem das colunas.
 */
export async function salvarCadastroDeCsv(texto: string): Promise<Funcionaria[]> {
  const lista: Funcionaria[] = [];

  for (const linha of texto.split(/\r?\n/)) {
    if (!linha.trim()) continue;
    const campos = linha
      .split(linha.includes(";") ? ";" : ",")
      .map((c) => c.trim().replace(/^"|"$/g, "").trim());
    const email = campos.find((c) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c));
    const nome = campos.find((c) => c !== email && /\p{L}{2}/u.test(c) && c.split(/\s+/).length >= 2);
    if (!email || !nome) continue;
    const apelido = campos.find((c) => c !== email && c !== nome && /\p{L}{2}/u.test(c));
    lista.push({ nome, email, apelido });
  }

  await mkdir(dirname(ARQUIVO), { recursive: true });
  await writeFile(ARQUIVO, JSON.stringify(lista, null, 1));
  cache = { carregadoEm: Date.now(), lista };
  return lista;
}

export async function carregarCadastro(): Promise<Funcionaria[]> {
  if (cache && Date.now() - cache.carregadoEm < TTL) return cache.lista;

  const { GOOGLE_SERVICE_ACCOUNT_JSON, RH_SPREADSHEET_ID, RH_RANGE } = config();

  if (!GOOGLE_SERVICE_ACCOUNT_JSON || !RH_SPREADSHEET_ID) {
    try {
      const lista = JSON.parse(await readFile(ARQUIVO, "utf8")) as Funcionaria[];
      cache = { carregadoEm: Date.now(), lista };
      return lista;
    } catch {
      return [];
    }
  }

  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: RH_SPREADSHEET_ID,
    range: RH_RANGE,
  });

  const lista: Funcionaria[] = [];
  for (const linha of res.data.values ?? []) {
    const nome = String(linha[0] ?? "").trim();
    const email = String(linha[1] ?? "").trim();
    // Linha de cabeçalho e linha pela metade caem fora sem avisar: a planilha é
    // preenchida por gente.
    if (!nome || !email.includes("@")) continue;
    lista.push({
      nome,
      email,
      apelido: String(linha[2] ?? "").trim() || undefined,
    });
  }

  cache = { carregadoEm: Date.now(), lista };
  return lista;
}

/** Esquece o cache — útil depois de corrigir a planilha e querer reenviar. */
export function esquecerCadastro(): void {
  cache = null;
}

/**
 * Acha a funcionária pelo nome do holerite.
 *
 * Três tentativas, da mais segura para a menos: nome igual (sem acento e sem
 * caixa), apelido igual, e primeiro + último sobrenome iguais — que resolve o
 * "Maria A. Silva" contra "Maria Aparecida Silva" sem abrir a porta para
 * casamento por primeiro nome, que mandaria o holerite da Maria da costura
 * para a Maria do atendimento.
 */
export function acharFuncionaria(
  nome: string,
  lista: Funcionaria[],
): Funcionaria | null {
  const alvo = norm(nome);

  const igual = lista.find(
    (f) => norm(f.nome) === alvo || (f.apelido && norm(f.apelido) === alvo),
  );
  if (igual) return igual;

  /*
   * Fora a igualdade, o que resta é sobreposição de sobrenomes — e ela precisa
   * ser rígida. Na folha de agosto a mesma pessoa aparecia como "ADRIANA DAYANE
   * DE PAULA VAZ" no holerite e "Adriana Dayane de Paula" na planilha, enquanto
   * outra funcionária se chama "Nicolly de Paula Vaz". Por isso: primeiro nome
   * igual, pelo menos dois sobrenomes em comum, um lado contido no outro (ou
   * faltando no máximo um sobrenome), e uma única candidata. Qualquer dúvida
   * vira pendência em vez de palpite.
   */
  const pedacos = (s: string) =>
    norm(s)
      .split(" ")
      .filter((p) => p && !PARTICULAS.has(p));

  const alvoPedacos = pedacos(nome);
  if (alvoPedacos.length < 2) return null;

  const pontuadas = lista
    .map((f) => {
      const dela = pedacos(f.apelido && norm(f.apelido) === alvo ? f.apelido : f.nome);
      if (dela.length < 2 || dela[0] !== alvoPedacos[0]) return null;
      const comuns = dela.filter((p) => alvoPedacos.includes(p));
      const contido =
        dela.every((p) => alvoPedacos.includes(p)) ||
        alvoPedacos.every((p) => dela.includes(p)) ||
        comuns.length >= Math.max(dela.length, alvoPedacos.length) - 1;
      return comuns.length >= 2 && contido ? { f, nota: comuns.length } : null;
    })
    .filter((x): x is { f: Funcionaria; nota: number } => x !== null)
    .sort((a, b) => b.nota - a.nota);

  if (!pontuadas.length) return null;
  // Empate é ambiguidade real: melhor não enviar do que sortear.
  if (pontuadas.length > 1 && pontuadas[0].nota === pontuadas[1].nota) return null;
  return pontuadas[0].f;
}
