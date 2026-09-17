/**
 * Mercado Pago — o gateway do Pix da loja.
 *
 * Era a última fatia grande sem conferência: R$ 13.666 em 35 transações no dia
 * 16/09, entrando na margem por alíquota estimada. Duas coisas descobertas ao
 * abrir a API resolvem as duas metades do problema:
 *
 *  - `external_reference` traz **exatamente** o `payment_id` que a Shopify
 *    guarda na transação. É a mesma amarra do PagBank, então a conferência sai
 *    exata, uma a uma, e não por soma contra soma.
 *  - `fee_details` traz a taxa cobrada em reais, e `net_received_amount` o
 *    líquido. Os 0,99% do Pix deixam de ser premissa: R$ 7,84 sobre R$ 791,70
 *    no primeiro pagamento conferido.
 *
 * O formato de saída é o mesmo do PagBank de propósito, para que a conferência
 * seja um código só e não duas que divergem com o tempo.
 */
import { config } from "../config.js";
import type { TransacaoPagBank } from "./pagbank.js";

const BASE = "https://api.mercadopago.com/v1/payments/search";
const POR_PAGINA = 100;

export function temMercadoPago(): boolean {
  return Boolean(config().MERCADOPAGO_TOKEN);
}

/** Aprovado é venda. Pendente, recusado e devolvido não entram em taxa nem em conferência. */
const APROVADO = "approved";

export async function pagamentosDoDia(
  dia: string,
): Promise<TransacaoPagBank[]> {
  const token = config().MERCADOPAGO_TOKEN;
  if (!token) throw new Error("Mercado Pago: falta MERCADOPAGO_TOKEN");

  const fora: TransacaoPagBank[] = [];

  for (let offset = 0; offset < 2000; offset += POR_PAGINA) {
    const url =
      `${BASE}?begin_date=${encodeURIComponent(`${dia}T00:00:00.000-03:00`)}` +
      `&end_date=${encodeURIComponent(`${dia}T23:59:59.999-03:00`)}` +
      `&range=date_created&sort=date_created&criteria=asc` +
      `&limit=${POR_PAGINA}&offset=${offset}`;

    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`Mercado Pago HTTP ${r.status}`);

    const j = (await r.json()) as { results?: Array<Record<string, any>> };
    const lote = j.results ?? [];

    for (const p of lote) {
      const taxa = (p.fee_details ?? []).reduce(
        (s: number, f: { amount?: number }) => s + Number(f.amount ?? 0),
        0,
      );
      fora.push({
        referencia: String(p.external_reference ?? ""),
        codigo: String(p.id ?? ""),
        data: String(p.date_approved ?? p.date_created ?? ""),
        status: String(p.status ?? ""),
        bruto: Number(p.transaction_amount ?? 0),
        taxa,
        liquido: Number(p.transaction_details?.net_received_amount ?? 0),
        valeComoVenda: p.status === APROVADO,
      });
    }

    if (lote.length < POR_PAGINA) break;
  }

  return fora;
}
