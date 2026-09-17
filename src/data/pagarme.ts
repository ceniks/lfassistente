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
  /** MDR: o desconto do dia da venda, medido nos recebíveis. */
  taxa: number;
  /** Antecipação já cobrada nestes recebíveis. Zero no dia da venda. */
  antecipacao: number;
  /**
   * Antecipação que ainda será cobrada, estimada.
   *
   * Não é palpite: a taxa foi medida em 1.526 recebíveis antecipados e é
   * 1,93% ao mês, linear nos dias adiantados — 2,12% em 33 dias, 3,92% em 61,
   * 5,85% em 91, 7,91% em 123. O que não dá para medir no dia da venda é o
   * valor, porque a cobrança só acontece quando a antecipação ocorre, cerca de
   * 30 dias depois. Sem esta linha a venda parcelada parece custar 3,5% quando
   * custa o dobro.
   */
  antecipacaoPrevista: number;
}

/**
 * Custo de antecipação por mês adiantado, medido nos próprios recebíveis.
 *
 * Ver `TaxaPagarme.antecipacaoPrevista`. Fica aqui como constante e não como
 * parâmetro de ambiente porque é medição, não escolha — e porque se a Pagar.me
 * mudar, a conta dos recebíveis pagos denuncia na hora.
 */
export const ANTECIPACAO_AO_MES = 1.93;

/**
 * Antecipar a parcela k adianta cerca de 30 × (k−1) dias, então a média por
 * venda é (parcelas − 1) / 2 meses. Em 8x isso dá 3,5 meses: 6,8% além do MDR.
 */
export function antecipacaoDe(bruto: number, parcelas: number): number {
  if (parcelas <= 1) return 0;
  return bruto * (ANTECIPACAO_AO_MES / 100) * ((parcelas - 1) / 2);
}

async function detalheDaCobranca(
  chargeId: string,
): Promise<{ v1: string | null; parcelas: number }> {
  const r = await fetch(`${BASE}/charges/${chargeId}`, {
    headers: { Authorization: autorizacao(), Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) return { v1: null, parcelas: 1 };
  const j = (await r.json()) as {
    last_transaction?: { gateway_id?: string; installments?: number };
  };
  return {
    v1: j.last_transaction?.gateway_id ?? null,
    parcelas: j.last_transaction?.installments ?? 1,
  };
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
  let antecipacaoPrevista = 0;

  for (const id of chargeIds) {
    const { v1, parcelas } = await detalheDaCobranca(id);
    if (!v1) continue;

    let brutoDaCobranca = 0;
    for (const p of await recebiveis(v1)) {
      const valor = Number(p.amount ?? 0) / 100;
      brutoDaCobranca += valor;
      bruto += valor;
      taxa += Number(p.fee ?? 0) / 100;
      antecipacao += Number(p.anticipation_fee ?? 0) / 100;
    }
    antecipacaoPrevista += antecipacaoDe(brutoDaCobranca, parcelas);
  }

  // Já cobrada tem precedência sobre prevista: onde a antecipação aconteceu,
  // o valor real substitui a estimativa em vez de somar em cima dela.
  return {
    bruto,
    taxa,
    antecipacao,
    antecipacaoPrevista: antecipacao > 0 ? 0 : antecipacaoPrevista,
  };
}
