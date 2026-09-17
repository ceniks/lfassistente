/**
 * Confere o dinheiro do dia entre a Shopify e o PagBank, nos dois sentidos, e
 * lê a taxa que o gateway realmente cobrou.
 *
 * A conferência usa a API antiga (`transacoesDoDia`), que lista por data. Isso
 * é o que permite olhar para os dois lados:
 *
 *  - pedido pago na Shopify sem cobrança no PagBank → dinheiro que a loja
 *    contou e o gateway não viu;
 *  - cobrança no PagBank sem pedido na Shopify → dinheiro que entrou e a loja
 *    não registrou. Esse lado era cego enquanto só existia a API nova.
 *
 * A chave dos dois lados é a mesma string: a Shopify chama de `payment_id`, o
 * PagBank de `reference`. Por isso a conferência é uma a uma, não soma contra
 * soma — e em 16/09 os dois lados fecharam em R$ 64.486,97, ao centavo.
 *
 * Sobre a taxa: ela **não é única**. O `feeAmount` de cada transação mostra
 * 3,12% à vista subindo até 7,38% em 8x, média de 5,93% no dia. O número que
 * entra na margem é a soma dos `feeAmount`, não uma alíquota aplicada — não há
 * mais estimativa nenhuma para o PagBank.
 *
 * O que continua estimado é o Mercado Pago, que tem credencial própria e não é
 * consultado aqui. Ele aparece à parte para ninguém ler a diferença como
 * divergência.
 */
import { pedidosPagosEm, type OrderNode } from "./shopify.js";
import { pagamentosDoDia, temMercadoPago } from "./mercadopago.js";
import {
  cobrancasPorReferencia,
  temPagBank,
  transacoesDoDia,
  type Cobranca,
  type TransacaoPagBank,
} from "./pagbank.js";

/** Centavos de arredondamento que não valem uma linha de divergência. */
export const TOLERANCIA = 0.01;

export type Veredito = "ok" | "ausente" | "status" | "valor";

export interface Conferido {
  pedido: string;
  referencia: string;
  gateway: string;
  valorShopify: number;
  transacao: TransacaoPagBank | null;
  veredito: Veredito;
  /** Frase pronta para o relatório, só nas divergências. */
  explicacao?: string;
}

export interface OrfaNoPagBank {
  referencia: string;
  codigo: string;
  bruto: number;
  data: string;
}

export interface ConferenciaPagBank {
  /** Como o gateway se chama no relatório. */
  nome: string;
  conferidas: number;
  valorConferido: number;
  ok: number;
  divergentes: Conferido[];
  /** Cobrança no PagBank sem pedido correspondente na Shopify. */
  orfas: OrfaNoPagBank[];
  /** Taxa cobrada de verdade, somada transação a transação. */
  taxaReal: number;
  /** Alíquota média resultante — consequência, não premissa. */
  taxaRealPct: number;
  foraDoAlcance: Array<{ gateway: string; pedidos: number; valor: number }>;
  parcelas: Array<{
    parcelas: number;
    pedidos: number;
    valor: number;
    taxa: number;
  }>;
  canceladas: { quantidade: number; valor: number };
}

const ehPagBank = (g: string) => /pagbank|pagseguro/i.test(g);

export interface Linha {
  pedido: string;
  gateway: string;
  referencia: string | null;
  valor: number;
}

/** Transações de venda bem-sucedidas na Shopify, uma linha por captura. */
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
 * O julgamento de uma transação.
 *
 * Separado da busca porque é aqui que mora a regra e é isto que precisa de
 * teste. `null` significa "o PagBank não tem essa cobrança" — nunca "a consulta
 * falhou": falha de rede sobe como exceção em `pagbank.ts` e não chega aqui.
 * Confundir as duas transformaria um soluço do gateway em divergência
 * inventada, todo dia.
 */
export function conferir(l: Linha, t: TransacaoPagBank | null): Conferido {
  const base = {
    pedido: l.pedido,
    referencia: l.referencia as string,
    gateway: l.gateway,
    valorShopify: l.valor,
    transacao: t,
  };

  if (!t) {
    return {
      ...base,
      veredito: "ausente",
      explicacao: "a Shopify deu como pago e o PagBank não tem essa cobrança",
    };
  }
  if (!t.valeComoVenda) {
    return {
      ...base,
      veredito: "status",
      explicacao: "pago na Shopify, mas cancelado ou devolvido no PagBank",
    };
  }
  if (Math.abs(t.bruto - l.valor) > TOLERANCIA) {
    return {
      ...base,
      veredito: "valor",
      explicacao: `Shopify R$ ${l.valor.toFixed(2)} contra PagBank R$ ${t.bruto.toFixed(2)}`,
    };
  }
  return { ...base, veredito: "ok" };
}

/**
 * A conferência em si, com as duas listas já carregadas.
 *
 * Separada da busca porque PagBank e Mercado Pago são exatamente o mesmo
 * problema: os dois amarram pelo identificador que a Shopify grava na
 * transação — `payment_id` de um lado, `reference` ou `external_reference` do
 * outro. Escrever duas versões garantiria que elas divergissem com o tempo.
 */
export function conferirContra(
  nome: string,
  pedidos: OrderNode[],
  transacoes: TransacaoPagBank[],
  ehDesteGateway: (g: string) => boolean,
): ConferenciaPagBank {
  const linhas = linhasDe(pedidos);
  const nossas = linhas.filter(
    (l) => ehDesteGateway(l.gateway) && l.referencia,
  );
  const outras = linhas.filter((l) => !ehDesteGateway(l.gateway));

  const porReferencia = new Map(transacoes.map((t) => [t.referencia, t]));
  const conferidas = nossas.map((l) =>
    conferir(l, porReferencia.get(l.referencia as string) ?? null),
  );

  /* --- o lado que antes era cego: cobrança sem pedido --- */

  const apontadas = new Set(nossas.map((l) => l.referencia as string));
  const orfas = transacoes
    .filter(
      (t) => t.valeComoVenda && t.bruto > 0 && !apontadas.has(t.referencia),
    )
    .map((t) => ({
      referencia: t.referencia,
      codigo: t.codigo,
      bruto: t.bruto,
      data: t.data,
    }))
    .sort((a, b) => b.bruto - a.bruto);

  const canceladas = transacoes.filter((t) => !t.valeComoVenda);

  /* --- taxa real: soma do que foi cobrado, não alíquota aplicada --- */

  const casadas = conferidas.filter((c) => c.veredito === "ok" && c.transacao);
  const valorConferido = casadas.reduce((s, c) => s + c.valorShopify, 0);
  const taxaReal = casadas.reduce((s, c) => s + (c.transacao?.taxa ?? 0), 0);

  const porGateway = new Map<string, { pedidos: number; valor: number }>();
  for (const l of outras) {
    const a = porGateway.get(l.gateway) ?? { pedidos: 0, valor: 0 };
    a.pedidos += 1;
    a.valor += l.valor;
    porGateway.set(l.gateway, a);
  }

  return {
    nome,
    conferidas: conferidas.length,
    valorConferido,
    ok: casadas.length,
    divergentes: conferidas.filter((c) => c.veredito !== "ok"),
    orfas,
    taxaReal,
    taxaRealPct: valorConferido > 0 ? taxaReal / valorConferido : 0,
    foraDoAlcance: [...porGateway.entries()]
      .map(([gateway, a]) => ({ gateway, ...a }))
      .sort((x, y) => y.valor - x.valor),
    parcelas: [],
    canceladas: {
      quantidade: canceladas.length,
      valor: canceladas.reduce((s, t) => s + t.bruto, 0),
    },
  };
}

/** Conferência do PagBank, incluindo o parcelamento, que só a API nova informa. */
export async function conferirPagBank(
  dia: string,
): Promise<ConferenciaPagBank | null> {
  if (!temPagBank()) return null;

  const [pedidos, transacoes] = await Promise.all([
    pedidosPagosEm(dia),
    transacoesDoDia(dia),
  ]);
  const base = conferirContra("PagBank", pedidos, transacoes, ehPagBank);

  /*
   * O número de parcelas não existe nem na Shopify nem na listagem por data —
   * só na API nova, uma consulta por cobrança. Vale o custo: não muda a
   * margem, mas é o que diz quando o dinheiro entra.
   */
  const porTransacao = new Map(transacoes.map((t) => [t.referencia, t]));
  const cobrancas = await cobrancasPorReferencia(
    linhasDe(pedidos)
      .filter((l) => ehPagBank(l.gateway) && l.referencia)
      .map((l) => l.referencia as string),
  );

  const porParcela = new Map<
    number,
    { pedidos: number; valor: number; taxa: number }
  >();
  for (const [ref, c] of cobrancas) {
    const n = (c as Cobranca | null)?.parcelas;
    const t = porTransacao.get(ref);
    if (!n || !t?.valeComoVenda) continue;
    const a = porParcela.get(n) ?? { pedidos: 0, valor: 0, taxa: 0 };
    a.pedidos += 1;
    a.valor += t.bruto;
    a.taxa += t.taxa;
    porParcela.set(n, a);
  }

  return {
    ...base,
    parcelas: [...porParcela.entries()]
      .map(([parcelas, a]) => ({ parcelas, ...a }))
      .sort((x, y) => x.parcelas - y.parcelas),
  };
}

/** Mesma conferência, no gateway do Pix. */
export async function conferirMercadoPago(
  dia: string,
): Promise<ConferenciaPagBank | null> {
  if (!temMercadoPago()) return null;

  const [pedidos, pagamentos] = await Promise.all([
    pedidosPagosEm(dia),
    pagamentosDoDia(dia),
  ]);
  return conferirContra("Mercado Pago", pedidos, pagamentos, (g) =>
    /mercado\s*pago/i.test(g),
  );
}
