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
