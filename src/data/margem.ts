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
  custoDeFrete: number;
  freteCobrado: number;
  /** Peças dadas em seeding, a custo. Saiu do caixa e não é mídia declarada. */
  custoDoSeeding: number;
  pecasDeSeeding: number;
  margemDeContribuicao: number;
  /** Parcelas que dependem de parâmetro e ainda estão zeradas. */
  parametrosFaltando: string[];
}

/** "PagBank - Cartão de Crédito" → cartão; "Mercado Pago Pix" → pix. */
function taxaDoGateway(gateway: string): number {
  const c = config();
  const g = gateway.toLowerCase();
  if (g.includes('pix')) return c.TAXA_PIX_PCT / 100;
  if (g.includes('boleto')) return c.TAXA_BOLETO_PCT / 100;
  return c.TAXA_CARTAO_PCT / 100;
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

  const custoDeFrete = c.CUSTO_FRETE_POR_PEDIDO * vendas.pedidos;

  const margemBruta = vendas.receita - cmv;
  const margemDeContribuicao =
    margemBruta - midia - taxaDePagamento - custoDeFrete - custoDoSeeding;

  const parametrosFaltando: string[] = [];
  if (!c.TAXA_CARTAO_PCT && !c.TAXA_PIX_PCT && !c.TAXA_BOLETO_PCT) {
    parametrosFaltando.push('taxa do meio de pagamento');
  }
  if (!c.CUSTO_FRETE_POR_PEDIDO) parametrosFaltando.push('custo do frete');

  return {
    receita: vendas.receita,
    cmv,
    pecasComCusto,
    pecasSemCusto,
    margemBruta,
    midia,
    taxaDePagamento,
    custoDeFrete,
    freteCobrado: vendas.freteCobrado,
    custoDoSeeding,
    pecasDeSeeding,
    margemDeContribuicao,
    parametrosFaltando,
  };
}
