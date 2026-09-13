import type { DadosResumo } from '../../src/digest/format.js';

/**
 * Números reais de 12/09/2026 (sábado), levantados das APIs em 13/09.
 *
 * Serve para validar o formatador sem depender de credencial e como regressão:
 * se a mensagem mudar de forma, o diff aparece aqui.
 *
 * Ressalva honesta sobre duas linhas: as 359 peças e o ranking de produtos vêm
 * do dataset `inventory` do ShopifyQL, que conta baixa de estoque de todos os
 * pedidos — inclusive as ~10 trocas do dia. Em produção esse número sai do loop
 * dos pedidos pagos e deve ficar uns 5% menor. A ordem do top 5 não muda.
 */
export const DIA_12_09: DadosResumo = {
  dia: '2026-09-12',

  vendas: {
    data: '2026-09-12',
    pedidos: 157,
    receita: 94_723.0,
    ticketMedio: 603.33, // 94723 / 157
    pecas: 359,
    pecasPorPedido: 2.29,
    desconto: {
      total: 58_211.94,
      cupom: 18_000.0, // aproximado: a quebra exata sai do loop de pedidos
      promocaoAutomatica: 40_211.94,
      seedingInfluencer: 0, // nenhum pedido de influencer no sábado
    },
    excluidos: { trocas: 10, influencers: 0 },
    topProdutos: [
      { titulo: 'Casaco Londres', pecas: 88, receita: 16_161.28 },
      { titulo: 'Calça Barcelona', pecas: 71, receita: 10_506.86 },
      { titulo: 'Blazer Filadélfia', pecas: 48, receita: 17_077.9 },
      { titulo: 'Blazer Las Vegas', pecas: 35, receita: 10_116.75 },
      { titulo: 'Calça Marrocos', pecas: 29, receita: 5_868.1 },
    ],
  },

  // Média dos 7 dias anteriores (05 a 11/09)
  vendasMedia7d: {
    receita: 83_811.75,
    pedidos: 166.6,
    ticketMedio: 518.95,
    descontoPct: 0.405,
  },

  trafego: {
    sessoes: 10_430,
    adicoesAoCarrinho: 1_016,
    taxaAdicao: 1016 / 10430,
    checkoutsIniciados: 389,
    checkoutsConcluidos: 158,
    conversao: 0.015148609779482262,
  },

  trafegoMedia7d: {
    sessoes: 13_083,
    taxaAdicao: 1063 / 13083,
    conversao: 0.011069,
  },

  meta: 90_000,

  midia: {
    gastoLiquido: 16_701.35,
    valorPago: 19_011.21, // × 1,138304
    roas: 4.52, // sobre o valor pago
    roasMeta: 5.150772,
    compras: 153,
    cpa: 109.16, // sobre o líquido
    cpm: 46.99,
    cpc: 1.38,
    receitaAtribuida: 86_024.85,
  },

  google: null,

  fluxos: [],

  producao: {
    naOficina: 27,
    pecasNaOficina: 27_967,
    noGalpao: 30,
    atrasados: 9,
    maisCritico: 'Colete Zurique ref:101 (previsão era 16/08/2026)',
    diasDeAtrasoDoMaisCritico: 28,
  },

  atendimento: {
    aguardando: 43,
    porAtendente: [{ nome: 'Aline', total: 25 }],
    semAtendente: 18,
    porCanal: [
      { canal: 'WhatsApp', total: 29 },
      { canal: 'Instagram', total: 14 },
    ],
    carrinhosGerados: 127,
    carrinhosComErro: 27, // 21% dos 127
    carrinhosEnviados: 27,
    carrinhosRespondidos: 10,
    npsSeteDias: 88,
    npsRespostas: 152,
  },

  leitura:
    'Funil melhorou em todas as etapas com 20% menos tráfego. A conversão saiu de 0,85% (05/09) para 1,51% — recuperação consistente, não ruído de um dia. Atenção: 18 conversas na fila sem atendente, uma delas é cliente travada na promoção de 3 peças desde sábado à noite.',
};
