/**
 * Confere, transação a transação, se o que a Shopify registrou como pago
 * existe mesmo no PagBank e pelo mesmo valor.
 *
 * A conferência é dirigida pelo lado da Shopify, não por escolha de estilo: a
 * API nova do PagBank não lista por data (ver `pagbank.ts`), então a única
 * varredura possível é "para cada transação da Shopify, essa cobrança existe?".
 *
 * Isso tem uma consequência que precisa aparecer no relatório: **o caminho
 * inverso fica cego**. Uma cobrança no PagBank sem pedido na Shopify — cobrança
 * duplicada, pedido apagado, teste que virou venda — não é vista por aqui.
 * Dizer "nenhuma divergência" sem essa ressalva seria mentira por omissão.
 *
 * Só entram transações de cartão e Pix do PagBank. Mercado Pago responde pela
 * outra fatia e tem credencial própria; ele é contado à parte, como volume não
 * conferido, para ninguém ler a diferença como divergência.
 */
import { pedidosPagosEm, type OrderNode } from "./shopify.js";
import {
  cobrancasPorReferencia,
  temPagBank,
  type Cobranca,
} from "./pagbank.js";

/** Centavos de arredondamento que não valem uma linha de divergência. */
export const TOLERANCIA = 0.01;

export type Veredito = "ok" | "ausente" | "status" | "valor";

export interface Conferido {
  pedido: string;
  referencia: string;
  gateway: string;
  valorShopify: number;
  cobranca: Cobranca | null;
  veredito: Veredito;
  /** Frase pronta para o relatório, só nas divergências. */
  explicacao?: string;
}

export interface ConferenciaPagBank {
  /** Transações do PagBank que conseguimos conferir. */
  conferidas: number;
  valorConferido: number;
  ok: number;
  divergentes: Conferido[];
  /** Volume que ficou fora por ser de outro gateway. */
  foraDoAlcance: Array<{ gateway: string; pedidos: number; valor: number }>;
  /** Distribuição de parcelas no cartão — a Shopify não informa isso. */
  parcelas: Array<{ parcelas: number; pedidos: number; valor: number }>;
  /** Estorno já registrado no PagBank para cobranças deste dia. */
  estornadoNoPagBank: number;
}

const ehPagBank = (g: string) => /pagbank|pagseguro/i.test(g);

export interface Linha {
  pedido: string;
  gateway: string;
  referencia: string | null;
  valor: number;
}

/** Transações de venda bem-sucedidas, uma linha por captura. */
function linhasDe(pedidos: OrderNode[]): Linha[] {
  const fora: Linha[] = [];
  for (const p of pedidos) {
    for (const t of p.transactions) {
      if (t.status !== "SUCCESS") continue;
      if (t.kind !== "SALE" && t.kind !== "CAPTURE") continue;
      fora.push({
        pedido: p.name,
        gateway: (t.gateway ?? "não identificado").trim(),
        referencia: t.paymentId ?? null,
        valor: Number(t.amountSet?.shopMoney?.amount ?? 0),
      });
    }
  }
  return fora;
}

/**
 * O julgamento de uma transação. Separado da busca porque é aqui que mora a
 * regra e é isto que precisa de teste — a distinção entre "o PagBank não
 * conhece esta cobrança" e "a consulta falhou" não pode ser adivinhada: a
 * segunda sobe como exceção em `pagbank.ts` e nunca chega aqui.
 */
export function conferir(l: Linha, c: Cobranca | null): Conferido {
  const base = {
    pedido: l.pedido,
    referencia: l.referencia as string,
    gateway: l.gateway,
    valorShopify: l.valor,
    cobranca: c,
  };

  if (!c) {
    return {
      ...base,
      veredito: "ausente",
      explicacao:
        "a Shopify deu como pago e o PagBank não conhece essa cobrança",
    };
  }
  if (c.status !== "PAID") {
    return {
      ...base,
      veredito: "status",
      explicacao: `pago na Shopify, mas ${c.status} no PagBank`,
    };
  }
  if (Math.abs(c.pago - l.valor) > TOLERANCIA) {
    return {
      ...base,
      veredito: "valor",
      explicacao: `Shopify R$ ${l.valor.toFixed(2)} contra PagBank R$ ${c.pago.toFixed(2)}`,
    };
  }
  return { ...base, veredito: "ok" };
}

export async function conferirPagBank(
  dia: string,
): Promise<ConferenciaPagBank | null> {
  if (!temPagBank()) return null;

  const linhas = linhasDe(await pedidosPagosEm(dia));
  const nossas = linhas.filter((l) => ehPagBank(l.gateway) && l.referencia);
  const outras = linhas.filter((l) => !ehPagBank(l.gateway));

  const cobrancas = await cobrancasPorReferencia(
    nossas.map((l) => l.referencia as string),
  );

  const conferidas: Conferido[] = nossas.map((l) =>
    conferir(l, cobrancas.get(l.referencia as string) ?? null),
  );

  /* --- agregados --- */

  const porGateway = new Map<string, { pedidos: number; valor: number }>();
  for (const l of outras) {
    const a = porGateway.get(l.gateway) ?? { pedidos: 0, valor: 0 };
    a.pedidos += 1;
    a.valor += l.valor;
    porGateway.set(l.gateway, a);
  }

  const porParcela = new Map<number, { pedidos: number; valor: number }>();
  for (const c of conferidas) {
    const n = c.cobranca?.parcelas;
    if (!n) continue;
    const a = porParcela.get(n) ?? { pedidos: 0, valor: 0 };
    a.pedidos += 1;
    a.valor += c.cobranca?.pago ?? 0;
    porParcela.set(n, a);
  }

  return {
    conferidas: conferidas.length,
    valorConferido: conferidas.reduce((s, c) => s + c.valorShopify, 0),
    ok: conferidas.filter((c) => c.veredito === "ok").length,
    divergentes: conferidas.filter((c) => c.veredito !== "ok"),
    foraDoAlcance: [...porGateway.entries()]
      .map(([gateway, a]) => ({ gateway, ...a }))
      .sort((x, y) => y.valor - x.valor),
    parcelas: [...porParcela.entries()]
      .map(([parcelas, a]) => ({ parcelas, ...a }))
      .sort((x, y) => x.parcelas - y.parcelas),
    estornadoNoPagBank: conferidas.reduce(
      (s, c) => s + (c.cobranca?.estornado ?? 0),
      0,
    ),
  };
}
