/**
 * Pagar.me — o terceiro meio de pagamento, e o único que não tem pedido
 * automático do lado da Shopify.
 *
 * O fluxo é humano: a atendente monta um rascunho no admin, manda um link de
 * pagamento pelo atendimento, e quando a cliente paga marca o pedido como pago
 * à mão. Para a Shopify isso é o gateway genérico `manual`, indistinguível de
 * "recebi em dinheiro" — R$ 6.572 em 16/09, 8% do faturamento, sem nada com
 * que conferir.
 *
 * Como o pedido manual não tem identificador de pagamento, a amarração aqui
 * não pode ser por id, como é no PagBank. É por **valor e e-mail da cliente**,
 * dentro do dia. Isso é mais fraco de propósito declarado: com poucos pedidos
 * por dia funciona; se um dia forem dezenas, dois valores iguais da mesma
 * cliente ficam ambíguos, e o relatório precisa dizer isso em vez de fingir
 * exatidão que não tem.
 *
 * Dois casos reais de 16/09 mostram por que o resultado não é binário:
 *  - #139279, R$ 638,75 na Shopify, achou R$ 370,00 na Pagar.me com a mesma
 *    cliente. Não é erro: o comentário da atendente dizia "pix e pagar.me", e
 *    a diferença foi paga por Pix. Casamento parcial é uma resposta legítima.
 *  - #139235, R$ 399,80, retirada presencial: nada na Pagar.me, e nada em
 *    lugar nenhum. Esse é o que precisa aparecer.
 */
import { config } from "../config.js";

const BASE = "https://api.pagar.me/core/v5";
const POR_PAGINA = 100;

export interface PedidoPagarme {
  id: string;
  /** `pl_…` quando nasceu de link de pagamento. */
  codigo: string;
  valor: number;
  status: string;
  pago: boolean;
  email: string;
  nome: string;
  criadoEm: string;
  metodo: string;
  /** Id da cobrança, ponte para os recebíveis que trazem a taxa. */
  chargeId: string;
  parcelas: number | null;
}

export function temPagarme(): boolean {
  return Boolean(config().PAGARME_TOKEN);
}

function autorizacao(): string {
  const chave = config().PAGARME_TOKEN;
  if (!chave) throw new Error("Pagar.me: falta PAGARME_TOKEN");
  // A v5 usa Basic com a chave secreta no usuário e senha vazia.
  return `Basic ${Buffer.from(`${chave}:`).toString("base64")}`;
}

/** Todos os pedidos que a Pagar.me registrou no dia, pagos ou não. */
export async function pedidosDoDia(dia: string): Promise<PedidoPagarme[]> {
  const fora: PedidoPagarme[] = [];

  for (let pagina = 1; pagina <= 20; pagina++) {
    const url =
      `${BASE}/orders?created_since=${encodeURIComponent(`${dia}T00:00:00-03:00`)}` +
      `&created_until=${encodeURIComponent(`${dia}T23:59:59-03:00`)}` +
      `&size=${POR_PAGINA}&page=${pagina}`;

    const r = await fetch(url, {
      headers: { Authorization: autorizacao(), Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`Pagar.me HTTP ${r.status}`);

    const j = (await r.json()) as { data?: Array<Record<string, any>> };
    const lote = j.data ?? [];

    for (const p of lote) {
      const c = p.charges?.[0];
      fora.push({
        id: String(p.id ?? ""),
        codigo: String(p.code ?? ""),
        valor: Number(p.amount ?? 0) / 100,
        status: String(p.status ?? ""),
        pago: p.status === "paid",
        email: String(p.customer?.email ?? "").toLowerCase(),
        nome: String(p.customer?.name ?? ""),
        criadoEm: String(p.created_at ?? ""),
        metodo: String(c?.payment_method ?? ""),
        chargeId: String(c?.id ?? ""),
        parcelas: c?.last_transaction?.installments ?? null,
      });
    }

    if (lote.length < POR_PAGINA) break;
  }

  return fora;
}

/* ------------------------------------------------------------------------ *
 * A taxa da Pagar.me mora em outro lugar, e por pouco eu não a usava errada.
 *
 * Na v5 a cobrança não traz taxa nenhuma. Na v1 a transação traz um campo
 * `cost` — R$ 0,15 por transação — que parece a taxa e não é: é o custo de
 * gateway. O desconto de verdade só aparece nos **payables**, os recebíveis:
 * uma linha por parcela, cada uma com `fee`. Somando as parcelas de 16/09 dá
 * R$ 206,92 sobre R$ 5.903,24, ou 3,51%.
 *
 * A ponte entre as duas gerações é o `gateway_id` da última transação da
 * cobrança na v5, que é o id numérico da transação na v1. Sem ele sobraria
 * filtrar a v1 por data — e a data lá é UTC, o que jogaria as vendas da noite
 * para o dia seguinte.
 * ------------------------------------------------------------------------ */

const V1 = "https://api.pagar.me/1";

export interface TaxaPagarme {
  bruto: number;
  taxa: number;
  /** Só existe quando houve antecipação; hoje é zero. */
  antecipacao: number;
}

async function idNaV1(chargeId: string): Promise<string | null> {
  const r = await fetch(`${BASE}/charges/${chargeId}`, {
    headers: { Authorization: autorizacao(), Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) return null;
  const j = (await r.json()) as { last_transaction?: { gateway_id?: string } };
  return j.last_transaction?.gateway_id ?? null;
}

async function recebiveis(
  transacao: string,
): Promise<Array<Record<string, any>>> {
  const chave = config().PAGARME_TOKEN;
  const r = await fetch(
    `${V1}/payables?api_key=${encodeURIComponent(chave ?? "")}` +
      `&transaction_id=${encodeURIComponent(transacao)}&count=100`,
    { signal: AbortSignal.timeout(20_000) },
  );
  if (!r.ok) return [];
  return (await r.json()) as Array<Record<string, any>>;
}

/** Taxa efetivamente descontada nas cobranças informadas. */
export async function taxaDasCobrancas(
  chargeIds: string[],
): Promise<TaxaPagarme> {
  let bruto = 0;
  let taxa = 0;
  let antecipacao = 0;

  for (const id of chargeIds) {
    const v1 = await idNaV1(id);
    if (!v1) continue;
    for (const p of await recebiveis(v1)) {
      bruto += Number(p.amount ?? 0) / 100;
      taxa += Number(p.fee ?? 0) / 100;
      antecipacao += Number(p.anticipation_fee ?? 0) / 100;
    }
  }

  return { bruto, taxa, antecipacao };
}
