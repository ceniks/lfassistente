import type { ResumoVendas, Trafego } from '../data/shopify.js';
import type { MidiaMeta, FluxoTemplate } from '../data/meta.js';
import type { Producao } from '../data/producao.js';
import type { Atendimento } from '../data/atendimento.js';

/* ------------------------------------------------------------------ *
 * Formatadores
 * ------------------------------------------------------------------ */

const brl = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  maximumFractionDigits: 0,
});

const brlCentavos = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  minimumFractionDigits: 2,
});

export const dinheiro = (v: number) => brl.format(v);
export const dinheiroExato = (v: number) => brlCentavos.format(v);

export const pct = (v: number, casas = 1) =>
  `${(v * 100).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas })}%`;

export const numero = (v: number, casas = 0) =>
  v.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });

/** Variação relativa, com sinal. Devolve string vazia se a base for zero. */
export function variacao(atual: number, base: number): string {
  if (!base) return '';
  const d = (atual - base) / base;
  const sinal = d >= 0 ? '+' : '';
  return `${sinal}${(d * 100).toLocaleString('pt-BR', { maximumFractionDigits: 0 })}%`;
}

const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

export function dataPorExtenso(dia: string): string {
  const [a, m, d] = dia.split('-').map(Number);
  const date = new Date(Date.UTC(a, m - 1, d));
  return `${DIAS[date.getUTCDay()]}, ${String(d).padStart(2, '0')}/${MESES[m - 1]}`;
}

/* ------------------------------------------------------------------ *
 * O resumo
 * ------------------------------------------------------------------ */

export interface DadosResumo {
  dia: string;
  vendas: ResumoVendas;
  vendasMedia7d: Pick<ResumoVendas, 'receita' | 'pedidos' | 'ticketMedio'> & {
    descontoPct: number;
  };
  trafego: Trafego;
  trafegoMedia7d: Pick<Trafego, 'sessoes' | 'taxaAdicao' | 'conversao'>;
  meta: number | null;
  midia: MidiaMeta;
  google?: { valorPago: number; receita: number; roas: number } | null;
  fluxos: FluxoTemplate[];
  producao?: Producao | null;
  atendimento?: Atendimento | null;
  /** Uma ou duas frases escritas pelo agente lendo os números acima. */
  leitura?: string;
}

export function montarResumo(d: DadosResumo): string {
  const b: string[] = [];

  b.push(`☀️ L&F · ${dataPorExtenso(d.dia)}`);

  // --- Faturamento ---
  const v = d.vendas;
  const linhas = [
    '',
    '💰 FATURAMENTO',
    `${dinheiro(v.receita)} · ${numero(v.pedidos)} pedidos pagos`,
  ];

  if (d.meta !== null) {
    const atingido = d.meta > 0 ? v.receita / d.meta : 0;
    const falta = d.meta - v.receita;
    linhas.push(
      falta > 0
        ? `Meta ${dinheiro(d.meta)} · ${pct(atingido, 0)} · faltou ${dinheiro(falta)}`
        : `Meta ${dinheiro(d.meta)} · ${pct(atingido, 0)} ✅ bateu`,
    );
  }

  const varReceita = variacao(v.receita, d.vendasMedia7d.receita);
  const varPedidos = variacao(v.pedidos, d.vendasMedia7d.pedidos);
  if (varReceita) linhas.push(`vs média 7d: ${varReceita} receita, ${varPedidos} pedidos`);
  linhas.push(`Ticket ${dinheiro(v.ticketMedio)} (7d: ${dinheiro(d.vendasMedia7d.ticketMedio)})`);

  if (v.excluidos.trocas || v.excluidos.influencers) {
    const fora: string[] = [];
    if (v.excluidos.trocas) fora.push(`${v.excluidos.trocas} troca(s)`);
    if (v.excluidos.influencers) fora.push(`${v.excluidos.influencers} influencer`);
    linhas.push(`Fora da conta: ${fora.join(' · ')}`);
  }
  b.push(linhas.join('\n'));

  // --- Desconto ---
  const bruto = v.receita + v.desconto.total;
  const desc = ['', '🏷️ DESCONTO'];
  desc.push(`${pct(bruto > 0 ? v.desconto.total / bruto : 0)} do bruto (7d: ${pct(d.vendasMedia7d.descontoPct)})`);
  desc.push(`Promoção automática ${dinheiro(v.desconto.promocaoAutomatica)}`);
  desc.push(`Cupom ${dinheiro(v.desconto.cupom)}`);
  desc.push(
    v.desconto.seedingInfluencer > 0
      ? `Seeding influencer ${dinheiro(v.desconto.seedingInfluencer)} · ${v.excluidos.influencers} pedidos`
      : 'Seeding influencer: nenhum no dia',
  );
  b.push(desc.join('\n'));

  // --- Top 5 ---
  if (v.topProdutos.length) {
    const top = ['', '🏆 TOP 5 · peças vendidas'];
    v.topProdutos.forEach((p, i) => {
      top.push(`${i + 1} ${p.titulo} — ${numero(p.pecas)} · ${dinheiro(p.receita)}`);
    });
    top.push(
      `${numero(v.pecas)} peças / ${numero(v.pedidos)} pedidos = ${numero(v.pecasPorPedido, 2)} por pedido`,
    );
    b.push(top.join('\n'));
  }

  // --- Tráfego ---
  const t = d.trafego;
  b.push(
    [
      '',
      '📊 TRÁFEGO',
      `${numero(t.sessoes)} sessões (7d: ${numero(d.trafegoMedia7d.sessoes)}) ${variacao(t.sessoes, d.trafegoMedia7d.sessoes)}`,
      `Adição ao carrinho ${pct(t.taxaAdicao, 2)} (7d: ${pct(d.trafegoMedia7d.taxaAdicao, 2)})`,
      `${numero(t.checkoutsIniciados)} checkouts · ${numero(t.checkoutsConcluidos)} concluídos`,
      `Conversão ${pct(t.conversao, 2)} (7d: ${pct(d.trafegoMedia7d.conversao, 2)}) ${variacao(t.conversao, d.trafegoMedia7d.conversao)}`,
    ].join('\n'),
  );

  // --- Mídia ---
  const m = d.midia;
  const mid = ['', '📣 MÍDIA'];
  mid.push(`Meta pago ${dinheiro(m.valorPago)} (líq. ${dinheiro(m.gastoLiquido)} + imposto)`);
  mid.push(`ROAS ${numero(m.roas, 2)} · ${numero(m.compras)} compras`);
  mid.push(`CPA ${dinheiro(m.cpa)} · CPM ${dinheiroExato(m.cpm)} · CPC ${dinheiroExato(m.cpc)} (líquidos)`);

  if (d.google) {
    mid.push(`Google pago ${dinheiro(d.google.valorPago)} · ROAS ${numero(d.google.roas, 2)}`);
  } else {
    mid.push('Google: não conectado');
  }

  const gastoTotal = m.valorPago + (d.google?.valorPago ?? 0);
  if (gastoTotal > 0) {
    mid.push(
      `MER real ${numero(v.receita / gastoTotal, 2)} · mídia = ${pct(gastoTotal / v.receita)} da receita`,
    );
  }
  b.push(mid.join('\n'));

  // --- Produção ---
  if (d.producao) {
    const pr = d.producao;
    const p = ['', '✂️ PRODUÇÃO'];
    p.push(`${numero(pr.naOficina)} cortes na oficina · ${numero(pr.atrasados)} atrasados`);
    if (pr.maisCritico) {
      const dias = pr.diasDeAtrasoDoMaisCritico;
      p.push(`Mais crítico: ${pr.maisCritico}${dias ? ` — ${numero(dias)} dias` : ''}`);
    }
    b.push(p.join('\n'));
  }

  // --- Atendimento ---
  if (d.atendimento) {
    const a = d.atendimento;
    const at = ['', '💬 FILA DE ATENDIMENTO'];
    at.push(
      `${numero(a.aguardando)} aguardando · ${a.porCanal.map((c) => `${c.total} ${c.canal}`).join(', ')}`,
    );
    if (a.porAtendente.length) {
      at.push(a.porAtendente.map((x) => `· ${x.nome}: ${x.total}`).join('\n'));
    }
    if (a.semAtendente > 0) at.push(`⚠️ ${a.semAtendente} sem atendente atribuído`);
    b.push(at.join('\n'));

    const fl = ['', '📨 FLUXOS DO DIA'];
    if (d.fluxos.length) {
      for (const f of d.fluxos) {
        fl.push(`${f.template}: ${numero(f.enviadas)} enviadas · ${numero(f.lidas)} lidas`);
      }
    }
    fl.push(`Carrinho abandonado: ${numero(a.carrinhosGerados)} gerados`);
    if (a.carrinhosComErro > 0) {
      const taxa = a.carrinhosGerados > 0 ? a.carrinhosComErro / a.carrinhosGerados : 0;
      fl.push(`⚠️ ${numero(a.carrinhosComErro)} disparos com erro (${pct(taxa, 0)})`);
    }
    if (a.npsSeteDias !== null) {
      fl.push(`NPS 7d: ${numero(a.npsSeteDias)} · ${numero(a.npsRespostas)} respostas`);
    }
    b.push(fl.join('\n'));
  }

  // --- Leitura do agente ---
  if (d.leitura) {
    b.push(['', '📌 O DIA EM UMA LINHA', d.leitura.trim()].join('\n'));
  }

  return b.join('\n');
}
