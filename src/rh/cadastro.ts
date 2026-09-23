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
import { google } from "googleapis";
import { config } from "../config.js";

export interface Funcionaria {
  nome: string;
  email: string;
  apelido?: string;
}

const TTL = 5 * 60 * 1000;
let cache: { carregadoEm: number; lista: Funcionaria[] } | null = null;

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

export function temCadastro(): boolean {
  const c = config();
  return Boolean(c.GOOGLE_SERVICE_ACCOUNT_JSON && c.RH_SPREADSHEET_ID);
}

export async function carregarCadastro(): Promise<Funcionaria[]> {
  if (cache && Date.now() - cache.carregadoEm < TTL) return cache.lista;

  const { GOOGLE_SERVICE_ACCOUNT_JSON, RH_SPREADSHEET_ID, RH_RANGE } = config();
  if (!GOOGLE_SERVICE_ACCOUNT_JSON || !RH_SPREADSHEET_ID) return [];

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

  const pontas = (s: string) => {
    const p = norm(s).split(" ").filter(Boolean);
    return p.length >= 2 ? `${p[0]} ${p.at(-1)}` : null;
  };

  const alvoPontas = pontas(nome);
  if (!alvoPontas) return null;

  const candidatas = lista.filter(
    (f) => pontas(f.nome) === alvoPontas || (f.apelido && pontas(f.apelido) === alvoPontas),
  );
  // Duas candidatas com as mesmas pontas é ambiguidade real — melhor cair na
  // lista de pendências do que sortear.
  return candidatas.length === 1 ? candidatas[0] : null;
}
