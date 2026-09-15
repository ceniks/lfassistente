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

import { vendasDoDia, trafegoDoDia, estornosDoDia } from '../src/data/shopify.js';
import { midiaDoDia, desempenhoPorNivel, type Nivel } from '../src/data/meta.js';
import { midiaGoogleDoDia, temGoogleAds } from '../src/data/google.js';
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
    'Faturamento, pedidos, ticket médio, desconto, cupons mais usados, top 10 produtos,',
    'vendas por categoria e trocas pagas de um dia.',
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
      `  promoção do site: ${dinheiro(v.desconto.promocaoAutomatica)}`,
      `  cupom de venda: ${dinheiro(v.desconto.cupom)}`,
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

    if (v.cuponsMaisUsados.length) {
      linhas.push('', 'Cupons de venda mais usados:');
      for (const c of v.cuponsMaisUsados) {
        linhas.push(`  ${c.codigo} — ${numero(c.pedidos)} pedidos, ${dinheiro(c.valor)} abatidos`);
      }
    }

    const tro = v.trocasDoDia;
    linhas.push('', `Trocas pagas no dia: ${numero(tro.total)} pedidos (fora do faturamento)`);
    if (tro.porCupom.pedidos > 0) {
      linhas.push(
        `  por cupom de troca: ${numero(tro.porCupom.pedidos)} pedidos, ${dinheiro(tro.porCupom.valor)} abatidos`,
      );
    }
    if (tro.direta.pedidos > 0) {
      linhas.push(
        `  troca direta (Troquecommerce): ${numero(tro.direta.pedidos)} pedidos, ` +
          `${numero(tro.direta.pecas)} peças, ${dinheiro(tro.direta.valorAPrecoDeSite)} a preço de site`,
      );
    }

    if (v.topProdutos.length) {
      linhas.push('', 'Top 10 por peças vendidas:');
      v.topProdutos.forEach((p, i) =>
        linhas.push(`  ${i + 1}. ${p.titulo} — ${numero(p.pecas)} peças, ${dinheiro(p.receita)}`),
      );
    }

    if (v.categorias.length) {
      linhas.push('', 'Vendas por categoria:');
      for (const c of v.categorias) {
        linhas.push(
          `  ${c.categoria} — ${numero(c.pecas)} peças, ${pct(c.participacao)} das peças, ${dinheiro(c.receita)}`,
        );
      }
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

server.tool(
  'desempenho_de_midia',
  [
    'Desempenho por campanha, conjunto de anúncios ou anúncio em um dia no Meta:',
    'gasto, compras, ROAS, CPA, CPM e CPC de cada um.',
    'Use para perguntas como "qual campanha teve o melhor CPA", "qual anúncio vendeu mais",',
    '"onde está indo a verba".',
    'ATENÇÃO ao responder: num único dia a maioria das campanhas tem uma ou duas compras,',
    'e um CPA calculado sobre uma compra não significa nada. Use minimo_compras para filtrar,',
    'e ao apontar um vencedor diga sobre quantas compras o número foi calculado.',
  ].join(' '),
  {
    dia: diaSchema,
    nivel: z
      .enum(['campanha', 'conjunto', 'anuncio'])
      .optional()
      .describe('Granularidade. Padrão: campanha.'),
    ordenar_por: z
      .enum(['gasto', 'cpa', 'roas', 'compras'])
      .optional()
      .describe('Padrão: gasto. Use cpa ou roas quando a pergunta for sobre eficiência.'),
    minimo_compras: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Ignora linhas com menos compras que isto. Padrão 0 (mostra tudo).'),
    limite: z.number().int().min(1).max(50).optional().describe('Quantas linhas. Padrão 10.'),
  },
  async ({ dia, nivel, ordenar_por, minimo_compras, limite }) => {
    const d = dia ?? ontem();
    const traduz: Record<string, Nivel> = { campanha: 'campaign', conjunto: 'adset', anuncio: 'ad' };
    const n = traduz[nivel ?? 'campanha'];
    const min = minimo_compras ?? 0;
    const max = limite ?? 10;

    const todas = await desempenhoPorNivel(d, n);
    const elegiveis = todas.filter((l) => l.compras >= min);

    // Sem compra nenhuma, CPA é infinito e ROAS é zero — ordenar por eles
    // colocaria justamente as linhas sem informação no topo.
    const ordem = ordenar_por ?? 'gasto';
    const chave = (l: (typeof todas)[number]) =>
      ordem === 'cpa'
        ? l.compras > 0
          ? l.cpa
          : Number.POSITIVE_INFINITY
        : ordem === 'roas'
          ? -l.roas
          : ordem === 'compras'
            ? -l.compras
            : -l.gastoLiquido;

    const linhas = [...elegiveis].sort((a, b) => chave(a) - chave(b)).slice(0, max);

    const rotulo = { campaign: 'campanha', adset: 'conjunto', ad: 'anúncio' }[n];
    const texto = [
      `Desempenho por ${rotulo} em ${d} — ordenado por ${ordem}` +
        (min > 0 ? `, com pelo menos ${min} compra(s)` : ''),
      `${todas.length} ${rotulo}s com gasto no dia` +
        (min > 0 ? `, ${elegiveis.length} passaram no filtro` : ''),
      '',
    ];

    if (!linhas.length) {
      texto.push('Nenhuma linha atende ao filtro.');
    }

    for (const l of linhas) {
      texto.push(
        `${l.nome}${l.objetivo ? ` [${l.objetivo}]` : ''}`,
        `  pago ${dinheiro(l.valorPago)} (líq. ${dinheiro(l.gastoLiquido)}) · ` +
          `${numero(l.compras)} compra(s) · ${dinheiro(l.receita)} · ROAS ${numero(l.roas, 2)}`,
        `  CPA ${l.compras > 0 ? dinheiro(l.cpa) : '—'} · CPM ${dinheiro(l.cpm)} · CPC ${dinheiro(l.cpc)} (líquidos)`,
        '',
      );
    }

    const semCompra = todas.filter((l) => l.compras === 0);
    if (semCompra.length) {
      const gasto = semCompra.reduce((s, l) => s + l.valorPago, 0);
      texto.push(
        `${semCompra.length} ${rotulo}(s) gastaram ${dinheiro(gasto)} sem nenhuma compra atribuída no dia.`,
      );
    }

    return { content: [{ type: 'text', text: texto.join('\n') }] };
  },
);

server.tool(
  'midia_google_do_dia',
  [
    'Gasto, vendas, ROAS, CPC e CPM no Google Ads em um dia.',
    'Sem imposto: o valor da API do Google já é o cobrado, diferente do Meta.',
    'A receita é a atribuição do Google, que conta a conversão no dia do clique e não no dia',
    'do pagamento — por isso ela não bate com o faturamento do Shopify, e não deveria bater.',
  ].join(' '),
  { dia: diaSchema },
  async ({ dia }) => {
    const d = dia ?? ontem();

    if (!temGoogleAds()) {
      return {
        content: [{ type: 'text', text: 'Google Ads não está configurado neste ambiente.' }],
      };
    }

    const g = await midiaGoogleDoDia(d);

    return {
      content: [
        {
          type: 'text',
          text: [
            `Google Ads em ${d}`,
            `Gasto: ${dinheiro(g.valorPago)} (sem imposto, por definição)`,
            `Vendas atribuídas: ${dinheiro(g.receita)} em ${numero(g.conversoes, 2)} conversões`,
            `ROAS: ${numero(g.roas, 2)}`,
            `${numero(g.cliques)} cliques · CPC ${dinheiro(g.cpc)} · CPM ${dinheiro(g.cpm)}`,
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

/* ------------------------------------------------------------------ *
 * Estornos
 * ------------------------------------------------------------------ */

server.tool(
  'estornos_do_dia',
  [
    'Reembolsos processados na Shopify num dia: quantidade, valor total e os maiores.',
    'É o dinheiro que efetivamente saiu, e não o que o Troquecommerce marcou como finalizado —',
    'reversa finalizada lá não garante saída aqui, e a diferença entre os dois lados costuma existir.',
  ].join(' '),
  { dia: diaSchema },
  async ({ dia }) => {
    const d = dia ?? ontem();
    const e = await estornosDoDia(d);

    const linhas = [
      `Reembolsos da Shopify em ${d}`,
      `${numero(e.quantidade)} reembolso(s) · ${dinheiro(e.valor)}`,
    ];

    if (e.lista.length) {
      linhas.push('', 'Maiores do dia:');
      for (const x of e.lista.slice(0, 10)) {
        linhas.push(`  ${x.pedido} — ${dinheiro(x.valor)}`);
      }
    }

    return { content: [{ type: 'text', text: linhas.join('\n') }] };
  },
);

/* ------------------------------------------------------------------ */

const transport = new StdioServerTransport();
await server.connect(transport);
