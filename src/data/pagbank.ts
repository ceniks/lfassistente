/**
 * Consulta o PagBank para conferir, venda a venda, se o que a Shopify diz que
 * foi pago existe mesmo no gateway.
 *
 * A API nova (api.pagseguro.com) **não lista por data** — em `/orders` a única
 * busca aceita é `charge_id`, e `reference_id`, `created_at_*` e `status` todos
 * voltam 400. Isso torna impossível varrer o dia pelo lado do PagBank.
 *
 * O caminho que funciona é o inverso, e por sorte é o melhor: a Shopify guarda
 * em cada transação um `payment_id` (`receiptJson.payment_id`), e é exatamente
 * esse valor que o app do PagBank grava como `reference_id` da cobrança. Então
 * `GET /charges?reference_id=<payment_id>` resolve pedido a pedido:
 *
 *     Shopify #139406  payment_id re5WezHSkvTtStgsqnPOrTGD9
 *     PagBank  CHAR_A6E9E8C8-…  reference_id re5WezHSkvTtStgsqnPOrTGD9  PAID  41095
 *
 * O que a cobrança traz e a Shopify não tem: `paid_at` exato, `summary.refunded`
 * e o **número de parcelas**, que não existe em lugar nenhum do pedido Shopify.
 *
 * O que ela NÃO traz: taxa e valor líquido. A API nova não expõe `feeAmount`
 * nem `netAmount` — isso só existe na API antiga (ws.pagseguro.uol.com.br), que
 * precisa de outra credencial. Por isso a conferência aqui é de **existência e
 * valor**, não de taxa.
 *
 * Limite conhecido: sem listagem por data, só enxergamos cobranças que algum
 * pedido da Shopify aponta. Uma cobrança no PagBank sem pedido correspondente
 * na Shopify é invisível para esta conferência, e precisa ser dito.
 */
import { config } from "../config.js";

const BASE = "https://api.pagseguro.com";
/** Quantas consultas em paralelo. O PagBank não publica limite; 5 passou sem 429. */
const EM_PARALELO = 5;

export interface Cobranca {
  id: string;
  referencia: string;
  status: string;
  /** Em reais, já convertido dos centavos que a API devolve. */
  valor: number;
  pago: number;
  estornado: number;
  pagoEm: string | null;
  metodo: string;
  /** Só existe em cartão. Pix e boleto voltam null. */
  parcelas: number | null;
}

export function temPagBank(): boolean {
  return Boolean(config().PAGBANK_TOKEN);
}

interface CobrancaCrua {
  id: string;
  reference_id: string;
  status: string;
  paid_at?: string;
  amount: { value: number; summary?: { paid?: number; refunded?: number } };
  payment_method?: { type?: string; installments?: number };
}

const reais = (centavos: number | undefined) => (centavos ?? 0) / 100;

/**
 * Busca a cobrança pelo `reference_id`.
 *
 * `null` quer dizer "o PagBank não conhece essa referência" (404) — que é
 * justamente a divergência que interessa. Erro de rede ou 5xx sobe como
 * exceção, porque tratar falha de infraestrutura como "não existe" inventaria
 * divergência que não existe.
 */
export async function cobrancaPorReferencia(
  referencia: string,
): Promise<Cobranca | null> {
  const token = config().PAGBANK_TOKEN;
  if (!token) throw new Error("PagBank: falta PAGBANK_TOKEN");

  const url = `${BASE}/charges?reference_id=${encodeURIComponent(referencia)}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "*/*" },
    signal: AbortSignal.timeout(20_000),
  });

  if (r.status === 404) return null;
  if (!r.ok) {
    const corpo = (await r.text()).slice(0, 200).replace(/\s+/g, " ");
    throw new Error(`PagBank ${r.status} em ${referencia}: ${corpo}`);
  }

  const corpo = (await r.json()) as CobrancaCrua | CobrancaCrua[];
  const c = Array.isArray(corpo) ? corpo[0] : corpo;
  if (!c) return null;

  return {
    id: c.id,
    referencia: c.reference_id,
    status: c.status,
    valor: reais(c.amount?.value),
    pago: reais(c.amount?.summary?.paid),
    estornado: reais(c.amount?.summary?.refunded),
    pagoEm: c.paid_at ?? null,
    metodo: c.payment_method?.type ?? "desconhecido",
    parcelas: c.payment_method?.installments ?? null,
  };
}

/** Resolve várias referências com paralelismo limitado, preservando a ordem. */
export async function cobrancasPorReferencia(
  referencias: string[],
): Promise<Map<string, Cobranca | null>> {
  const fora = new Map<string, Cobranca | null>();
  const fila = [...new Set(referencias)];

  async function trabalhar() {
    for (let ref = fila.pop(); ref; ref = fila.pop()) {
      fora.set(ref, await cobrancaPorReferencia(ref));
    }
  }

  await Promise.all(Array.from({ length: EM_PARALELO }, trabalhar));
  return fora;
}

/* ------------------------------------------------------------------------ *
 * API antiga (ws.pagseguro.uol.com.br/v3) — a que lista por data e informa
 * quanto o PagBank realmente cobrou.
 *
 * Usa o MESMO token da API nova, ao contrário do que a documentação sugere.
 * O que fazia parecer credencial diferente era o cabeçalho `Accept`: com
 * `application/json` ou com o vendor type ela responde 406 seco, e com `*​/*`
 * responde 200 em XML. Um cabeçalho, não uma credencial.
 *
 * O que ela acrescenta e a API nova não tem:
 *  - listagem por intervalo de data, o que torna possível a conferência
 *    inversa: cobrança no PagBank que nenhum pedido da Shopify aponta.
 *  - `feeAmount` e `netAmount` — a taxa cobrada em cada transação, em reais.
 *    Isso encerra a estimativa: a taxa não é única. Em 16/09 ela foi de 3,12%
 *    à vista a 7,38% em 8x, e a média do dia deu 5,93%.
 * ------------------------------------------------------------------------ */

const LEGADO = "https://ws.pagseguro.uol.com.br/v3/transactions";
/** A busca aceita até 100 por página. */
const POR_PAGINA = 100;

/** Status da API antiga. 3 = paga, 4 = disponível, 6 = devolvida, 7 = cancelada. */
const CANCELADA = 7;
const DEVOLVIDA = 6;

export interface TransacaoPagBank {
  /** Igual ao `payment_id` da Shopify e ao `reference_id` da API nova. */
  referencia: string;
  codigo: string;
  data: string;
  status: string | number;
  bruto: number;
  taxa: number;
  liquido: number;
  /** Cancelada ou devolvida: não é venda do dia e não entra em taxa. */
  valeComoVenda: boolean;
}

const tag = (s: string, nome: string): string | null => {
  const m = s.match(new RegExp(`<${nome}>([^<]*)</${nome}>`));
  return m ? m[1] : null;
};

async function paginaLegado(dia: string, pagina: number): Promise<string> {
  const { PAGBANK_TOKEN: token, PAGBANK_EMAIL: email } = config();
  if (!token || !email)
    throw new Error("PagBank: falta PAGBANK_TOKEN ou PAGBANK_EMAIL");

  const q = new URLSearchParams({
    email,
    token,
    // Sem fuso: a API antiga interpreta no horário de Brasília, que é o que queremos.
    initialDate: `${dia}T00:00:00`,
    finalDate: `${dia}T23:59:59`,
    page: String(pagina),
    maxPageResults: String(POR_PAGINA),
  });

  const r = await fetch(`${LEGADO}?${q}`, {
    // `application/json` e o vendor type devolvem 406. Só `*​/*` passa.
    headers: { Accept: "*/*" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`PagBank legado HTTP ${r.status}`);
  return r.text();
}

/** Todas as transações do dia no PagBank, com a taxa que ele cobrou em cada uma. */
export async function transacoesDoDia(
  dia: string,
): Promise<TransacaoPagBank[]> {
  const primeira = await paginaLegado(dia, 1);
  const paginas = Number(tag(primeira, "totalPages") ?? 1);

  const xmls = [primeira];
  for (let p = 2; p <= paginas; p++) xmls.push(await paginaLegado(dia, p));

  const fora: TransacaoPagBank[] = [];
  for (const xml of xmls) {
    for (const pedaco of xml.split("<transaction>").slice(1)) {
      const s = pedaco.split("</transaction>")[0];
      const status = Number(tag(s, "status") ?? 0);
      fora.push({
        referencia: tag(s, "reference") ?? "",
        codigo: tag(s, "code") ?? "",
        data: tag(s, "date") ?? "",
        status,
        bruto: Number(tag(s, "grossAmount") ?? 0),
        taxa: Number(tag(s, "feeAmount") ?? 0),
        liquido: Number(tag(s, "netAmount") ?? 0),
        valeComoVenda: status !== CANCELADA && status !== DEVOLVIDA,
      });
    }
  }
  return fora;
}
