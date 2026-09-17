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
import { config } from "../config.js";
import { tabelaDeCusto } from "./patrimonio.js";
import type { ResumoVendas } from "./shopify.js";

export interface Margem {
  receita: number;
  /** Custo de tudo que saiu do estoque: vendido mais seeding. */
  cmv: number;
  pecasComCusto: number;
  /** Peças sem custo no Corte Pro, entram no CMV por estimativa. */
  pecasSemCusto: number;
  /** Quanto do CMV é estimativa, não custo medido. */
  custoEstimado: number;
  /** Total de peças que saíram: vendidas mais seeding. */
  pecasQueSairam: number;
  margemBruta: number;
  midia: number;
  taxaDePagamento: number;
  /** Parte da taxa que foi lida do gateway, em reais. O resto é estimativa. */
  taxaMedida: number;
  /** Receita coberta pela taxa medida — o quanto da conta deixou de ser chute. */
  receitaComTaxaMedida: number;
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

  /*
   * Método manual nomeado, criado no admin em 17/09/2026. "pix" ali é Pix na
   * conta, não Pix de gateway: não há taxa de adquirente nenhuma. Confundir os
   * dois cobraria 0,99% de um dinheiro que chegou inteiro — e a distinção é o
   * nome exato, porque "Mercado Pago Pix" também contém "pix".
   */
  if (g === "pix" || g === "dinheiro") return 0;

  if (g.includes("pix")) return c.TAXA_PIX_PCT / 100;
  if (g.includes("boleto")) return c.TAXA_BOLETO_PCT / 100;
  if (g.includes("débito") || g.includes("debito")) return 0;

  if (c.TAXA_CARTAO_PCT > 0) return c.TAXA_CARTAO_PCT / 100;
  return (TAXA_POR_PARCELA[c.PARCELAS_MEDIAS] ?? TAXA_POR_PARCELA[1]) / 100;
}

/**
 * @param taxaDoPagBank  taxa que o PagBank cobrou de verdade, somada transação
 *   a transação, e quanto de receita ela cobre. Quando vem, substitui a
 *   estimativa nessa fatia — e ela é grande: a alíquota não é única, vai de
 *   3,12% à vista a 7,38% em 8x. Sem isso, qualquer percentual fixo erra
 *   conforme o mix de parcelamento do dia muda.
 */
export function margemDoDia(
  vendas: ResumoVendas,
  midia: number,
  taxaDoPagBank?: { taxa: number; receita: number } | null,
): Margem {
  const c = config();
  const custoDe = tabelaDeCusto();

  /*
   * O CMV é o custo de TUDO que saiu do estoque no dia: as peças vendidas mais
   * as peças de seeding. O seeding não gera receita, mas a peça saiu e foi
   * paga — deixá-lo fora do custo faz a margem bruta parecer melhor do que é.
   *
   * Peça sem custo no Corte Pro não pode simplesmente sumir da conta, que era
   * o que acontecia: em 15/09, 63 das 353 peças vendidas ficavam de fora e o
   * CMV saía 18% menor. Elas entram por estimativa, ao mesmo custo sobre preço
   * das peças que têm custo conhecido, e o boletim diz quantas foram.
   */
  let custoConhecido = 0;
  let receitaComCusto = 0;
  let pecasComCusto = 0;
  let pecasSemCusto = 0;
  let receitaSemCusto = 0;

  for (const p of vendas.pecasVendidas) {
    const unitario = custoDe(p.titulo);
    if (unitario === undefined) {
      pecasSemCusto += p.pecas;
      receitaSemCusto += p.receita;
      continue;
    }
    custoConhecido += unitario * p.pecas;
    receitaComCusto += p.receita;
    pecasComCusto += p.pecas;
  }

  const razaoDeCusto =
    receitaComCusto > 0 ? custoConhecido / receitaComCusto : 0;
  const custoMedioPorPeca =
    pecasComCusto > 0 ? custoConhecido / pecasComCusto : 0;
  const custoEstimado = receitaSemCusto * razaoDeCusto;

  let custoDoSeeding = 0;
  let pecasDeSeeding = 0;
  let pecasDeSeedingEstimadas = 0;
  for (const p of vendas.pecasDeSeeding) {
    pecasDeSeeding += p.pecas;
    const unitario = custoDe(p.titulo);
    if (unitario === undefined) {
      pecasDeSeedingEstimadas += p.pecas;
      custoDoSeeding += custoMedioPorPeca * p.pecas;
    } else {
      custoDoSeeding += unitario * p.pecas;
    }
  }

  const cmv = custoConhecido + custoEstimado + custoDoSeeding;

  /*
   * A taxa medida vale mais que a estimada, então o PagBank sai da conta por
   * alíquota e entra pelo valor cobrado. O que sobra — Mercado Pago e qualquer
   * gateway sem credencial — continua estimado, e o relatório diz quanto.
   */
  const medida = taxaDoPagBank ?? null;
  const ehMedido = (g: string) =>
    Boolean(medida) && /pagbank|pagseguro|mercado\s*pago/i.test(g);

  const taxaEstimada = vendas.porGateway.reduce(
    (t, g) =>
      ehMedido(g.gateway) ? t : t + g.valor * taxaDoGateway(g.gateway),
    0,
  );
  const taxaDePagamento = taxaEstimada + (medida?.taxa ?? 0);

  const taxaDaPlataforma = vendas.receita * (c.TAXA_PLATAFORMA_PCT / 100);
  const custoDeFrete = c.CUSTO_FRETE_POR_PEDIDO * vendas.pedidos;

  const margemBruta = vendas.receita - cmv;
  const margemDeContribuicao =
    margemBruta - midia - taxaDePagamento - taxaDaPlataforma - custoDeFrete;

  const parametrosFaltando: string[] = [];
  if (!c.CUSTO_FRETE_POR_PEDIDO) parametrosFaltando.push("custo do frete");

  return {
    receita: vendas.receita,
    cmv,
    pecasComCusto,
    pecasSemCusto,
    custoEstimado: custoEstimado + custoMedioPorPeca * pecasDeSeedingEstimadas,
    pecasQueSairam: pecasComCusto + pecasSemCusto + pecasDeSeeding,
    margemBruta,
    midia,
    taxaDePagamento,
    taxaMedida: medida?.taxa ?? 0,
    receitaComTaxaMedida: medida?.receita ?? 0,
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
