import { config } from '../config.js';

const GRAPH = 'https://graph.facebook.com/v25.0';

export interface MidiaMeta {
  /** Gasto de mídia como a API devolve — sem imposto. Base de CPM, CPC e CPA. */
  gastoLiquido: number;
  /** Valor efetivamente pago: gasto × fator de imposto. Base do ROAS. */
  valorPago: number;
  /** ROAS sobre o valor pago, não sobre o líquido. */
  roas: number;
  /** ROAS como o Meta reporta, sobre o gasto líquido. Vai junto para comparação. */
  roasMeta: number;
  compras: number;
  /** Custo por compra sobre o gasto LÍQUIDO — comparável com histórico e benchmark. */
  cpa: number;
  /** CPM e CPC também líquidos, e só de campanhas com objetivo de vendas. */
  cpm: number;
  cpc: number;
  receitaAtribuida: number;
}

interface InsightRow {
  spend?: string;
  purchase_roas?: Array<{ action_type: string; value: string }>;
  actions?: Array<{ action_type: string; value: string }>;
  cpm?: string;
  cpc?: string;
}

async function insights(
  contaId: string,
  dia: string,
  extra: Record<string, string> = {},
): Promise<InsightRow | null> {
  const { META_SYSTEM_TOKEN } = config();
  const params = new URLSearchParams({
    access_token: META_SYSTEM_TOKEN,
    time_range: JSON.stringify({ since: dia, until: dia }),
    fields: 'spend,purchase_roas,actions,cpm,cpc',
    level: 'account',
    ...extra,
  });

  const res = await fetch(`${GRAPH}/act_${contaId}/insights?${params}`);
  if (!res.ok) throw new Error(`Meta ${res.status}: ${await res.text()}`);

  const json = (await res.json()) as { data?: InsightRow[] };
  return json.data?.[0] ?? null;
}

const n = (v?: string) => Number(v ?? 0);

function compras(row: InsightRow): number {
  const a = row.actions?.find(
    (x) => x.action_type === 'omni_purchase' || x.action_type === 'purchase',
  );
  return n(a?.value);
}

function roasBruto(row: InsightRow): number {
  const r = row.purchase_roas?.find(
    (x) => x.action_type === 'omni_purchase' || x.action_type === 'purchase',
  );
  return n(r?.value);
}

/**
 * Consolida o gasto do dia nas contas configuradas.
 *
 * Em 13/set/2026 havia 12 contas no Business Manager e só a L&F01
 * (2384690018414844) gastava — as outras ficam fora por configuração, não por
 * código. Se uma segunda conta começar a gastar, é só adicioná-la à env.
 *
 * O CPM e o CPC vêm de uma segunda chamada, filtrada por campanhas com objetivo
 * de vendas. Misturar CPM de campanha de alcance com o de conversão polui a
 * série inteira e torna a comparação com o histórico inútil.
 */
export async function midiaDoDia(dia: string): Promise<MidiaMeta> {
  const { META_AD_ACCOUNT_IDS, META_TAX_FACTOR } = config();

  let gastoLiquido = 0;
  let totalCompras = 0;
  let receitaAtribuida = 0;

  for (const conta of META_AD_ACCOUNT_IDS) {
    const row = await insights(conta, dia);
    if (!row) continue;
    const gasto = n(row.spend);
    gastoLiquido += gasto;
    totalCompras += compras(row);
    receitaAtribuida += gasto * roasBruto(row);
  }

  // CPM e CPC só de campanhas de venda, e sobre o gasto líquido.
  const vendas = await custoDeLeilaoVendas(dia);

  const valorPago = gastoLiquido * META_TAX_FACTOR;

  return {
    gastoLiquido,
    valorPago,
    // ROAS sobre o que saiu do caixa. Em 12/09: 5,15 vira 4,52.
    roas: valorPago > 0 ? receitaAtribuida / valorPago : 0,
    roasMeta: gastoLiquido > 0 ? receitaAtribuida / gastoLiquido : 0,
    compras: totalCompras,
    cpa: totalCompras > 0 ? gastoLiquido / totalCompras : 0,
    cpm: vendas.cpm,
    cpc: vendas.cpc,
    receitaAtribuida,
  };
}

/** CPM e CPC médios ponderados das campanhas com objetivo OUTCOME_SALES. */
async function custoDeLeilaoVendas(dia: string): Promise<{ cpm: number; cpc: number }> {
  const { META_AD_ACCOUNT_IDS, META_SYSTEM_TOKEN } = config();

  let impressoes = 0;
  let cliques = 0;
  let gasto = 0;

  for (const conta of META_AD_ACCOUNT_IDS) {
    const params = new URLSearchParams({
      access_token: META_SYSTEM_TOKEN,
      time_range: JSON.stringify({ since: dia, until: dia }),
      fields: 'spend,impressions,clicks',
      level: 'campaign',
      filtering: JSON.stringify([
        { field: 'campaign.objective', operator: 'IN', value: ['OUTCOME_SALES'] },
      ]),
    });

    const res = await fetch(`${GRAPH}/act_${conta}/insights?${params}`);
    if (!res.ok) continue;

    const json = (await res.json()) as {
      data?: Array<{ spend?: string; impressions?: string; clicks?: string }>;
    };

    for (const row of json.data ?? []) {
      gasto += n(row.spend);
      impressoes += n(row.impressions);
      cliques += n(row.clicks);
    }
  }

  return {
    cpm: impressoes > 0 ? (gasto / impressoes) * 1000 : 0,
    cpc: cliques > 0 ? gasto / cliques : 0,
  };
}

/* ------------------------------------------------------------------ *
 * Mensagens de template enviadas no dia
 * ------------------------------------------------------------------ */

export interface FluxoTemplate {
  template: string;
  enviadas: number;
  entregues: number;
  lidas: number;
}

/**
 * Quantas mensagens de cada fluxo saíram no dia.
 *
 * A fonte é a Meta, não o AtendePro: a data do carrinho não é a data do envio.
 * Os carrinhos abandonados de sábado (12/09) foram disparados no domingo, então
 * contar pela data do carrinho daria o número errado.
 *
 * Limite da API: 10 template_ids por chamada. Com mais fluxos que isso,
 * quebramos em lotes.
 */
export async function fluxosDoDia(
  dia: string,
  templateIds: string[],
): Promise<FluxoTemplate[]> {
  const { WABA_ID, META_SYSTEM_TOKEN } = config();
  if (!WABA_ID || templateIds.length === 0) return [];

  const lotes: string[][] = [];
  for (let i = 0; i < templateIds.length; i += 10) lotes.push(templateIds.slice(i, i + 10));

  const saida: FluxoTemplate[] = [];

  for (const lote of lotes) {
    const params = new URLSearchParams({
      access_token: META_SYSTEM_TOKEN,
      start: dia,
      end: dia,
      granularity: 'DAILY',
      template_ids: JSON.stringify(lote),
      metric_types: JSON.stringify(['SENT', 'DELIVERED', 'READ']),
    });

    const res = await fetch(`${GRAPH}/${WABA_ID}/template_analytics?${params}`);
    if (!res.ok) continue;

    const json = (await res.json()) as {
      data?: Array<{
        data_points?: Array<{
          template_id: string;
          sent?: number;
          delivered?: number;
          read?: number;
        }>;
      }>;
    };

    for (const bloco of json.data ?? []) {
      for (const ponto of bloco.data_points ?? []) {
        saida.push({
          template: ponto.template_id,
          enviadas: ponto.sent ?? 0,
          entregues: ponto.delivered ?? 0,
          lidas: ponto.read ?? 0,
        });
      }
    }
  }

  return saida;
}
