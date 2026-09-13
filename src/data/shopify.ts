import { config, exigir } from '../config.js';
import { categoria, type PedidoClassificavel } from './classify.js';

/* ------------------------------------------------------------------ *
 * Cliente
 * ------------------------------------------------------------------ */

async function admin<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const loja = exigir('SHOPIFY_SHOP');
  const token = exigir('SHOPIFY_ADMIN_TOKEN');
  const versao = config().SHOPIFY_API_VERSION;

  const res = await fetch(
    `https://${loja}/admin/api/${versao}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({ query, variables }),
    },
  );

  if (!res.ok) {
    throw new Error(`Shopify ${res.status}: ${await res.text()}`);
  }

  const json = (await res.json()) as { data?: T; errors?: unknown[] };
  if (json.errors?.length) {
    throw new Error(`Shopify GraphQL: ${JSON.stringify(json.errors)}`);
  }
  if (!json.data) throw new Error('Shopify devolveu resposta sem data');
  return json.data;
}

/* ------------------------------------------------------------------ *
 * Tipos
 * ------------------------------------------------------------------ */

interface OrderNode extends PedidoClassificavel {
  id: string;
  createdAt: string;
  totalPriceSet: { shopMoney: { amount: string } };
  subtotalPriceSet: { shopMoney: { amount: string } } | null;
  totalDiscountsSet: { shopMoney: { amount: string } } | null;
  transactions: Array<{ processedAt: string | null; kind: string; status: string }>;
  lineItems: { nodes: Array<{ title: string; quantity: number }> };
}

export interface ResumoVendas {
  data: string;
  pedidos: number;
  receita: number;
  ticketMedio: number;
  pecas: number;
  pecasPorPedido: number;
  desconto: {
    total: number;
    cupom: number;
    promocaoAutomatica: number;
    seedingInfluencer: number;
  };
  excluidos: { trocas: number; influencers: number };
  topProdutos: Array<{ titulo: string; pecas: number; receita: number }>;
}

/* ------------------------------------------------------------------ *
 * Pedidos pagos do dia
 * ------------------------------------------------------------------ */

const ORDERS_QUERY = `
  query PedidosDoDia($q: String!, $cursor: String) {
    orders(first: 50, query: $q, after: $cursor, sortKey: CREATED_AT) {
      nodes {
        id
        name
        createdAt
        tags
        discountCodes
        app { name }
        totalPriceSet { shopMoney { amount } }
        subtotalPriceSet { shopMoney { amount } }
        totalDiscountsSet { shopMoney { amount } }
        transactions(first: 10) { processedAt kind status }
        lineItems(first: 50) { nodes { title quantity } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/**
 * Busca os pedidos cujo pagamento foi confirmado em `dia` (YYYY-MM-DD).
 *
 * Por que a janela de 7 dias para trás: a definição acordada é "pedido pago
 * naquele dia", não "pedido criado naquele dia". Com Pix e boleto, um pedido
 * criado na terça pode ser pago na quinta — e é na quinta que ele conta. A
 * busca do Shopify não expõe data de pagamento, então varremos os pedidos
 * criados na janela e filtramos pela transação de captura.
 *
 * Sete dias cobre boleto com folga. Pedidos pagos mais de uma semana depois de
 * criados são raros o bastante para não valerem o custo de varrer mais.
 */
export async function pedidosPagosEm(dia: string): Promise<OrderNode[]> {
  const inicio = new Date(`${dia}T00:00:00-03:00`);
  const janela = new Date(inicio);
  janela.setDate(janela.getDate() - 7);

  const q = [
    `created_at:>=${janela.toISOString().slice(0, 10)}`,
    `created_at:<=${dia}T23:59:59-03:00`,
    'financial_status:paid',
  ].join(' ');

  interface Pagina {
    orders: { nodes: OrderNode[]; pageInfo: { hasNextPage: boolean; endCursor: string } };
  }

  const pedidos: OrderNode[] = [];
  let cursor: string | null = null;

  do {
    const data: Pagina = await admin<Pagina>(ORDERS_QUERY, { q, cursor });
    pedidos.push(...data.orders.nodes);
    cursor = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
  } while (cursor);

  return pedidos.filter((p) => pagouEm(p, dia));
}

/** Houve captura bem-sucedida na data? */
function pagouEm(pedido: OrderNode, dia: string): boolean {
  return pedido.transactions.some((t) => {
    if (t.status !== 'SUCCESS') return false;
    if (t.kind !== 'SALE' && t.kind !== 'CAPTURE') return false;
    if (!t.processedAt) return false;
    return emSaoPaulo(t.processedAt) === dia;
  });
}

function emSaoPaulo(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

/* ------------------------------------------------------------------ *
 * Agregação
 * ------------------------------------------------------------------ */

const num = (v?: { shopMoney: { amount: string } } | null) => Number(v?.shopMoney.amount ?? 0);

/**
 * Consolida os pedidos do dia num único objeto.
 *
 * Tudo — faturamento, ticket, desconto e top de produtos — sai de um loop só.
 * O ranking de produtos por peça, que parecia pedir uma consulta extra, é
 * apenas um acumulador dentro deste mesmo laço.
 */
export function agregar(pedidos: OrderNode[], dia: string): ResumoVendas {
  let receita = 0;
  let pecas = 0;
  let contagem = 0;
  let descontoCupom = 0;
  let descontoPromo = 0;
  let seeding = 0;
  let trocas = 0;
  let influencers = 0;

  const porProduto = new Map<string, { pecas: number; receita: number }>();

  for (const p of pedidos) {
    const cat = categoria(p);

    if (cat === 'influencer') {
      influencers++;
      // Seeding sai a R$ 0, então não mexe na receita. Mas carrega de R$ 680 a
      // R$ 960 de desconto por pedido, e isso NÃO é concessão de preço — é
      // custo de mídia. Por isso vai em linha própria no resumo.
      seeding += num(p.totalDiscountsSet);
      continue;
    }

    if (cat === 'troca') {
      trocas++;
      continue;
    }

    contagem++;
    const total = num(p.totalPriceSet);
    receita += total;

    const desconto = num(p.totalDiscountsSet);
    if (p.discountCodes.length > 0) descontoCupom += desconto;
    else descontoPromo += desconto;

    const itensDoPedido = p.lineItems.nodes.reduce((s, i) => s + i.quantity, 0);
    pecas += itensDoPedido;

    for (const item of p.lineItems.nodes) {
      const atual = porProduto.get(item.title) ?? { pecas: 0, receita: 0 };
      atual.pecas += item.quantity;
      // Rateia a receita do pedido entre as peças, para que um produto vendido
      // dentro de uma promoção não apareça com o preço cheio.
      atual.receita += itensDoPedido > 0 ? (total * item.quantity) / itensDoPedido : 0;
      porProduto.set(item.title, atual);
    }
  }

  const topProdutos = [...porProduto.entries()]
    .map(([titulo, v]) => ({ titulo, ...v }))
    .sort((a, b) => b.pecas - a.pecas)
    .slice(0, 5);

  return {
    data: dia,
    pedidos: contagem,
    receita,
    ticketMedio: contagem > 0 ? receita / contagem : 0,
    pecas,
    pecasPorPedido: contagem > 0 ? pecas / contagem : 0,
    desconto: {
      total: descontoCupom + descontoPromo,
      cupom: descontoCupom,
      promocaoAutomatica: descontoPromo,
      seedingInfluencer: seeding,
    },
    excluidos: { trocas, influencers },
    topProdutos,
  };
}

export async function vendasDoDia(dia: string): Promise<ResumoVendas> {
  return agregar(await pedidosPagosEm(dia), dia);
}

/* ------------------------------------------------------------------ *
 * Tráfego (ShopifyQL)
 * ------------------------------------------------------------------ */

export interface Trafego {
  sessoes: number;
  adicoesAoCarrinho: number;
  taxaAdicao: number;
  checkoutsIniciados: number;
  checkoutsConcluidos: number;
  /**
   * Conversão nativa: sessões que concluíram checkout ÷ sessões.
   *
   * Já exclui troca e influencer por natureza — esses pedidos são criados fora
   * da loja online e nunca passam por sessão nem checkout. Não precisa de
   * filtro adicional.
   */
  conversao: number;
}

const SHOPIFYQL = `
  query ShopifyQL($query: String!) {
    shopifyqlQuery(query: $query) {
      __typename
      ... on TableResponse {
        tableData { rowData columns { name dataType } }
      }
      parseErrors { code message }
    }
  }
`;

export async function trafegoDoDia(dia: string): Promise<Trafego> {
  const q = `FROM sessions SHOW sessions, sessions_with_cart_additions, sessions_that_reached_checkout, sessions_that_completed_checkout SINCE ${dia} UNTIL ${dia}`;

  const data = await admin<{
    shopifyqlQuery: {
      tableData?: { rowData: string[][] };
      parseErrors?: Array<{ message: string }>;
    };
  }>(SHOPIFYQL, { query: q });

  const erros = data.shopifyqlQuery.parseErrors;
  if (erros?.length) throw new Error(`ShopifyQL: ${erros.map((e) => e.message).join('; ')}`);

  const linha = data.shopifyqlQuery.tableData?.rowData?.[0] ?? [];
  const [sessoes = 0, adicoes = 0, iniciados = 0, concluidos = 0] = linha.map(Number);

  return {
    sessoes,
    adicoesAoCarrinho: adicoes,
    taxaAdicao: sessoes > 0 ? adicoes / sessoes : 0,
    checkoutsIniciados: iniciados,
    checkoutsConcluidos: concluidos,
    conversao: sessoes > 0 ? concluidos / sessoes : 0,
  };
}
