#!/usr/bin/env node
/**
 * Servidor MCP da loja — o que o agente enxerga quando o Luis pergunta algo.
 *
 * A razão de existir: o agente não pode falar com a API do Shopify direto. Não
 * por segurança, mas por economia — o payload cru de um dia de pedidos tem
 * dezenas de milhares de tokens, e o que a pergunta "quanto vendi hoje?" precisa
 * cabe em dez linhas. Cada ferramenta aqui devolve o agregado, nunca o bruto.
 *
 * O mesmo vale para as regras de negócio: elas moram no código, não no prompt.
 * Se a definição de "faturamento" ficasse na instrução do modelo, uma resposta
 * mais criativa em um dia ruim mudaria o número. Aqui ela é determinística.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { vendasDoDia, trafegoDoDia } from '../src/data/shopify.js';
import { midiaDoDia } from '../src/data/meta.js';
import { metaDoDia } from '../src/data/metas.js';
import { ontem } from '../src/digest/build.js';
import { dinheiro, pct, numero } from '../src/digest/format.js';

const server = new McpServer({
  name: 'loja',
  version: '0.1.0',
});

const diaSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .describe('Data no formato YYYY-MM-DD. Omitido = ontem.');

/* ------------------------------------------------------------------ *
 * Vendas
 * ------------------------------------------------------------------ */

server.tool(
  'vendas_do_dia',
  [
    'Faturamento, pedidos, ticket médio, desconto e top 5 produtos de um dia.',
    'Conta apenas pedidos com pagamento confirmado naquele dia.',
    'Exclui trocas (cupom TROCA... ou app Troquecommerce) e pedidos de influencer (tag Influencer, que saem a R$ 0).',
    'Inclui draft orders de venda assistida — são venda real.',
  ].join(' '),
  { dia: diaSchema },
  async ({ dia }) => {
    const d = dia ?? ontem();
    const v = await vendasDoDia(d);
    const meta = await metaDoDia(d);

    const bruto = v.receita + v.desconto.total;
    const linhas = [
      `Vendas de ${d}`,
      `Faturamento: ${dinheiro(v.receita)} em ${numero(v.pedidos)} pedidos pagos`,
      `Ticket médio: ${dinheiro(v.ticketMedio)}`,
      `Peças: ${numero(v.pecas)} (${numero(v.pecasPorPedido, 2)} por pedido)`,
      '',
      `Desconto total: ${dinheiro(v.desconto.total)} — ${pct(bruto > 0 ? v.desconto.total / bruto : 0)} do bruto`,
      `  promoção automática: ${dinheiro(v.desconto.promocaoAutomatica)}`,
      `  cupom: ${dinheiro(v.desconto.cupom)}`,
      `  seeding de influencer: ${dinheiro(v.desconto.seedingInfluencer)} (custo de mídia, não concessão de preço)`,
      '',
      `Fora da conta: ${v.excluidos.trocas} troca(s), ${v.excluidos.influencers} pedido(s) de influencer`,
    ];

    if (meta !== null) {
      const atingido = meta > 0 ? v.receita / meta : 0;
      linhas.splice(
        2,
        0,
        `Meta do dia: ${dinheiro(meta)} — ${pct(atingido, 0)} atingido` +
          (v.receita >= meta ? ' (bateu)' : ` (faltou ${dinheiro(meta - v.receita)})`),
      );
    }

    if (v.topProdutos.length) {
      linhas.push('', 'Top 5 por peças vendidas:');
      v.topProdutos.forEach((p, i) =>
        linhas.push(`  ${i + 1}. ${p.titulo} — ${numero(p.pecas)} peças, ${dinheiro(p.receita)}`),
      );
    }

    return { content: [{ type: 'text', text: linhas.join('\n') }] };
  },
);

/* ------------------------------------------------------------------ *
 * Tráfego
 * ------------------------------------------------------------------ */

server.tool(
  'trafego_do_dia',
  [
    'Sessões, taxa de adição ao carrinho, checkouts iniciados e concluídos, e conversão de um dia.',
    'A conversão é a nativa do Shopify (sessões que concluíram checkout ÷ sessões),',
    'que já exclui troca e influencer por natureza — esses pedidos são criados fora da loja online.',
  ].join(' '),
  { dia: diaSchema },
  async ({ dia }) => {
    const d = dia ?? ontem();
    const t = await trafegoDoDia(d);

    return {
      content: [
        {
          type: 'text',
          text: [
            `Tráfego de ${d}`,
            `Sessões: ${numero(t.sessoes)}`,
            `Adição ao carrinho: ${numero(t.adicoesAoCarrinho)} sessões (${pct(t.taxaAdicao, 2)})`,
            `Checkouts iniciados: ${numero(t.checkoutsIniciados)}`,
            `Checkouts concluídos: ${numero(t.checkoutsConcluidos)}`,
            `Conversão: ${pct(t.conversao, 2)}`,
          ].join('\n'),
        },
      ],
    };
  },
);

/* ------------------------------------------------------------------ *
 * Mídia
 * ------------------------------------------------------------------ */

server.tool(
  'midia_do_dia',
  [
    'Gasto, ROAS, CPA, CPM e CPC no Meta em um dia.',
    'O valor pago e o ROAS já incluem o imposto (13,8304%); CPA, CPM e CPC ficam sobre o gasto líquido,',
    'para continuarem comparáveis com benchmark de leilão e com o histórico.',
    'CPM e CPC consideram apenas campanhas com objetivo de vendas.',
  ].join(' '),
  { dia: diaSchema },
  async ({ dia }) => {
    const d = dia ?? ontem();
    const m = await midiaDoDia(d);

    return {
      content: [
        {
          type: 'text',
          text: [
            `Mídia de ${d} (Meta)`,
            `Valor pago: ${dinheiro(m.valorPago)} (líquido ${dinheiro(m.gastoLiquido)} + imposto)`,
            `ROAS sobre o valor pago: ${numero(m.roas, 2)}`,
            `ROAS como o Meta reporta: ${numero(m.roasMeta, 2)}`,
            `Compras atribuídas: ${numero(m.compras)}`,
            `CPA: ${dinheiro(m.cpa)} · CPM: ${dinheiro(m.cpm)} · CPC: ${dinheiro(m.cpc)} (líquidos)`,
            `Receita atribuída pelo Meta: ${dinheiro(m.receitaAtribuida)}`,
          ].join('\n'),
        },
      ],
    };
  },
);

/* ------------------------------------------------------------------ *
 * Comparativo
 * ------------------------------------------------------------------ */

server.tool(
  'comparar_com_media',
  [
    'Compara um dia com a média dos N dias anteriores, em faturamento, pedidos, ticket e conversão.',
    'Use quando a pergunta for sobre tendência ou sobre se um dia foi bom.',
    'A média é recalculada com as mesmas regras do dia — nunca vem de agregado pronto do painel,',
    'porque o painel conta troca e influencer e a comparação sairia inventada.',
  ].join(' '),
  {
    dia: diaSchema,
    dias: z.number().int().min(1).max(30).optional().describe('Quantos dias na média. Padrão 7.'),
  },
  async ({ dia, dias }) => {
    const d = dia ?? ontem();
    const n = dias ?? 7;

    const base = new Date(`${d}T12:00:00-03:00`);
    const anteriores = Array.from({ length: n }, (_, i) => {
      const x = new Date(base);
      x.setDate(x.getDate() - (i + 1));
      return x.toISOString().slice(0, 10);
    });

    const [hoje, hojeTrafego] = await Promise.all([vendasDoDia(d), trafegoDoDia(d)]);
    const antes = await Promise.all(anteriores.map((x) => vendasDoDia(x)));
    const antesTrafego = await Promise.all(anteriores.map((x) => trafegoDoDia(x)));

    const med = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);
    const medReceita = med(antes.map((a) => a.receita));
    const medPedidos = med(antes.map((a) => a.pedidos));
    const medTicket = med(antes.map((a) => a.ticketMedio));
    const medConversao = med(antesTrafego.map((a) => a.conversao));

    const delta = (atual: number, base: number) =>
      base ? `${atual >= base ? '+' : ''}${(((atual - base) / base) * 100).toFixed(0)}%` : '—';

    return {
      content: [
        {
          type: 'text',
          text: [
            `${d} contra a média dos ${n} dias anteriores`,
            `Faturamento: ${dinheiro(hoje.receita)} vs ${dinheiro(medReceita)} — ${delta(hoje.receita, medReceita)}`,
            `Pedidos: ${numero(hoje.pedidos)} vs ${numero(medPedidos, 1)} — ${delta(hoje.pedidos, medPedidos)}`,
            `Ticket: ${dinheiro(hoje.ticketMedio)} vs ${dinheiro(medTicket)} — ${delta(hoje.ticketMedio, medTicket)}`,
            `Conversão: ${pct(hojeTrafego.conversao, 2)} vs ${pct(medConversao, 2)} — ${delta(hojeTrafego.conversao, medConversao)}`,
          ].join('\n'),
        },
      ],
    };
  },
);

/* ------------------------------------------------------------------ */

const transport = new StdioServerTransport();
await server.connect(transport);
