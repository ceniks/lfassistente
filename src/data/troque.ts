import { config } from '../config.js';

/**
 * Troquecommerce — o outro lado da operação.
 *
 * O Shopify só enxerga metade de uma troca: o pedido novo que sai, com um cupom
 * `TROCA<numero-do-pedido-original>`. O que voltou, por quê, e se chegou a
 * voltar, só existe aqui.
 *
 * Duas lojas, dois tokens. A migração para o Shopify foi em 08/04/2026, e as
 * reversas de vendas anteriores vivem na loja antiga (Nuvemshop). O boletim usa
 * só a atual; a legada fica para comparação histórica pontual.
 */

const BASE = 'https://www.troquecommerce.com.br/api/public';

export type Loja = 'atual' | 'legada';

function token(loja: Loja): string {
  const c = config();
  const t = loja === 'atual' ? c.TROQUE_TOKEN : c.TROQUE_TOKEN_LEGADO;
  if (!t) {
    throw new Error(
      `${loja === 'atual' ? 'TROQUE_TOKEN' : 'TROQUE_TOKEN_LEGADO'} não configurado. ` +
        'Pegue em Painel > Automações > API, na loja correspondente.',
    );
  }
  return t;
}

export function temTroque(loja: Loja = 'atual'): boolean {
  const c = config();
  return Boolean(loja === 'atual' ? c.TROQUE_TOKEN : c.TROQUE_TOKEN_LEGADO);
}

/* ------------------------------------------------------------------ *
 * Cliente
 * ------------------------------------------------------------------ */

/**
 * Limite: 40 requisições a cada 10 segundos, por token, somando todos os
 * endpoints. A janela é fixa e zera de uma vez.
 *
 * Seguramos em 4 por segundo em vez de correr até o 429: o resumo das 8h não
 * tem pressa, e um 429 no meio de uma paginação custa mais tempo do que o
 * espaçamento economiza.
 */
const INTERVALO_MS = 250;
const ultimaChamada = new Map<Loja, number>();

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function esperarVez(loja: Loja): Promise<void> {
  const anterior = ultimaChamada.get(loja) ?? 0;
  const espera = anterior + INTERVALO_MS - Date.now();
  if (espera > 0) await dormir(espera);
  ultimaChamada.set(loja, Date.now());
}

async function get<T>(
  caminho: string,
  params: Record<string, string | number | boolean | undefined>,
  loja: Loja,
  tentativa = 0,
): Promise<T> {
  await esperarVez(loja);

  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') query.set(k, String(v));
  }

  const res = await fetch(`${BASE}${caminho}?${query}`, {
    headers: { token: token(loja) },
  });

  if (res.status === 429) {
    if (tentativa >= 3) throw new Error('Troquecommerce: limite de requisições, desisti após 3 tentativas');
    // O 429 traz o timestamp Unix de quando a janela zera — melhor esperar o
    // que ele diz do que chutar um backoff.
    const reset = Number(res.headers.get('X-RateLimit-Reset') ?? 0);
    const espera = reset > 0 ? Math.max(0, reset * 1000 - Date.now()) + 200 : 2000 * (tentativa + 1);
    await dormir(espera);
    return get<T>(caminho, params, loja, tentativa + 1);
  }

  if (!res.ok) {
    const corpo = (await res.text()).slice(0, 300);
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Troquecommerce ${res.status}: token recusado. Confira se é o token da loja ${loja} ` +
          `e se o nível de acesso inclui leitura. Resposta: ${corpo}`,
      );
    }
    throw new Error(`Troquecommerce ${res.status}: ${corpo}`);
  }

  return (await res.json()) as T;
}

/* ------------------------------------------------------------------ *
 * Tipos
 * ------------------------------------------------------------------ */

/**
 * O motivo de um item ter voltado.
 *
 * Nao e string: alem da categoria, vem o comentario que a CLIENTE escreveu e as
 * fotos que ela anexou. O comentario e a parte mais valiosa da integracao
 * inteira — "veio com forro interno costurado torto" nao cabe em enum nenhum.
 */
export interface MotivoItem {
  description?: string;
  sub_reason?: string | null;
  client_comment?: string | null;
  organisation_comment?: string | null;
  image_url?: string[];
}

export interface ItemReversa {
  sku?: string;
  description?: string;
  quantity?: number;
  /** Por que ESTE item voltou. O motivo e por item, nao por reversa. */
  reason?: MotivoItem;
  is_exchange?: boolean;
  is_received?: boolean;
  is_retained?: boolean;
  /** A peça que saiu no lugar desta. É o par que o Shopify não sabe montar. */
  replaced_item_sku?: string;
  replaced_item_description?: string;
}

export interface Reversa {
  id: string;
  /** Número do pedido na loja — é a chave para cruzar com o Shopify. */
  ecommerce_number?: string;
  status: string;
  reverse_type?: string;
  created_at: string;
  updated_at?: string;
  price?: number;
  exchange_value?: number;
  refund_value?: number;
  /** Quanto ficou em crédito em vez de virar estorno. */
  retained_value?: number;
  retained_bonus?: number;
  retention_level?: string;
  is_complete?: boolean;
  is_exception?: boolean;
  is_second_reverse?: boolean;
  cancel_reason?: string;
  items?: ItemReversa[];
}

interface Pagina {
  count: number;
  page: number;
  total_pages: number;
  list: Reversa[];
}

/* ------------------------------------------------------------------ *
 * Listagem
 * ------------------------------------------------------------------ */

export interface Filtro {
  /** Data de CRIAÇÃO da reversa, YYYY-MM-DD. */
  criadaDe?: string;
  criadaAte?: string;
  /** Data de ATUALIZAÇÃO — é como se pega "o que mudou de status ontem". */
  atualizadaDe?: string;
  atualizadaAte?: string;
  /** Um ou mais status, separados por vírgula. */
  status?: string;
}

/**
 * O dia inteiro, no formato que a API aceita.
 *
 * `YYYY-MM-DDTHH:MM:ss` e nada alem disso: mandar o fuso junto
 * (`2026-09-13T00:00:00-03:00`) devolve 500 com "Data em formato invalido".
 * E os dois lados sao obrigatorios — mandar so o `from` nao da erro, a API
 * simplesmente ignora o filtro e devolve a base inteira, o que e pior.
 */
const inicio = (dia: string) => `${dia}T00:00:00`;
const fim = (dia: string) => `${dia}T23:59:59`;

export async function listar(filtro: Filtro, loja: Loja = 'atual'): Promise<Reversa[]> {
  const saida: Reversa[] = [];
  let pagina = 1;

  // Guarda-chuva: a API pagina e nada impede um filtro largo demais de varrer a
  // base inteira às 8h da manhã. Cinquenta páginas é muito mais do que um dia
  // de operação produz e ainda assim termina rápido.
  const MAX_PAGINAS = 50;

  while (pagina <= MAX_PAGINAS) {
    const r = await get<Pagina>(
      '/order/list',
      {
        page: pagina,
        status: filtro.status,
        created_at_from: filtro.criadaDe ? inicio(filtro.criadaDe) : undefined,
        created_at_to: filtro.criadaAte ? fim(filtro.criadaAte) : undefined,
        updated_from: filtro.atualizadaDe ? inicio(filtro.atualizadaDe) : undefined,
        updated_to: filtro.atualizadaAte ? fim(filtro.atualizadaAte) : undefined,
      },
      loja,
    );

    saida.push(...(r.list ?? []));
    if (!r.total_pages || pagina >= r.total_pages) break;
    pagina += 1;
  }

  return saida;
}

/** Detalhe de uma reversa — traz `items`, que a listagem resumida não traz. */
export async function detalhe(id: string, loja: Loja = 'atual'): Promise<Reversa> {
  return get<Reversa>('/order', { id }, loja);
}

/* ------------------------------------------------------------------ *
 * Classificação
 * ------------------------------------------------------------------ */

const norm = (s?: string) =>
  (s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();

export type Tipo = 'troca' | 'estorno' | 'sem_reembolso' | 'misto' | 'desconhecido';

/**
 * Troca ou estorno.
 *
 * O `reverse_type` não vem com enum documentado, então não dá para confiar num
 * conjunto fixo de valores. Classificamos pelo que o texto diz e, quando não
 * reconhecemos, devolvemos `desconhecido` em vez de chutar — um valor novo
 * caindo silenciosamente no balde errado estraga a métrica que mais importa
 * aqui, que é a proporção entre os dois.
 */
export function tipo(r: Reversa): Tipo {
  const t = norm(r.reverse_type);
  // Valores reais medidos em 30 dias: Troca (602), Devolucao (381),
  // Sem Reembolso (128), Troca e devolucao (13). "Sem Reembolso" e um balde
  // proprio de proposito: nao retem receita como a troca nem devolve dinheiro
  // como o estorno, e somar com qualquer um dos dois mente sobre o caixa.
  if (t.includes('troca') && t.includes('devol')) return 'misto';
  if (t.includes('sem reembolso')) return 'sem_reembolso';
  if (t.includes('troca') || t.includes('exchange')) return 'troca';
  if (t.includes('devol') || t.includes('estorno') || t.includes('refund') || t.includes('return'))
    return 'estorno';
  // Sem rótulo utilizável, o dinheiro decide.
  if ((r.exchange_value ?? 0) > 0) return 'troca';
  if ((r.refund_value ?? 0) > 0) return 'estorno';
  return 'desconhecido';
}

/**
 * Atencao a dois vocabularios diferentes para a mesma coisa.
 *
 * O FILTRO da API usa snake_case (`aguardando_envio`); a RESPOSTA devolve o
 * rotulo de tela ("Aguardando Envio", com acento e espaco). Comparar a resposta
 * contra o valor de filtro nao casa nunca, e falha calado — a contagem sai
 * zerada como se nao houvesse reversa parada.
 */
const FILTRO_ABERTOS = [
  'em_analise',
  'aguardando_envio',
  'aguardando_recebimento',
  'em_transito',
  'entrega_realizada',
  'aguardando_pagamento',
  'problemas_no_envio',
  'aguardando_nfd',
  'processando_pagamento',
  'falha_pagamento',
];
/** Rotulos como a resposta os devolve, ja normalizados. */
const ESPERANDO_CLIENTE = ['em analise', 'aguardando envio'];
const ENCERRADOS = ['finalizado', 'cancelado'];

export const estaAberta = (r: Reversa) => !ENCERRADOS.includes(norm(r.status));
export const esperandoCliente = (r: Reversa) => ESPERANDO_CLIENTE.includes(norm(r.status));

/* ------------------------------------------------------------------ *
 * Agregado do dia
 * ------------------------------------------------------------------ */

export interface ParTrocado {
  devolveu: string;
  levou: string;
  motivo?: string;
  /** O que a cliente escreveu. Vale mais que a categoria. */
  comentario?: string;
}

export interface Reversas {
  dia: string;
  abertas: number;
  aberturasPorTipo: Record<Tipo, number>;
  concluidas: number;
  canceladas: number;
  /** Diferença que as clientes pagaram nas trocas concluídas no dia. */
  valorTroca: number;
  valorEstorno: number;
  valorRetido: number;
  /** Reversas ainda abertas, independentemente de quando nasceram. */
  emAberto: number;
  /** Abertas ha mais de 7 dias e ainda esperando a cliente postar. */
  travadas: number;
  /** Abertas ha mais de 30 dias, em qualquer status. E o passivo real. */
  envelhecidas: number;
  /** Status com mais reversas paradas, e quantas. */
  gargalo?: { status: string; total: number };
  /** Motivo → quantidade, nos últimos 30 dias. */
  motivos: Array<{ motivo: string; total: number }>;
  /** O que voltou e o que saiu no lugar, no dia. */
  pares: ParTrocado[];
}

const vazio = (dia: string): Reversas => ({
  dia,
  abertas: 0,
  aberturasPorTipo: { troca: 0, estorno: 0, sem_reembolso: 0, misto: 0, desconhecido: 0 },
  concluidas: 0,
  canceladas: 0,
  valorTroca: 0,
  valorEstorno: 0,
  valorRetido: 0,
  emAberto: 0,
  travadas: 0,
  envelhecidas: 0,
  motivos: [],
  pares: [],
});

function diasAntes(dia: string, n: number): string {
  const d = new Date(`${dia}T12:00:00-03:00`);
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * O bloco de trocas do resumo diário.
 *
 * Três recortes, porque respondem perguntas diferentes: o que ENTROU ontem
 * (demanda), o que FECHOU ontem (capacidade de resolver) e o que está PARADO
 * (cliente com a peça errada em casa e nenhuma resolução — o que mais machuca
 * recompra e não aparece em lugar nenhum hoje).
 *
 * Os motivos usam 30 dias de propósito: num dia há três ou quatro reversas, e
 * uma contagem de motivos sobre quatro itens é ruído com cara de tendência.
 */
export async function reversasDoDia(dia: string, loja: Loja = 'atual'): Promise<Reversas> {
  const r = vazio(dia);

  const [abertas, mexidas, pendentes] = await Promise.all([
    listar({ criadaDe: dia, criadaAte: dia }, loja),
    listar({ atualizadaDe: dia, atualizadaAte: dia }, loja),
    listar({ status: FILTRO_ABERTOS.join(',') }, loja),
  ]);

  r.abertas = abertas.length;
  for (const x of abertas) r.aberturasPorTipo[tipo(x)] += 1;

  for (const x of mexidas) {
    const s = norm(x.status);
    if (s === 'finalizado') {
      r.concluidas += 1;
      r.valorTroca += x.exchange_value ?? 0;
      r.valorEstorno += x.refund_value ?? 0;
      r.valorRetido += x.retained_value ?? 0;
    } else if (s === 'cancelado') {
      r.canceladas += 1;
    }
  }

  const limite = diasAntes(dia, 7);
  r.emAberto = pendentes.length;
  // Travada e a que espera a CLIENTE postar ha mais de uma semana. As que estao
  // em transito ou aguardando recebimento nao estao travadas: estao andando.
  r.travadas = pendentes.filter(
    (x) => esperandoCliente(x) && x.created_at.slice(0, 10) < limite,
  ).length;

  // O passivo que importa nao e o total aberto, e o que envelheceu. Reversa de
  // tres dias e operacao normal; de trinta e uma cliente sem resolucao.
  const trintaDias = diasAntes(dia, 30);
  r.envelhecidas = pendentes.filter((x) => x.created_at.slice(0, 10) < trintaDias).length;

  const porStatus = new Map<string, number>();
  for (const x of pendentes) porStatus.set(x.status, (porStatus.get(x.status) ?? 0) + 1);
  const maior = [...porStatus].sort((a, b) => b[1] - a[1])[0];
  if (maior) r.gargalo = { status: maior[0], total: maior[1] };

  // Motivos e pares pedem o detalhe, que é uma chamada por reversa. Só vale
  // para o que fechou no dia — pedir o detalhe de 30 dias de reversas seria
  // centenas de chamadas para um bloco de cinco linhas.
  const contagem = new Map<string, number>();
  for (const x of mexidas.filter((y) => norm(y.status) === 'finalizado')) {
    try {
      const d = await detalhe(x.id, loja);
      for (const item of d.items ?? []) {
        const motivo = item.reason?.description;
        if (motivo) contagem.set(motivo, (contagem.get(motivo) ?? 0) + 1);
        if (item.replaced_item_description) {
          r.pares.push({
            devolveu: item.description ?? item.sku ?? '(sem descrição)',
            levou: item.replaced_item_description,
            motivo: item.reason?.description,
            comentario: item.reason?.client_comment ?? undefined,
          });
        }
      }
    } catch (e) {
      console.error(`[troque] detalhe da reversa ${x.id} falhou:`, e);
    }
  }

  r.motivos = [...contagem]
    .map(([motivo, total]) => ({ motivo, total }))
    .sort((a, b) => b.total - a.total);

  return r;
}
