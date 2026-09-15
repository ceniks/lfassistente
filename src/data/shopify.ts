import { config, exigir } from '../config.js';
import { categoria, norm, type PedidoClassificavel } from './classify.js';

/* ------------------------------------------------------------------ *
 * Cliente
 * ------------------------------------------------------------------ */

/**
 * Token de acesso da Admin API.
 *
 * A Shopify descontinuou os "custom apps" criados no admin, que davam um token
 * fixo. O caminho atual para um serviço que age sobre a própria loja é o
 * **client credentials grant**: troca-se Client ID + Client Secret por um token
 * que vale 24 horas.
 *
 * Isso é melhor do que parece. Um token fixo é um segredo que nunca expira e
 * vaza para sempre; este se renova sozinho e, se vazar, morre no dia seguinte.
 *
 * Renovamos com 5 minutos de folga para nunca usar um token no fio da navalha —
 * uma requisição que sai às 07:59:58 com token expirando às 08:00:00 falharia
 * justamente no momento do resumo.
 */
let tokenCache: { valor: string; expiraEm: number } | null = null;

async function accessToken(): Promise<string> {
  // Quem ainda tiver um custom app legado continua funcionando.
  const fixo = config().SHOPIFY_ADMIN_TOKEN;
  if (fixo) return fixo;

  if (tokenCache && Date.now() < tokenCache.expiraEm) return tokenCache.valor;

  const loja = exigir('SHOPIFY_SHOP');
  const res = await fetch(`https://${loja}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: exigir('SHOPIFY_CLIENT_ID'),
      client_secret: exigir('SHOPIFY_CLIENT_SECRET'),
    }),
  });

  if (!res.ok) {
    throw new Error(
      `Shopify recusou as credenciais (${res.status}): ${await res.text()}\n` +
        'Confira se o app está instalado na loja e se app e loja estão na mesma organização do Dev Dashboard.',
    );
  }

  const json = (await res.json()) as { access_token: string; expires_in: number };
  const margem = 300;
  tokenCache = {
    valor: json.access_token,
    expiraEm: Date.now() + (json.expires_in - margem) * 1000,
  };

  return tokenCache.valor;
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RespostaGraphQL<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
  extensions?: {
    cost?: {
      throttleStatus?: { currentlyAvailable: number; restoreRate: number; maximumAvailable: number };
    };
  };
}

/**
 * Saldo de pontos do balde da Shopify, atualizado a cada resposta.
 *
 * A Admin API não limita por número de requisições, e sim por custo: cada query
 * consome pontos de um balde que se reabastece por segundo. Guardar o saldo
 * conhecido permite pausar ANTES de levar o `THROTTLED`, em vez de errar e
 * tentar de novo.
 */
let saldo: { pontos: number; restaurePorSegundo: number; em: number } | null = null;

async function esperarSaldo(custoEstimado = 100): Promise<void> {
  if (!saldo) return;

  const decorrido = (Date.now() - saldo.em) / 1000;
  const disponivel = saldo.pontos + decorrido * saldo.restaurePorSegundo;

  if (disponivel >= custoEstimado) return;

  const faltam = custoEstimado - disponivel;
  await dormir(Math.ceil((faltam / saldo.restaurePorSegundo) * 1000) + 100);
}

async function admin<T>(
  query: string,
  variables: Record<string, unknown> = {},
  tentativa = 0,
): Promise<T> {
  const loja = exigir('SHOPIFY_SHOP');
  const token = await accessToken();
  const versao = config().SHOPIFY_API_VERSION;

  await esperarSaldo();

  const res = await fetch(`https://${loja}/admin/api/${versao}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });

  // 429 vem sem corpo útil; o throttle do GraphQL vem com 200 e erro no corpo.
  if (res.status === 429) {
    if (tentativa >= 5) throw new Error('Shopify: limite de requisições, 5 tentativas');
    await dormir(2000 * 2 ** tentativa);
    return admin<T>(query, variables, tentativa + 1);
  }

  if (!res.ok) {
    throw new Error(`Shopify ${res.status}: ${await res.text()}`);
  }

  const json = (await res.json()) as RespostaGraphQL<T>;

  const t = json.extensions?.cost?.throttleStatus;
  if (t) {
    saldo = { pontos: t.currentlyAvailable, restaurePorSegundo: t.restoreRate, em: Date.now() };
  }

  const throttled = json.errors?.some((e) => e.extensions?.code === 'THROTTLED');
  if (throttled) {
    if (tentativa >= 5) throw new Error('Shopify: limite de requisições, 5 tentativas');
    // Espera crescente: 2s, 4s, 8s… O balde restaura sozinho nesse intervalo.
    await dormir(2000 * 2 ** tentativa);
    return admin<T>(query, variables, tentativa + 1);
  }

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
  lineItems: {
    nodes: Array<{
      title: string;
      quantity: number;
      discountAllocations?: Array<{
        allocatedAmountSet: { shopMoney: { amount: string } };
        discountApplication?: { __typename?: string; code?: string | null } | null;
      }>;
    }>;
  };
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
        lineItems(first: 50) {
          nodes {
            title
            quantity
            discountAllocations {
              allocatedAmountSet { shopMoney { amount } }
              discountApplication {
                __typename
                ... on DiscountCodeApplication { code }
              }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/** Dias de folga para pedido criado num dia e pago em outro (Pix, boleto). */
const FOLGA_PAGAMENTO = 7;

/**
 * Busca os pedidos criados num intervalo, paginando.
 *
 * Esta é a única função que fala com a API de pedidos. Tudo o mais — um dia, uma
 * semana, a média — sai de agrupar o resultado dela em memória.
 *
 * O motivo é custo. A definição acordada é "pedido pago naquele dia", não
 * "criado naquele dia", e a busca do Shopify não expõe data de pagamento — então
 * é preciso varrer os pedidos criados numa janela maior e olhar a transação de
 * captura. Buscar essa janela separadamente para cada um dos 8 dias do resumo
 * multiplicava o trabalho por oito e derrubava a conta no limite de requisições.
 * Uma busca só, com o intervalo inteiro, resolve o mesmo problema.
 */
export async function pedidosCriadosEntre(de: string, ate: string): Promise<OrderNode[]> {
  const q = [
    `created_at:>=${de}T00:00:00-03:00`,
    `created_at:<=${ate}T23:59:59-03:00`,
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

  return pedidos;
}

/** Agrupa por dia de pagamento. Um pedido sem captura bem-sucedida fica de fora. */
export function agruparPorDiaDePagamento(pedidos: OrderNode[]): Map<string, OrderNode[]> {
  const porDia = new Map<string, OrderNode[]>();

  for (const p of pedidos) {
    const dia = diaDoPagamento(p);
    if (!dia) continue;
    const lista = porDia.get(dia);
    if (lista) lista.push(p);
    else porDia.set(dia, [p]);
  }

  return porDia;
}

/**
 * Busca e agrupa de uma vez os dias que o resumo precisa.
 *
 * `dias` são as datas de referência; a busca recua `FOLGA_PAGAMENTO` dias além
 * da mais antiga para pegar pedidos criados antes e pagos dentro do período.
 */
export async function vendasPorDia(dias: string[]): Promise<Map<string, ResumoVendas>> {
  const ordenados = [...dias].sort();
  const primeiro = ordenados[0];
  const ultimo = ordenados[ordenados.length - 1];

  const inicioBusca = new Date(`${primeiro}T12:00:00-03:00`);
  inicioBusca.setDate(inicioBusca.getDate() - FOLGA_PAGAMENTO);

  const pedidos = await pedidosCriadosEntre(inicioBusca.toISOString().slice(0, 10), ultimo);
  const porDia = agruparPorDiaDePagamento(pedidos);

  const saida = new Map<string, ResumoVendas>();
  for (const dia of dias) {
    saida.set(dia, agregar(porDia.get(dia) ?? [], dia));
  }
  return saida;
}

/** Mantido para uso avulso (o servidor MCP responde perguntas de um dia só). */
export async function pedidosPagosEm(dia: string): Promise<OrderNode[]> {
  const inicio = new Date(`${dia}T12:00:00-03:00`);
  inicio.setDate(inicio.getDate() - FOLGA_PAGAMENTO);

  const pedidos = await pedidosCriadosEntre(inicio.toISOString().slice(0, 10), dia);
  return pedidos.filter((p) => diaDoPagamento(p) === dia);
}

/** Data (São Paulo) da captura bem-sucedida, ou null se não houve. */
function diaDoPagamento(pedido: OrderNode): string | null {
  for (const t of pedido.transactions) {
    if (t.status !== 'SUCCESS') continue;
    if (t.kind !== 'SALE' && t.kind !== 'CAPTURE') continue;
    if (!t.processedAt) continue;
    return emSaoPaulo(t.processedAt);
  }
  return null;
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
 * Separa o desconto de um pedido entre cupom de venda e promoção do site.
 *
 * Existe porque a conta ingênua — "tem cupom? então todo o desconto é cupom" —
 * erra feio e sempre para o mesmo lado. A L&F quase sempre tem uma promoção
 * automática rodando, e a cliente ainda aplica um cupom de 5% por cima. No
 * pedido #138767 de 13/09, por exemplo, o desconto total foi R$ 232,39: R$
 * 199,90 do "Compre 2 Leve 3" e só R$ 32,49 do cupom. A regra antiga creditava
 * os R$ 232,39 inteiros ao cupom — sete vezes o valor real — e a linha de
 * promoção automática aparecia vazia.
 *
 * A quebra certa vem das alocações por item, que a Shopify já calcula e que
 * somam exatamente o desconto total do pedido.
 *
 * Cupom de troca não entra em lugar nenhum: é crédito de uma compra anterior,
 * não concessão de preço. Na prática o pedido inteiro já foi excluído antes de
 * chegar aqui, mas a regra fica explícita para o caso de um cupom de troca
 * aparecer sozinho num pedido de venda.
 */
export function quebraDeDesconto(pedido: OrderNode): {
  cupom: number;
  promocaoAutomatica: number;
} {
  const total = num(pedido.totalDiscountsSet);
  let cupom = 0;
  let promocao = 0;
  let alocado = 0;

  for (const item of pedido.lineItems.nodes) {
    for (const a of item.discountAllocations ?? []) {
      const valor = Number(a.allocatedAmountSet?.shopMoney.amount ?? 0);
      if (!valor) continue;
      alocado += valor;

      const app = a.discountApplication;
      const codigo = norm(app?.code ?? '');

      if (codigo.startsWith('troca')) continue; // crédito de troca, não desconto
      if (app?.__typename === 'DiscountCodeApplication') cupom += valor;
      else promocao += valor;
    }
  }

  // Sobra: desconto que não apareceu em nenhuma alocação de item — frete
  // descontado, por exemplo. Vai para promoção em vez de sumir, porque perder
  // dinheiro em silêncio é pior que classificá-lo de forma conservadora.
  const sobra = total - alocado;
  if (sobra > 0.01) promocao += sobra;

  return { cupom, promocaoAutomatica: promocao };
}

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

    const q = quebraDeDesconto(p);
    descontoCupom += q.cupom;
    descontoPromo += q.promocaoAutomatica;

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

/**
 * O ShopifyQL devolve `rows` como JSON — um array de objetos com as colunas
 * nomeadas, não um array de arrays posicional. Ler por nome é mais seguro de
 * qualquer forma: acrescentar uma métrica à consulta deixa de reordenar tudo.
 */
const SHOPIFYQL = `
  query ShopifyQL($query: String!) {
    shopifyqlQuery(query: $query) {
      parseErrors
      tableData {
        rows
        columns { name dataType }
      }
    }
  }
`;

interface RespostaShopifyQL {
  shopifyqlQuery: {
    parseErrors?: string[] | null;
    tableData?: { rows?: Array<Record<string, string>> | null } | null;
  };
}

export async function trafegoDoDia(dia: string): Promise<Trafego> {
  const q = `FROM sessions SHOW sessions, sessions_with_cart_additions, sessions_that_reached_checkout, sessions_that_completed_checkout SINCE ${dia} UNTIL ${dia}`;

  const data = await admin<RespostaShopifyQL>(SHOPIFYQL, { query: q });

  const erros = data.shopifyqlQuery.parseErrors;
  if (erros?.length) throw new Error(`ShopifyQL: ${erros.join('; ')}`);

  const linha = data.shopifyqlQuery.tableData?.rows?.[0] ?? {};
  const n = (chave: string) => Number(linha[chave] ?? 0);

  const sessoes = n('sessions');
  const adicoes = n('sessions_with_cart_additions');
  const iniciados = n('sessions_that_reached_checkout');
  const concluidos = n('sessions_that_completed_checkout');

  return {
    sessoes,
    adicoesAoCarrinho: adicoes,
    taxaAdicao: sessoes > 0 ? adicoes / sessoes : 0,
    checkoutsIniciados: iniciados,
    checkoutsConcluidos: concluidos,
    conversao: sessoes > 0 ? concluidos / sessoes : 0,
  };
}
