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
      variant?: { price?: string | null } | null;
      discountAllocations?: Array<{
        allocatedAmountSet: { shopMoney: { amount: string } };
        discountApplication?: { __typename?: string; code?: string | null } | null;
      }>;
    }>;
  };
}

/** Um cupom de venda no ranking do dia. */
export interface CupomUsado {
  codigo: string;
  pedidos: number;
  valor: number;
}

/** Uma categoria de produto no recorte do dia. */
export interface CategoriaVendida {
  categoria: string;
  pecas: number;
  receita: number;
  /** Fração das peças do dia. */
  participacao: number;
}

/**
 * As trocas do dia, que saem do faturamento mas precisam ser vistas.
 *
 * Duas mecânicas distintas, e misturá-las esconde o que cada uma custa:
 *
 *  - **cupom**: a cliente recebeu um código TROCA##### e o usou numa compra
 *    nova. O valor é o que o cupom abateu.
 *  - **direta**: o TroqueCommerce cria o pedido com a peça a R$ 0,01, então o
 *    valor cobrado não diz nada. O que interessa é quanto aquela peça valeria
 *    na loja — por isso o cálculo usa o preço da variante.
 */
export interface TrocasDoDia {
  total: number;
  porCupom: { pedidos: number; valor: number };
  direta: { pedidos: number; pecas: number; valorAPrecoDeSite: number };
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
  cuponsMaisUsados: CupomUsado[];
  categorias: CategoriaVendida[];
  trocasDoDia: TrocasDoDia;
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
            variant { price }
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
    // As aspas não são estilo: sem elas a busca da Shopify trata o "-03:00" do
    // fuso como operador de negação e engole pedidos em silêncio. Medido em
    // 14/09/2026: 146 pedidos sem aspas contra 147 com aspas — o #139013
    // simplesmente não voltava. Errar para menos no faturamento, sem erro
    // nenhum aparecendo, é o pior defeito possível neste arquivo.
    `created_at:>='${de}T00:00:00-03:00'`,
    `created_at:<='${ate}T23:59:59-03:00'`,
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
 * A categoria de um produto, tirada da primeira palavra do título.
 *
 * Parece frágil e é a opção mais robusta que a loja oferece hoje. O
 * `productType` está vazio em todos os produtos. A taxonomia da Shopify
 * (`category`) vem em inglês e se contradiz: "Blazer Filadélfia" é *Sport
 * Jackets* e "Blazer Alemanha" é *Blazers*; "Casaco Roma" é *Outerwear* e
 * "Casaco Londres" é *Wrap Coats*. As coleções têm os nomes certos em português
 * mas cada produto está em cinco delas ao mesmo tempo — "Home page",
 * "Best-Sellers", "Roupas", "Lançamentos", "Influencers" — e separar a
 * categoria do merchandising exigiria uma lista de exceções para manter à mão.
 *
 * A nomenclatura da L&F, por outro lado, é impecável: "Calça Londres",
 * "Blazer Alemanha", "Casaco Roma". A primeira palavra bate 1 para 1 com as
 * coleções de categoria e não custa nenhuma chamada extra à API.
 */
export function categoriaDoProduto(titulo: string): string {
  const primeira = titulo.trim().split(/\s+/)[0] ?? '';
  if (!primeira) return 'Sem categoria';
  return primeira.charAt(0).toUpperCase() + primeira.slice(1).toLowerCase();
}

/**
 * Quanto a peça vale na loja, não quanto o pedido cobrou por ela.
 *
 * Existe por causa da troca direta: o TroqueCommerce cria o pedido com a peça a
 * R$ 0,01, então somar `totalPrice` daria três centavos para uma troca de R$
 * 650. O preço da variante é o que a mesma peça custaria para uma cliente
 * comprando normalmente — é essa a medida do que a troca representou.
 */
function valorAPrecoDeSite(item: {
  quantity: number;
  variant?: { price?: string | null } | null;
}): number {
  return Number(item.variant?.price ?? 0) * item.quantity;
}

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
  const porCategoria = new Map<string, { pecas: number; receita: number }>();
  const porCupom = new Map<string, { pedidos: number; valor: number }>();

  const troca = {
    total: 0,
    porCupom: { pedidos: 0, valor: 0 },
    direta: { pedidos: 0, pecas: 0, valorAPrecoDeSite: 0 },
  };

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
      troca.total++;

      // Pedido criado pelo app do TroqueCommerce é troca direta: peça trocada
      // por peça, sem cupom no meio. Qualquer outro pedido que caiu aqui veio
      // por um cupom TROCA aplicado numa compra na loja.
      if (norm(p.app?.name ?? '').includes('troque')) {
        troca.direta.pedidos++;
        for (const item of p.lineItems.nodes) {
          troca.direta.pecas += item.quantity;
          troca.direta.valorAPrecoDeSite += valorAPrecoDeSite(item);
        }
      } else {
        troca.porCupom.pedidos++;
        for (const item of p.lineItems.nodes) {
          for (const a of item.discountAllocations ?? []) {
            if (norm(a.discountApplication?.code ?? '').startsWith('troca')) {
              troca.porCupom.valor += Number(a.allocatedAmountSet?.shopMoney.amount ?? 0);
            }
          }
        }
      }
      continue;
    }

    contagem++;
    const total = num(p.totalPriceSet);
    receita += total;

    const q = quebraDeDesconto(p);
    descontoCupom += q.cupom;
    descontoPromo += q.promocaoAutomatica;

    // Ranking de cupons: um pedido conta uma vez por código, mesmo que o cupom
    // tenha sido rateado entre vários itens.
    const cuponsDoPedido = new Map<string, number>();
    for (const item of p.lineItems.nodes) {
      for (const a of item.discountAllocations ?? []) {
        const app = a.discountApplication;
        if (app?.__typename !== 'DiscountCodeApplication') continue;
        const codigo = (app.code ?? '').trim();
        if (!codigo || norm(codigo).startsWith('troca')) continue;
        const valor = Number(a.allocatedAmountSet?.shopMoney.amount ?? 0);
        cuponsDoPedido.set(codigo, (cuponsDoPedido.get(codigo) ?? 0) + valor);
      }
    }
    for (const [codigo, valor] of cuponsDoPedido) {
      const atual = porCupom.get(codigo) ?? { pedidos: 0, valor: 0 };
      atual.pedidos++;
      atual.valor += valor;
      porCupom.set(codigo, atual);
    }

    const itensDoPedido = p.lineItems.nodes.reduce((s, i) => s + i.quantity, 0);
    pecas += itensDoPedido;

    for (const item of p.lineItems.nodes) {
      const atual = porProduto.get(item.title) ?? { pecas: 0, receita: 0 };
      atual.pecas += item.quantity;
      // Rateia a receita do pedido entre as peças, para que um produto vendido
      // dentro de uma promoção não apareça com o preço cheio.
      const rateio = itensDoPedido > 0 ? (total * item.quantity) / itensDoPedido : 0;
      atual.receita += rateio;
      porProduto.set(item.title, atual);

      const nomeCat = categoriaDoProduto(item.title);
      const cate = porCategoria.get(nomeCat) ?? { pecas: 0, receita: 0 };
      cate.pecas += item.quantity;
      cate.receita += rateio;
      porCategoria.set(nomeCat, cate);
    }
  }

  const topProdutos = [...porProduto.entries()]
    .map(([titulo, v]) => ({ titulo, ...v }))
    .sort((a, b) => b.pecas - a.pecas)
    .slice(0, 10);

  const categorias = [...porCategoria.entries()]
    .map(([categoria, v]) => ({
      categoria,
      ...v,
      participacao: pecas > 0 ? v.pecas / pecas : 0,
    }))
    .sort((a, b) => b.pecas - a.pecas);

  const cuponsMaisUsados = [...porCupom.entries()]
    .map(([codigo, v]) => ({ codigo, ...v }))
    .sort((a, b) => b.pedidos - a.pedidos || b.valor - a.valor)
    .slice(0, 3);

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
    cuponsMaisUsados,
    categorias,
    trocasDoDia: troca,
    topProdutos,
  };
}

/* ------------------------------------------------------------------ *
 * Estornos
 * ------------------------------------------------------------------ */

export interface Estorno {
  pedido: string;
  /** Reembolso liquidado: o dinheiro saiu. */
  valor: number;
  /**
   * Reembolso emitido e ainda não liquidado pelo adquirente.
   *
   * Não é detalhe contábil. O #130087 de 14/09 tem um reembolso de R$ 593,87
   * com a transação `PENDING` no PagBank: para quem olha o painel, o pedido
   * "foi reembolsado"; para a API, `totalRefunded` é R$ 0,00 e o pedido segue
   * como PAID. Tratar isso como "não houve reembolso" produz divergência falsa.
   */
  pendente: number;
  /** Momento do reembolso, em ISO. */
  em: string;
}

export interface EstornosDoDia {
  quantidade: number;
  valor: number;
  pendente: number;
  lista: Estorno[];
}

const REFUNDS_QUERY = `
  query Reembolsos($q: String!, $cursor: String) {
    orders(first: 100, query: $q, after: $cursor, sortKey: UPDATED_AT) {
      nodes {
        name
        refunds(first: 20) {
          createdAt
          transactions(first: 10) {
            nodes {
              kind
              status
              amountSet { shopMoney { amount } }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/**
 * Os reembolsos processados num dia, do lado da Shopify.
 *
 * A busca é por `updated_at` e não por data do reembolso: a Shopify não expõe
 * filtro por data de refund, mas todo reembolso atualiza o pedido. A janela
 * abre alguns dias antes porque um pedido pode ser reembolsado e voltar a ser
 * mexido depois — o recorte fino fica no filtro em memória, sobre o
 * `createdAt` de cada refund.
 *
 * Serve para bater com o TroqueCommerce: a reversa lá pode estar "finalizada"
 * enquanto o dinheiro não saiu daqui, e essa diferença é justamente o que
 * ninguém enxerga sem comparar os dois lados.
 */
export async function estornosDoDia(dia: string): Promise<EstornosDoDia> {
  const lista = await estornosEntre(dia, dia, 3);
  return {
    quantidade: lista.length,
    valor: lista.reduce((s, e) => s + e.valor, 0),
    pendente: lista.reduce((s, e) => s + e.pendente, 0),
    lista,
  };
}

/**
 * Reembolsos num intervalo de datas.
 *
 * `folga` é quantos dias antes do início a busca abre: um pedido reembolsado no
 * dia 10 e mexido de novo no 12 só aparece numa busca por `updated_at` que
 * alcance o 12. Abrir demais custa páginas à toa, abrir de menos perde
 * reembolso — três dias cobre o comportamento normal da loja.
 */
export async function estornosEntre(
  de: string,
  ate: string,
  folga = 3,
): Promise<Estorno[]> {
  const inicio = new Date(`${de}T12:00:00-03:00`);
  inicio.setDate(inicio.getDate() - folga);

  // Sem teto na janela, e isso não é descuido.
  //
  // A busca é por `updated_at` porque a Shopify não filtra por data de refund.
  // Um pedido reembolsado no dia 14 e mexido de novo no 15 tem `updated_at` no
  // dia 15 e desaparece de uma janela que termina no 14 — foi exatamente o que
  // aconteceu com o #135727. O recorte por data do reembolso é feito em
  // memória, então deixar a janela correr até hoje só custa páginas.
  //
  // Também não dá para filtrar por `financial_status`: reembolso com transação
  // pendente deixa o pedido como PAID, e o filtro o esconderia justamente no
  // caso que mais confunde.
  const q = [
    `updated_at:>='${inicio.toISOString().slice(0, 10)}T00:00:00-03:00'`,
  ].join(' ');

  interface Node {
    name: string;
    refunds: Array<{
      createdAt: string;
      transactions?: {
        nodes: Array<{
          kind: string;
          status: string;
          amountSet: { shopMoney: { amount: string } } | null;
        }>;
      } | null;
    }>;
  }
  interface Pagina {
    orders: { nodes: Node[]; pageInfo: { hasNextPage: boolean; endCursor: string } };
  }

  const lista: Estorno[] = [];
  let cursor: string | null = null;
  const MAX_PAGINAS = 200;
  let acabou = false;

  for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
    const d: Pagina = await admin<Pagina>(REFUNDS_QUERY, { q, cursor });
    for (const pedido of d.orders.nodes) {
      for (const r of pedido.refunds ?? []) {
        const diaDoRefund = emSaoPaulo(r.createdAt);
        if (diaDoRefund < de || diaDoRefund > ate) continue;

        // O valor sai das transações, não de `totalRefundedSet`: aquele campo
        // conta só o que o adquirente liquidou, e zera um reembolso emitido que
        // ainda está pendente.
        let liquidado = 0;
        let pendente = 0;
        for (const tr of r.transactions?.nodes ?? []) {
          if (tr.kind !== 'REFUND') continue;
          const v = Number(tr.amountSet?.shopMoney.amount ?? 0);
          if (tr.status === 'SUCCESS') liquidado += v;
          else if (tr.status === 'PENDING') pendente += v;
        }

        if (!liquidado && !pendente) continue;
        lista.push({ pedido: pedido.name, valor: liquidado, pendente, em: r.createdAt });
      }
    }
    if (!d.orders.pageInfo.hasNextPage) {
      acabou = true;
      break;
    }
    cursor = d.orders.pageInfo.endCursor;
  }

  // Estourar o limite e devolver o que deu não serve aqui: a lista alimenta uma
  // conferência contra o Troquecommerce, e faltar reembolso vira divergência
  // inventada. Melhor falhar alto.
  if (!acabou) {
    throw new Error(
      `Shopify: mais de ${MAX_PAGINAS} páginas de reembolso entre ${de} e ${ate}. ` +
        'Reduza o intervalo — devolver uma lista parcial produziria divergências falsas.',
    );
  }

  lista.sort((a, b) => b.valor + b.pendente - (a.valor + a.pendente));
  return lista;
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
