/**
 * O que sobrou do dia, não o que entrou.
 *
 * O boletim sabia dizer R$ 78.677 de receita e R$ 14.374 de mídia, e deixava a
 * subtração para a cabeça de quem lê — sem o custo das peças, que é a maior
 * parcela. Com o custo por peça do Corte Pro confiável, a conta fecha.
 *
 * Duas parcelas não existem em lugar nenhum da API e entram como parâmetro: a
 * taxa do meio de pagamento (PagBank e Mercado Pago não devolvem `fees`) e o
 * custo real do frete (está na fatura dos Correios). Ficam em zero até serem
 * configuradas, e a margem sai marcada como incompleta em vez de sair errada.
 */
import { config } from '../config.js';
import { tabelaDeCusto } from './patrimonio.js';
import type { ResumoVendas } from './shopify.js';

export interface Margem {
  receita: number;
  /** Custo das peças vendidas. */
  cmv: number;
  pecasComCusto: number;
  pecasSemCusto: number;
  margemBruta: number;
  midia: number;
  taxaDePagamento: number;
  /** Em quantas parcelas o cartão foi calculado — é parâmetro, não medição. */
  parcelasUsadas: number;
  /** Comissão da Shopify sobre a venda. */
  taxaDaPlataforma: number;
  custoDeFrete: number;
  freteCobrado: number;
  /** Peças dadas em seeding, a custo. Saiu do caixa e não é mídia declarada. */
  custoDoSeeding: number;
  pecasDeSeeding: number;
  margemDeContribuicao: number;
  /** Parcelas que dependem de parâmetro e ainda estão zeradas. */
  parametrosFaltando: string[];
}

/**
 * Taxa do cartão por número de parcelas, tabela do PagBank de 16/09/2026.
 *
 * Débito é zero e por isso tem caminho próprio; à vista é o índice 1.
 */
const TAXA_POR_PARCELA: Record<number, number> = {
  1: 3.15,
  2: 3.78,
  3: 4.36,
  4: 4.94,
  5: 5.52,
  6: 6.09,
  7: 6.82,
  8: 7.38,
  9: 7.94,
  10: 8.5,
};

/** "PagBank - Cartão de Crédito" → cartão; "Mercado Pago Pix" → pix. */
function taxaDoGateway(gateway: string): number {
  const c = config();
  const g = gateway.toLowerCase();

  if (g.includes('pix')) return c.TAXA_PIX_PCT / 100;
  if (g.includes('boleto')) return c.TAXA_BOLETO_PCT / 100;
  if (g.includes('débito') || g.includes('debito')) return 0;

  if (c.TAXA_CARTAO_PCT > 0) return c.TAXA_CARTAO_PCT / 100;
  return (TAXA_POR_PARCELA[c.PARCELAS_MEDIAS] ?? TAXA_POR_PARCELA[1]) / 100;
}

export function margemDoDia(vendas: ResumoVendas, midia: number): Margem {
  const c = config();
  const custoDe = tabelaDeCusto();

  let cmv = 0;
  let pecasComCusto = 0;
  let pecasSemCusto = 0;

  for (const p of vendas.pecasVendidas) {
    const unitario = custoDe(p.titulo);
    if (unitario === undefined) {
      pecasSemCusto += p.pecas;
      continue;
    }
    cmv += unitario * p.pecas;
    pecasComCusto += p.pecas;
  }

  let custoDoSeeding = 0;
  let pecasDeSeeding = 0;
  for (const p of vendas.pecasDeSeeding) {
    pecasDeSeeding += p.pecas;
    custoDoSeeding += (custoDe(p.titulo) ?? 0) * p.pecas;
  }

  const taxaDePagamento = vendas.porGateway.reduce(
    (t, g) => t + g.valor * taxaDoGateway(g.gateway),
    0,
  );

  const taxaDaPlataforma = vendas.receita * (c.TAXA_PLATAFORMA_PCT / 100);
  const custoDeFrete = c.CUSTO_FRETE_POR_PEDIDO * vendas.pedidos;

  const margemBruta = vendas.receita - cmv;
  const margemDeContribuicao =
    margemBruta - midia - taxaDePagamento - taxaDaPlataforma - custoDeFrete - custoDoSeeding;

  const parametrosFaltando: string[] = [];
  if (!c.CUSTO_FRETE_POR_PEDIDO) parametrosFaltando.push('custo do frete');

  return {
    receita: vendas.receita,
    cmv,
    pecasComCusto,
    pecasSemCusto,
    margemBruta,
    midia,
    taxaDePagamento,
    parcelasUsadas: c.TAXA_CARTAO_PCT > 0 ? 0 : c.PARCELAS_MEDIAS,
    taxaDaPlataforma,
    custoDeFrete,
    freteCobrado: vendas.freteCobrado,
    custoDoSeeding,
    pecasDeSeeding,
    margemDeContribuicao,
    parametrosFaltando,
  };
}
