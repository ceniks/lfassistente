import { config, exigir } from '../config.js';

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
  const params = new URLSearchParams({
    access_token: exigir('META_SYSTEM_TOKEN'),
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
  const { META_AD_ACCOUNT_IDS } = config();

  let impressoes = 0;
  let cliques = 0;
  let gasto = 0;

  for (const conta of META_AD_ACCOUNT_IDS) {
    const params = new URLSearchParams({
      access_token: exigir('META_SYSTEM_TOKEN'),
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
 * Desempenho por campanha, conjunto ou anúncio
 * ------------------------------------------------------------------ */

export type Nivel = 'campaign' | 'adset' | 'ad';

export interface LinhaMidia {
  id: string;
  nome: string;
  /** Objetivo da campanha. Só vem preenchido no nível de campanha. */
  objetivo?: string;
  gastoLiquido: number;
  valorPago: number;
  compras: number;
  receita: number;
  /** Sobre o valor pago, como em todo ROAS daqui. */
  roas: number;
  /** Sobre o gasto líquido, para comparar com leilão e histórico. */
  cpa: number;
  cpm: number;
  cpc: number;
  cliques: number;
  impressoes: number;
}

const NIVEL_CAMPO: Record<Nivel, string> = {
  campaign: 'campaign_id,campaign_name,objective',
  adset: 'adset_id,adset_name',
  ad: 'ad_id,ad_name',
};

/**
 * Uma linha por campanha, conjunto ou anúncio no dia.
 *
 * O cuidado que este código carrega e que a pergunta "qual campanha teve o
 * melhor CPA?" esconde: num dia, boa parte das campanhas tem uma ou duas
 * compras. Uma campanha que gastou R$ 40 e vendeu uma peça tem CPA de R$ 40 e
 * ganha de todas — sem significar nada. Por isso a linha sempre carrega gasto e
 * número de compras junto, e quem consome filtra por volume mínimo antes de
 * coroar alguém.
 */
export async function desempenhoPorNivel(dia: string, nivel: Nivel): Promise<LinhaMidia[]> {
  const { META_AD_ACCOUNT_IDS, META_TAX_FACTOR } = config();
  const saida: LinhaMidia[] = [];

  for (const conta of META_AD_ACCOUNT_IDS) {
    let url: string | null =
      `${GRAPH}/act_${conta}/insights?` +
      new URLSearchParams({
        access_token: exigir('META_SYSTEM_TOKEN'),
        time_range: JSON.stringify({ since: dia, until: dia }),
        fields: `${NIVEL_CAMPO[nivel]},spend,impressions,clicks,actions,action_values`,
        level: nivel,
        limit: '200',
      });

    while (url) {
      const res: Response = await fetch(url);
      if (!res.ok) throw new Error(`Meta ${res.status}: ${await res.text()}`);

      const json = (await res.json()) as {
        data?: Array<Record<string, unknown>>;
        paging?: { next?: string };
      };

      for (const row of json.data ?? []) {
        const gasto = n(row.spend as string | undefined);
        const acoes = (row.actions ?? []) as Array<{ action_type: string; value: string }>;
        const valores = (row.action_values ?? []) as Array<{ action_type: string; value: string }>;

        const compra = (xs: Array<{ action_type: string; value: string }>) =>
          n(xs.find((x) => x.action_type === 'omni_purchase' || x.action_type === 'purchase')?.value);

        const compras = compra(acoes);
        const receita = compra(valores);
        const cliques = n(row.clicks as string | undefined);
        const impressoes = n(row.impressions as string | undefined);
        const valorPago = gasto * META_TAX_FACTOR;

        saida.push({
          id: String(row[`${nivel}_id`] ?? ''),
          nome: String(row[`${nivel}_name`] ?? '(sem nome)'),
          objetivo: row.objective ? String(row.objective) : undefined,
          gastoLiquido: gasto,
          valorPago,
          compras,
          receita,
          roas: valorPago > 0 ? receita / valorPago : 0,
          cpa: compras > 0 ? gasto / compras : 0,
          cpm: impressoes > 0 ? (gasto / impressoes) * 1000 : 0,
          cpc: cliques > 0 ? gasto / cliques : 0,
          cliques,
          impressoes,
        });
      }

      url = json.paging?.next ?? null;
    }
  }

  return saida.filter((l) => l.gastoLiquido > 0).sort((a, b) => b.gastoLiquido - a.gastoLiquido);
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
 * Token do WhatsApp, que não é o mesmo dos anúncios.
 *
 * O WhatsApp da L&F está no portfólio "L&F Alfaiataria" e os anúncios em outro.
 * Token de usuário do sistema não atravessa portfólio, então são dois.
 */
function tokenWhatsapp(): string {
  const c = config();
  const t = c.META_WHATSAPP_TOKEN ?? c.META_SYSTEM_TOKEN;
  if (!t) {
    throw new Error(
      'META_WHATSAPP_TOKEN não configurado. Gere um token de usuário do sistema no ' +
        'portfólio dono do WhatsApp, com a permissão whatsapp_business_management.',
    );
  }
  return t;
}

export interface Template {
  id: string;
  nome: string;
  status: string;
  categoria: string;
}

/** Templates de uma conta do WhatsApp. Serve para casar nome com id. */
export async function templatesDaConta(waba: string): Promise<Template[]> {
  const saida: Template[] = [];
  let url: string | null =
    `${GRAPH}/${waba}/message_templates?limit=200&fields=id,name,status,category` +
    `&access_token=${tokenWhatsapp()}`;

  while (url) {
    const res: Response = await fetch(url);
    if (!res.ok) throw new Error(`Meta ${res.status}: ${(await res.text()).slice(0, 300)}`);

    const json = (await res.json()) as {
      data?: Array<{ id: string; name: string; status: string; category: string }>;
      paging?: { next?: string };
    };

    for (const t of json.data ?? []) {
      saida.push({ id: t.id, nome: t.name, status: t.status, categoria: t.category });
    }
    url = json.paging?.next ?? null;
  }

  return saida;
}

/**
 * Contas do WhatsApp que o token enxerga.
 *
 * Existe porque a L&F tem sete WABAs no portfólio e o nome não distingue — são
 * quase todas "LF Fashion". Descobrir qual é a certa pelo painel é chute;
 * descobrir pelos templates que ela hospeda é determinístico.
 */
export async function contasDeWhatsapp(): Promise<Array<{ id: string; nome: string }>> {
  const token = tokenWhatsapp();
  const saida: Array<{ id: string; nome: string }> = [];

  // `/me/businesses` funciona para token de usuário PESSOA e devolve lista
  // vazia — sem erro — para token de usuário do SISTEMA, que é o nosso caso.
  // Um 200 com data vazia parece "não há nada" e na verdade é "pergunta
  // errada". Por isso o META_BUSINESS_ID existe.
  const negocios = await fetch(
    `${GRAPH}/me/businesses?fields=id,name&limit=50&access_token=${token}`,
  );

  const js = negocios.ok
    ? ((await negocios.json()) as { data?: Array<{ id: string; name: string }> })
    : { data: [] };

  let portfolios = js.data ?? [];

  if (!portfolios.length) {
    const id = config().META_BUSINESS_ID;
    if (!id) {
      throw new Error(
        'nenhum portfólio visível para este token, e META_BUSINESS_ID não está configurado.\n' +
          '  Token de usuário do sistema não aparece em /me/businesses — o ID precisa ser explícito.\n' +
          '  Pegue na URL das Configurações do Business (business_id=...).',
      );
    }
    const r = await fetch(`${GRAPH}/${id}?fields=id,name&access_token=${token}`);
    if (!r.ok) {
      throw new Error(
        `não consegui ler o portfólio ${id} (${r.status}). ` +
          'O token precisa de business_management e whatsapp_business_management.',
      );
    }
    portfolios = [(await r.json()) as { id: string; name: string }];
  }

  for (const b of portfolios) {
    for (const campo of ['owned_whatsapp_business_accounts', 'client_whatsapp_business_accounts']) {
      const r = await fetch(
        `${GRAPH}/${b.id}/${campo}?fields=id,name&limit=50&access_token=${token}`,
      );
      if (!r.ok) continue;
      const j = (await r.json()) as { data?: Array<{ id: string; name: string }> };
      for (const w of j.data ?? []) {
        if (!saida.some((x) => x.id === w.id)) saida.push({ id: w.id, nome: `${w.name} (${b.name})` });
      }
    }
  }

  return saida;
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
  const { WABA_ID } = config();
  if (!WABA_ID || templateIds.length === 0) return [];

  const lotes: string[][] = [];
  for (let i = 0; i < templateIds.length; i += 10) lotes.push(templateIds.slice(i, i + 10));

  const saida: FluxoTemplate[] = [];

  // A janela é semiaberta: `start` entra, `end` não. Mandar o mesmo dia nos dois
  // devolve 200 com todos os contadores zerados — silêncio que parece "não houve
  // envio" e na verdade é "intervalo de duração zero".
  const seguinte = new Date(`${dia}T12:00:00Z`);
  seguinte.setUTCDate(seguinte.getUTCDate() + 1);
  const fim = seguinte.toISOString().slice(0, 10);

  for (const lote of lotes) {
    const params = new URLSearchParams({
      access_token: tokenWhatsapp(),
      start: dia,
      end: fim,
      granularity: 'DAILY',
      template_ids: JSON.stringify(lote),
      metric_types: JSON.stringify(['SENT', 'DELIVERED', 'READ']),
    });

    const res = await fetch(`${GRAPH}/${WABA_ID}/template_analytics?${params}`);
    if (!res.ok) {
      // Engolir o erro aqui faz um dia sem dados parecer um dia sem envio.
      throw new Error(
        `template_analytics ${res.status}: ${(await res.text()).slice(0, 300)}`,
      );
    }

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

/* ------------------------------------------------------------------ *
 * Saúde da conta de anúncios
 * ------------------------------------------------------------------ */

/**
 * Estados possíveis de uma conta de anúncios.
 *
 * O que interessa aqui não é a taxonomia da Meta, e sim a distinção prática:
 * a conta está veiculando, está prestes a parar, ou já parou?
 */
const ESTADOS: Record<number, { nome: string; gravidade: 'ok' | 'atencao' | 'critico' }> = {
  1: { nome: 'ativa', gravidade: 'ok' },
  2: { nome: 'desativada', gravidade: 'critico' },
  3: { nome: 'fatura em aberto', gravidade: 'critico' },
  7: { nome: 'em análise de risco', gravidade: 'atencao' },
  8: { nome: 'aguardando liquidação', gravidade: 'atencao' },
  9: { nome: 'período de tolerância (cobrança pendente)', gravidade: 'atencao' },
  100: { nome: 'encerramento pendente', gravidade: 'critico' },
  101: { nome: 'encerrada', gravidade: 'critico' },
};

export interface SaudeConta {
  id: string;
  nome: string;
  estado: string;
  gravidade: 'ok' | 'atencao' | 'critico' | 'desconhecido';
  motivoDesativacao?: string;
  /** Saldo devedor, quando a Meta informa. */
  valorEmAberto?: number;
  moeda?: string;
}

/**
 * Estado de cobrança das contas configuradas.
 *
 * Vale checar com frequência, não só às 8h: uma conta que entra em
 * `período de tolerância` ainda veicula, mas se ninguém liquidar a fatura ela
 * é suspensa — e aí a mídia para inteira, sem aviso. Em 13/09/2026 a L&F01,
 * única conta que gasta, estava exatamente nesse estado.
 */
export async function saudeDasContas(): Promise<SaudeConta[]> {
  const { META_AD_ACCOUNT_IDS } = config();
  const token = exigir('META_SYSTEM_TOKEN');

  const saida: SaudeConta[] = [];

  for (const conta of META_AD_ACCOUNT_IDS) {
    const params = new URLSearchParams({
      access_token: token,
      fields: 'name,account_status,disable_reason,balance,currency',
    });

    const res = await fetch(`${GRAPH}/act_${conta}?${params}`);
    if (!res.ok) {
      saida.push({
        id: conta,
        nome: conta,
        estado: `não consegui consultar (${res.status})`,
        gravidade: 'desconhecido',
      });
      continue;
    }

    const j = (await res.json()) as {
      name?: string;
      account_status?: number;
      disable_reason?: number;
      balance?: string;
      currency?: string;
    };

    const estado = ESTADOS[j.account_status ?? -1];

    saida.push({
      id: conta,
      nome: j.name ?? conta,
      estado: estado?.nome ?? `código ${j.account_status}`,
      gravidade: estado?.gravidade ?? 'desconhecido',
      // A Meta devolve o saldo em centavos.
      valorEmAberto: j.balance ? Number(j.balance) / 100 : undefined,
      moeda: j.currency,
    });
  }

  return saida;
}

/** Só o que não está bem — é isso que vira alerta. */
export async function contasComProblema(): Promise<SaudeConta[]> {
  return (await saudeDasContas()).filter((c) => c.gravidade !== 'ok');
}
