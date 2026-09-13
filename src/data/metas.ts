import { google } from 'googleapis';
import { config } from '../config.js';

/**
 * Metas diárias, lidas de uma planilha do Google Sheets.
 *
 * Service account é o caso mais simples de autenticação do projeto: você cria a
 * conta de serviço, compartilha a planilha com o e-mail dela e acabou. Não há
 * fluxo de OAuth, navegador nem token expirando — que é exatamente o que o
 * Agent SDK não consegue fazer sozinho num servidor.
 *
 * Formato esperado da planilha (aba "Metas"):
 *
 *   A            B
 *   2026-09-12   95000
 *   2026-09-13   110000
 *
 * A data aceita YYYY-MM-DD ou DD/MM/YYYY. O valor aceita "95000", "95.000,00" e
 * "R$ 95.000" — a planilha é preenchida por gente, não por máquina.
 */

let cache: { carregadoEm: number; metas: Map<string, number> } | null = null;
const TTL = 10 * 60 * 1000;

export async function metaDoDia(dia: string): Promise<number | null> {
  const metas = await carregar();
  return metas.get(dia) ?? null;
}

async function carregar(): Promise<Map<string, number>> {
  if (cache && Date.now() - cache.carregadoEm < TTL) return cache.metas;

  const { GOOGLE_SERVICE_ACCOUNT_JSON, METAS_SPREADSHEET_ID, METAS_RANGE } = config();
  if (!GOOGLE_SERVICE_ACCOUNT_JSON || !METAS_SPREADSHEET_ID) return new Map();

  const credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });

  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: METAS_SPREADSHEET_ID,
    range: METAS_RANGE,
  });

  const metas = new Map<string, number>();
  for (const linha of res.data.values ?? []) {
    const data = normalizarData(String(linha[0] ?? ''));
    const valor = normalizarValor(String(linha[1] ?? ''));
    if (data && valor !== null) metas.set(data, valor);
  }

  cache = { carregadoEm: Date.now(), metas };
  return metas;
}

function normalizarData(bruto: string): string | null {
  const s = bruto.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;

  return null;
}

function normalizarValor(bruto: string): number | null {
  // "R$ 95.000,00" -> 95000.00
  const limpo = bruto
    .replace(/[R$\s]/gi, '')
    .replace(/\./g, '')
    .replace(',', '.');
  if (!limpo) return null;
  const v = Number(limpo);
  return Number.isFinite(v) ? v : null;
}
