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
      requestedQueryCost?: number;
      actualQueryCost?: number;
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

/**
 * Custo real da última execução de cada consulta.
 *
 * O balde da Shopify admite a requisição pelo custo *pedido*, calculado a
 * partir dos `first` do documento — não pelo que volta. Assumir 100 pontos
 * para uma consulta que pede 800 fazia o cliente disparar sem saldo, levar
 * THROTTLED e dormir 2s, 4s, 8s a cada página. Guardar o custo medido e
 * esperar por ele antes de chamar troca esse pingue-pongue por uma espera só.
 */
const custoConhecido = new Map<string, number>();

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

  await esperarSaldo(custoConhecido.get(query) ?? 100);

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

  const custo = json.extensions?.cost?.requestedQueryCost;
  if (typeof custo === 'number') {
    custoConhecido.set(query, custo);
    if (process.env.DEBUG_SHOPIFY_CUSTO) {
      console.error(
        `[shopify] pedido ${custo} · real ${json.extensions?.cost?.actualQueryCost ?? '?'} · ` +
          `saldo ${json.extensions?.cost?.throttleStatus?.currentlyAvailable ?? '?'}`,
      );
    }
  }

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
  cancelledAt: string | null;
  displayFinancialStatus: string | null;
  totalPriceSet: { shopMoney: { amount: string } };
  subtotalPriceSet: { shopMoney: { amount: string } } | null;
  totalDiscountsSet: { shopMoney: { amount: string } } | null;
  transactions: Array<{ processedAt: string | null; kind: string; status: string }>;
  lineItems: {
    nodes: Array<{
      title: string;
      quantity: number;
      variant?: { price?: string | null } | null;
      product?: { id?: string | null } | null;
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
  excluidos: { trocas: number; influencers: number; reenvios: number };
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
        cancelledAt
        displayFinancialStatus
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
            product { id }
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
    // Sem filtro de pagamento de propósito. O faturamento continua saindo só
    // dos pagos — quem separa é `diaDoPagamento`, que exige captura. Mas a
    // cobertura de estoque precisa de todo pedido: peça de um Pix ainda não
    // compensado já saiu da prateleira, e esperar a compensação para contar
    // demanda atrasa justamente o alerta de ruptura.
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
/**
 * Quanto cada produto tirou do estoque no período, para calcular cobertura.
 *
 * Conta **todo pedido criado na janela**: pago, pendente de Pix, troca, seeding
 * de influencer, reenvio. Nenhum deles é receita do dia, mas todos tiram peça
 * da prateleira — e cobertura é sobre peça, não sobre dinheiro. Só o pedido
 * cancelado fica de fora, porque a peça volta.
 */
export interface UnidadesDeProduto {
  titulo: string;
  produtoId: string | null;
  /** Unidades no período inteiro. */
  unidades: number;
  /** Só as dos últimos 7 dias da janela, para comparar com a média longa. */
  unidades7d: number;
}

export interface PeriodoDeVendas {
  porDia: Map<string, ResumoVendas>;
  /** Chave: título do produto. */
  unidadesPorProduto: Map<string, UnidadesDeProduto>;
  /** Dias do pedido que tiveram venda — é o divisor da média diária. */
  diasComVenda: number;
  /** Idem, restrito aos últimos 7 dias da janela. */
  diasComVenda7d: number;
}

/**
 * O período inteiro numa busca só: o resumo de cada dia e a série por produto.
 *
 * A série por produto NÃO sai de somar os "top 10" de cada dia. Um produto que
 * vende de forma constante pode ficar fora do top de um dia atípico, e a média
 * sairia menor do que é — justamente para o produto cuja cobertura mais
 * importa. Aqui a contagem passa por todos os itens de todos os pedidos.
 */
export async function periodoDeVendas(dias: string[]): Promise<PeriodoDeVendas> {
  const ordenados = [...dias].sort();
  const primeiro = ordenados[0];
  const ultimo = ordenados[ordenados.length - 1];

  const inicioBusca = new Date(`${primeiro}T12:00:00-03:00`);
  inicioBusca.setDate(inicioBusca.getDate() - FOLGA_PAGAMENTO);

  const pedidos = await pedidosCriadosEntre(inicioBusca.toISOString().slice(0, 10), ultimo);
  const porDiaDePagamento = agruparPorDiaDePagamento(pedidos);

  const porDia = new Map<string, ResumoVendas>();
  const unidadesPorProduto = new Map<string, UnidadesDeProduto>();
  let diasComVenda = 0;
  let diasComVenda7d = 0;

  // Os sete dias mais recentes da janela. A média longa dá a base; esta dá o
  // sinal de que a base envelheceu — casaco saindo de temporada cai antes de a
  // média de quinze dias perceber.
  const recentes = new Set(ordenados.slice(-7));
  const daJanela = new Set(dias);

  for (const dia of dias) {
    const doDia = porDiaDePagamento.get(dia) ?? [];
    porDia.set(dia, agregar(doDia, dia));
    if (doDia.length) {
      diasComVenda++;
      if (recentes.has(dia)) diasComVenda7d++;
    }
  }

  /*
   * A saída de estoque é contada por fora do faturamento, de propósito.
   *
   * Faturamento pergunta "quanto entrou de dinheiro naquele dia" e por isso
   * agrupa por data de pagamento e só olha pedido pago. Cobertura pergunta
   * "quantas peças saem por dia", e aí vale todo pedido: pago, pendente de Pix,
   * troca, seeding de influencer, reenvio. A peça foi separada e mandada
   * independente de o dinheiro ter compensado, e é a peça que falta na
   * prateleira. Por isso o agrupamento aqui é por data de criação.
   *
   * Pedido cancelado fica de fora: a peça volta para o estoque.
   */
  for (const p of pedidos) {
    if (p.cancelledAt) continue;

    const dia = emSaoPaulo(p.createdAt);
    if (!daJanela.has(dia)) continue;

    const recente = recentes.has(dia);
    for (const item of p.lineItems.nodes) {
      const atual = unidadesPorProduto.get(item.title) ?? {
        titulo: item.title,
        produtoId: item.product?.id ?? null,
        unidades: 0,
        unidades7d: 0,
      };
      atual.unidades += item.quantity;
      if (recente) atual.unidades7d += item.quantity;
      if (!atual.produtoId && item.product?.id) atual.produtoId = item.product.id;
      unidadesPorProduto.set(item.title, atual);
    }
  }

  return {
    porDia,
    unidadesPorProduto,
    diasComVenda: diasComVenda || 1,
    diasComVenda7d: diasComVenda7d || 1,
  };
}

export async function vendasPorDia(dias: string[]): Promise<Map<string, ResumoVendas>> {
  return (await periodoDeVendas(dias)).porDia;
}

/** Mantido para uso avulso (o servidor MCP responde perguntas de um dia só). */
export async function pedidosPagosEm(dia: string): Promise<OrderNode[]> {
  const inicio = new Date(`${dia}T12:00:00-03:00`);
  inicio.setDate(inicio.getDate() - FOLGA_PAGAMENTO);

  const pedidos = await pedidosCriadosEntre(inicio.toISOString().slice(0, 10), dia);
  return pedidos.filter((p) => diaDoPagamento(p) === dia);
}

/**
 * Data (São Paulo) em que o pedido foi pago.
 *
 * Normalmente é a captura. Mas pedido de R$ 0 — o seeding de influencer, com
 * "Desconto personalizado" cobrindo a peça inteira e FRETEINFLUENCERS o frete —
 * nasce `PAID` **sem transação nenhuma**: não há dinheiro para capturar. Pela
 * regra antiga esses pedidos devolviam null e sumiam antes mesmo de serem
 * classificados, então a linha de seeding marcava R$ 0 todo santo dia. Eram 33
 * pedidos entre 01 e 15/09, um só com transação. Sem transação e já pago, a
 * data do pagamento é a da criação.
 */
function diaDoPagamento(pedido: OrderNode): string | null {
  for (const t of pedido.transactions) {
    if (t.status !== 'SUCCESS') continue;
    if (t.kind !== 'SALE' && t.kind !== 'CAPTURE') continue;
    if (!t.processedAt) continue;
    return emSaoPaulo(t.processedAt);
  }

  // Sem transação, já marcado como pago e com total zero: não havia o que
  // capturar. O status precisa ser conferido aqui porque a busca não filtra
  // mais por pagamento — pendente também chega nesta função.
  const semCobranca = pedido.transactions.every((t) => t.status !== 'SUCCESS');
  const jaPago = (pedido.displayFinancialStatus ?? '').toUpperCase() === 'PAID';
  if (semCobranca && jaPago && num(pedido.totalPriceSet) === 0) {
    return emSaoPaulo(pedido.createdAt);
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
  let reenvios = 0;

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

    if (cat === 'reenvio') {
      reenvios++;
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
    excluidos: { trocas, influencers, reenvios },
    cuponsMaisUsados,
    categorias,
    trocasDoDia: troca,
    topProdutos,
  };
}

/* ------------------------------------------------------------------ *
 * Cliente novo x recorrente
 * ------------------------------------------------------------------ */

export interface NovosVsRecorrentes {
  pedidosNovos: number;
  pedidosRecorrentes: number;
  receitaNovos: number;
  receitaRecorrentes: number;
  /** Pedidos sem cliente identificado, fora das duas contas. */
  semCliente: number;
}

const CLIENTES_QUERY = `
  query Clientes($q: String!, $cursor: String) {
    orders(first: 100, query: $q, after: $cursor, sortKey: CREATED_AT) {
      nodes {
        name
        tags
        discountCodes
        app { name }
        totalPriceSet { shopMoney { amount } }
        transactions(first: 10) { processedAt kind status }
        customer { numberOfOrders }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/**
 * Quanto do dia veio de quem já tinha comprado.
 *
 * Fica numa consulta própria, e não junto da principal, por um motivo prático:
 * o campo `customer` exige o escopo `read_customers`, que o app pode não ter. A
 * Shopify recusa a consulta inteira quando falta escopo — se isso viesse na
 * busca principal, faltar uma permissão derrubaria o faturamento junto. Aqui,
 * no pior caso, some uma linha.
 *
 * A medida é `numberOfOrders`, o total de pedidos do cliente HOJE. Para o
 * resumo das 8h sobre o dia anterior isso é preciso o bastante: só erra se a
 * cliente comprou pela primeira vez ontem e voltou a comprar nas horas entre a
 * madrugada e o envio — caso em que o pedido de ontem aparece como recompra. O
 * viés é pequeno e sempre no mesmo sentido.
 */
export async function novosVsRecorrentes(dia: string): Promise<NovosVsRecorrentes | null> {
  const inicio = new Date(`${dia}T12:00:00-03:00`);
  inicio.setDate(inicio.getDate() - FOLGA_PAGAMENTO);

  const q = [
    `created_at:>='${inicio.toISOString().slice(0, 10)}T00:00:00-03:00'`,
    `created_at:<='${dia}T23:59:59-03:00'`,
    'financial_status:paid',
  ].join(' ');

  interface Node extends PedidoClassificavel {
    totalPriceSet: { shopMoney: { amount: string } };
    transactions: Array<{ processedAt: string | null; kind: string; status: string }>;
    customer?: { numberOfOrders?: number | string | null } | null;
  }
  interface Pagina {
    orders: { nodes: Node[]; pageInfo: { hasNextPage: boolean; endCursor: string } };
  }

  const r: NovosVsRecorrentes = {
    pedidosNovos: 0,
    pedidosRecorrentes: 0,
    receitaNovos: 0,
    receitaRecorrentes: 0,
    semCliente: 0,
  };

  let cursor: string | null = null;

  try {
    for (let pagina = 0; pagina < 60; pagina++) {
      const d: Pagina = await admin<Pagina>(CLIENTES_QUERY, { q, cursor });

      for (const p of d.orders.nodes) {
        // Mesmas exclusões do faturamento: troca e influencer não são venda.
        if (categoria(p) !== 'venda') continue;

        // E o mesmo recorte: pago NO dia, não criado no dia.
        const captura = p.transactions.find(
          (t) => t.status === 'SUCCESS' && (t.kind === 'SALE' || t.kind === 'CAPTURE'),
        );
        if (!captura?.processedAt || emSaoPaulo(captura.processedAt) !== dia) continue;

        const valor = Number(p.totalPriceSet.shopMoney.amount);
        const n = Number(p.customer?.numberOfOrders ?? 0);

        if (!p.customer || !n) {
          r.semCliente++;
        } else if (n <= 1) {
          r.pedidosNovos++;
          r.receitaNovos += valor;
        } else {
          r.pedidosRecorrentes++;
          r.receitaRecorrentes += valor;
        }
      }

      if (!d.orders.pageInfo.hasNextPage) break;
      cursor = d.orders.pageInfo.endCursor;
    }
  } catch (e) {
    // Quase sempre é escopo faltando. Devolver null deixa o resumo seguir sem a
    // linha, em vez de perder o bloco de vendas inteiro. A mensagem crua da
    // Shopify repete o mesmo erro uma vez por pedido — inundaria o log do
    // Railway todo dia às 8h sem dizer nada além da primeira linha.
    const msg = e instanceof Error ? e.message : String(e);
    console.error(
      msg.includes('read_customers')
        ? '[shopify] novo x recorrente indisponível: falta o escopo read_customers no app'
        : `[shopify] novo x recorrente indisponível: ${msg.slice(0, 200)}`,
    );
    return null;
  }

  return r;
}

/* ------------------------------------------------------------------ *
 * Estoque
 * ------------------------------------------------------------------ */

export interface EstoqueDeProduto {
  produtoId: string;
  titulo: string;
  /** Soma de todas as variantes: cor e tamanho juntos. */
  unidades: number;
}

/**
 * Estoque dos produtos pedidos, por id.
 *
 * Usa `totalInventory`, que soma todas as variantes. Para a pergunta "quanto
 * tempo esse modelo ainda dura" é a medida certa; para "qual tamanho está
 * acabando" seria preciso descer à variante, que é outra conversa e outro
 * relatório.
 */
export async function estoqueDeProdutos(ids: string[]): Promise<Map<string, EstoqueDeProduto>> {
  const saida = new Map<string, EstoqueDeProduto>();
  const limpos = [...new Set(ids.filter(Boolean))];
  if (!limpos.length) return saida;

  interface Resposta {
    nodes: Array<{ id: string; title: string; totalInventory: number | null } | null>;
  }

  for (let i = 0; i < limpos.length; i += 50) {
    const lote = limpos.slice(i, i + 50);
    const d = await admin<Resposta>(
      `query Estoque($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product { id title totalInventory }
        }
      }`,
      { ids: lote },
    );
    for (const n of d.nodes) {
      if (!n?.id) continue;
      saida.set(n.id, { produtoId: n.id, titulo: n.title, unidades: n.totalInventory ?? 0 });
    }
  }

  return saida;
}

/* ------------------------------------------------------------------ *
 * Estornos
 * ------------------------------------------------------------------ */

/**
 * Reembolsos de uma lista específica de pedidos, sem varrer a loja.
 *
 * A conferência precisa responder "este pedido tem reembolso na Shopify?" para
 * duas dezenas de pedidos que o Troquecommerce apontou. A alternativa óbvia —
 * varrer todos os pedidos mexidos nas últimas semanas — custa dezenas de
 * páginas e mais de um minuto, o que inviabiliza rodar isso dentro do resumo
 * das 8h. Perguntar pelos números exatos resolve em uma ou duas chamadas.
 *
 * O `name:` aceita OR, e o lote de 25 é conservador: o custo da query cresce
 * com os campos de refund e transação, não com o tamanho do filtro.
 */
export async function reembolsosDePedidos(nomes: string[]): Promise<Map<string, Estorno[]>> {
  const saida = new Map<string, Estorno[]>();
  const limpos = [...new Set(nomes.map((n) => n.replace(/\D/g, '')).filter(Boolean))];

  for (let i = 0; i < limpos.length; i += 25) {
    const lote = limpos.slice(i, i + 25);
    const q = lote.map((n) => `name:${n}`).join(' OR ');

    interface Resposta {
      orders: {
        nodes: Array<{
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
        }>;
      };
    }

    const d = await admin<Resposta>(
      `query PorNome($q: String!) {
        orders(first: 50, query: $q) {
          nodes {
            name
            refunds(first: 20) {
              createdAt
              transactions(first: 10) {
                nodes { kind status amountSet { shopMoney { amount } } }
              }
            }
          }
        }
      }`,
      { q },
    );

    for (const pedido of d.orders.nodes) {
      const lista: Estorno[] = [];
      for (const r of pedido.refunds ?? []) {
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
      if (lista.length) saida.set(pedido.name.replace(/\D/g, ''), lista);
    }
  }

  return saida;
}

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
