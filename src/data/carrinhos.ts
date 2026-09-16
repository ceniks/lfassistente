/**
 * Confere o carrinho abandonado entre a Shopify e o AtendePro.
 *
 * Comparar totais não funciona, por três motivos que só aparecem olhando os
 * dados:
 *
 *  1. A Shopify **tira da lista** o checkout que virou pedido. O que ela mostra
 *     é "o que continua abandonado agora", não "o que foi abandonado no dia".
 *  2. O AtendePro filtra por data **UTC**. Pedindo o dia 15/09 vieram 111
 *     carrinhos, dos quais 35 eram de 14/09 em São Paulo (das 21h em diante) e
 *     faltavam os de 15/09 depois das 21h. Três horas de desencontro que
 *     ninguém nota olhando só o total.
 *  3. O AtendePro guarda o checkout ora pelo id numérico, ora pelo hash — 65 e
 *     46 dos 111. Casar por um só dos dois perde metade.
 *
 * O que resolve é casar checkout a checkout pelo token que existe nos dois
 * lados (o trecho `/checkouts/ac/<token>/` da URL de recuperação) e olhar uma
 * pergunta que não tem ambiguidade: **checkout que a Shopify AINDA lista como
 * abandonado, tem telefone, e não existe no AtendePro**. Esse é vazamento de
 * verdade — a cliente não comprou, o telefone estava lá, e a régua não pegou.
 */
import { checkoutsAbandonadosDetalhados, type CheckoutAbandonado } from './shopify.js';
import { config } from '../config.js';
import { chamarJson } from './mcp-client.js';

export interface CarrinhoDoAtendimento {
  checkoutId: string;
  token: string | null;
  telefone: string | null;
  status: 'pending' | 'sent' | 'replied' | 'dismissed' | 'error';
  temEnvioAutomatico: boolean;
  /** A régua marcou como recuperado: virou pedido depois do disparo. */
  comprouDepois: boolean;
  criadoEm: string;
  valor: number;
}

export interface ConferenciaDeCarrinhos {
  dia: string;
  /** O que a Shopify ainda lista como abandonado naquele dia. */
  naLoja: { total: number; comTelefone: number; valor: number };
  /** O que o AtendePro registrou, já recortado pelo dia de São Paulo. */
  noAtendimento: {
    total: number;
    disparados: number;
    entregues: number;
    responderam: number;
    naoChegaram: number;
    naFila: number;
    compraramDepois: number;
  };
  /** Abandonado, com telefone, e sem carrinho no AtendePro. É o vazamento. */
  semCarrinho: Array<{ token: string; valor: number; criadoEm: string }>;
  /** Carrinho do AtendePro que a Shopify não lista mais: comprou ou recuperou. */
  foraDaListaDaLoja: number;
}

function servidor() {
  const c = config();
  if (!c.ATENDEPRO_MCP_URL) return null;
  return { nome: 'atendepro', url: c.ATENDEPRO_MCP_URL, token: c.ATENDEPRO_TOKEN };
}

/** `.../checkouts/ac/hWNGfmEC.../recover?key=...` → `hWNGfmEC...` */
export function tokenDaUrl(url: string | null | undefined): string | null {
  return url?.match(/\/checkouts\/ac\/([^/?]+)/)?.[1] ?? null;
}

function diaEmSaoPaulo(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

interface CarrinhoBruto {
  checkout_id: string;
  checkout_url: string | null;
  customer_phone: string | null;
  cart_total: number | null;
  status: CarrinhoDoAtendimento['status'];
  whatsapp_message_id: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  replied_at: string | null;
  cancel_reason: string | null;
  created_at: string;
}

/**
 * Os carrinhos do dia de São Paulo, não do dia UTC.
 *
 * Pede dois dias ao AtendePro e recorta aqui. Sem isso o bloco fala de uma
 * janela deslocada em três horas — e o erro é silencioso, porque o total
 * continua parecendo razoável.
 */
export async function carrinhosDoDia(dia: string): Promise<CarrinhoDoAtendimento[]> {
  const srv = servidor();
  if (!srv) return [];

  const seguinte = new Date(`${dia}T12:00:00-03:00`);
  seguinte.setDate(seguinte.getDate() + 1);

  const r = await chamarJson<{ carts: CarrinhoBruto[] }>(srv, 'list_abandoned_carts', {
    start_date: dia,
    end_date: seguinte.toISOString().slice(0, 10),
    limit: 200,
  });

  return r.carts
    .filter((c) => diaEmSaoPaulo(c.created_at) === dia)
    .map((c) => ({
      checkoutId: String(c.checkout_id ?? ''),
      token: tokenDaUrl(c.checkout_url),
      telefone: c.customer_phone,
      status: c.status,
      // A régua automática é a única coisa que grava wamid neste cadastro:
      // mensagem que a atendente manda na mão vive na conversa, não aqui.
      temEnvioAutomatico: Boolean(c.whatsapp_message_id && c.sent_at),
      comprouDepois: c.cancel_reason === 'purchased_after_recovery',
      criadoEm: c.created_at,
      valor: Number(c.cart_total ?? 0),
    }));
}

export async function conferirCarrinhos(dia: string): Promise<ConferenciaDeCarrinhos | null> {
  const [naLoja, carrinhos] = await Promise.all([
    checkoutsAbandonadosDetalhados(dia),
    carrinhosDoDia(dia).catch(() => [] as CarrinhoDoAtendimento[]),
  ]);

  const conhecidos = new Set<string>();
  for (const c of carrinhos) {
    if (c.token) conhecidos.add(c.token);
    if (c.checkoutId) conhecidos.add(c.checkoutId);
  }

  const identifica = (c: CheckoutAbandonado) => [c.token, c.id].filter(Boolean) as string[];

  const semCarrinho = naLoja
    .filter((c) => c.temTelefone && !identifica(c).some((k) => conhecidos.has(k)))
    .map((c) => ({ token: c.token ?? c.id, valor: c.valor, criadoEm: c.criadoEm }));

  const tokensDaLoja = new Set(naLoja.flatMap(identifica));
  const foraDaListaDaLoja = carrinhos.filter(
    (c) => ![c.token, c.checkoutId].filter(Boolean).some((k) => tokensDaLoja.has(k as string)),
  ).length;

  const automaticos = carrinhos.filter((c) => c.temEnvioAutomatico);

  return {
    dia,
    naLoja: {
      total: naLoja.length,
      comTelefone: naLoja.filter((c) => c.temTelefone).length,
      valor: naLoja.reduce((t, c) => t + c.valor, 0),
    },
    noAtendimento: {
      total: carrinhos.length,
      disparados: automaticos.length,
      entregues: automaticos.filter((c) => c.status !== 'error').length,
      responderam: carrinhos.filter((c) => c.status === 'replied').length,
      naoChegaram: carrinhos.filter((c) => c.status === 'error').length,
      naFila: carrinhos.filter((c) => c.status === 'pending').length,
      compraramDepois: carrinhos.filter((c) => c.comprouDepois).length,
    },
    semCarrinho,
    foraDaListaDaLoja,
  };
}
