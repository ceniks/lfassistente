import { config, exigir } from '../config.js';

/**
 * Google Ads.
 *
 * Três diferenças em relação ao Meta que valem ficar registradas, porque as três
 * já causaram confusão:
 *
 *  1. Não tem imposto. O `cost_micros` que a API devolve é o valor cobrado —
 *     não se aplica o gross-up que o Meta exige. Foi decisão explícita do Luis.
 *  2. Não existe escopo de leitura. O Google Ads tem um escopo só
 *     (`.../auth/adwords`), tudo-ou-nada. Quem limita de verdade é a permissão
 *     do usuário dentro da conta de anúncios — se um dia quisermos um token
 *     realmente só-leitura, é trocar o usuário que autoriza, não o código.
 *  3. O developer token morreu em 09/09/2026. O acesso passou a ser
 *     determinado pelo projeto do Google Cloud dono do client OAuth. Mandar o
 *     header hoje é inofensivo e ignorado; em versões futuras passa a ser
 *     rejeitado. Por isso não mandamos.
 */

const OAUTH = 'https://oauth2.googleapis.com/token';

/* ------------------------------------------------------------------ *
 * Token
 * ------------------------------------------------------------------ */

let cache: { token: string; expiraEm: number } | null = null;

/**
 * Troca o refresh token por um access token de uma hora.
 *
 * O refresh token não expira — é a credencial que o `npm run google-oauth`
 * gerou uma vez. Guardamos o access token com margem de 5 minutos para nunca
 * usar um que vence no meio da chamada.
 */
async function accessToken(): Promise<string> {
  if (cache && Date.now() < cache.expiraEm) return cache.token;

  const res = await fetch(OAUTH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: exigir('GOOGLE_ADS_CLIENT_ID'),
      client_secret: exigir('GOOGLE_ADS_CLIENT_SECRET'),
      refresh_token: exigir('GOOGLE_ADS_REFRESH_TOKEN'),
      grant_type: 'refresh_token',
    }),
  });

  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!res.ok || !json.access_token) {
    // `invalid_grant` é o erro que mais aparece e o menos explicativo: quase
    // sempre é o refresh token revogado (troca de senha, app republicado, ou
    // 7 dias de app em modo de teste) e a solução é rodar o OAuth de novo.
    const dica =
      json.error === 'invalid_grant'
        ? ' — o refresh token foi revogado. Rode `npm run google-oauth` de novo.'
        : '';
    throw new Error(
      `Google OAuth ${res.status}: ${json.error_description ?? json.error ?? 'sem detalhe'}${dica}`,
    );
  }

  cache = {
    token: json.access_token,
    expiraEm: Date.now() + ((json.expires_in ?? 3600) - 300) * 1000,
  };

  return cache.token;
}

/* ------------------------------------------------------------------ *
 * Consulta
 * ------------------------------------------------------------------ */

interface LinhaGoogleAds {
  metrics?: {
    costMicros?: string;
    conversionsValue?: number;
    conversions?: number;
    clicks?: string;
    impressions?: string;
  };
}

/**
 * Roda uma consulta GAQL e devolve todas as linhas.
 *
 * O endpoint pagina; para consultas agregadas (FROM customer) vem uma linha só,
 * mas a paginação fica aqui para quando quisermos nível de campanha ou anúncio.
 */
async function consultar(gaql: string): Promise<LinhaGoogleAds[]> {
  const c = config();
  const cliente = exigir('GOOGLE_ADS_CUSTOMER_ID');
  const url = `https://googleads.googleapis.com/${c.GOOGLE_ADS_API_VERSION}/customers/${cliente}/googleAds:search`;

  const cabecalhos: Record<string, string> = {
    Authorization: `Bearer ${await accessToken()}`,
    'Content-Type': 'application/json',
  };

  // Só quando a conta está sob uma MCC. Fora disso, mandar atrapalha.
  if (c.GOOGLE_ADS_LOGIN_CUSTOMER_ID) {
    cabecalhos['login-customer-id'] = c.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  }

  const linhas: LinhaGoogleAds[] = [];
  let pagina: string | undefined;

  do {
    const res = await fetch(url, {
      method: 'POST',
      headers: cabecalhos,
      body: JSON.stringify(pagina ? { query: gaql, pageToken: pagina } : { query: gaql }),
    });

    const texto = await res.text();
    if (!res.ok) throw new Error(explicarErro(res.status, texto));

    const json = JSON.parse(texto) as {
      results?: LinhaGoogleAds[];
      nextPageToken?: string;
    };

    linhas.push(...(json.results ?? []));
    pagina = json.nextPageToken;
  } while (pagina);

  return linhas;
}

/**
 * Traduz o erro para o que fazer a respeito.
 *
 * O corpo de erro do Google Ads é longo e enterra o que importa. Sem isto, um
 * projeto sem acesso liberado aparece como um bloco de JSON de 2 KB no log das
 * 8h da manhã.
 */
function explicarErro(status: number, corpo: string): string {
  const resumo = corpo.slice(0, 400);

  if (/DEVELOPER_TOKEN|NOT_ADS_USER|CUSTOMER_NOT_ENABLED/i.test(corpo)) {
    return (
      `Google Ads ${status}: a conta não aceitou a credencial.\n` +
      '  Confira se o projeto do Cloud tem acesso liberado em ' +
      '"Google Ads API" no Cloud Console (o developer token não vale mais desde 09/09/2026).\n' +
      `  Resposta: ${resumo}`
    );
  }

  if (/USER_PERMISSION_DENIED|PERMISSION_DENIED/i.test(corpo)) {
    return (
      `Google Ads ${status}: a conta que autorizou não tem acesso ao cliente ` +
      `${config().GOOGLE_ADS_CUSTOMER_ID}.\n` +
      '  Se a conta está sob uma MCC, preencha GOOGLE_ADS_LOGIN_CUSTOMER_ID com o ID da gerenciadora.\n' +
      `  Resposta: ${resumo}`
    );
  }

  if (status === 404) {
    return (
      `Google Ads ${status}: versão ${config().GOOGLE_ADS_API_VERSION} não existe mais ou o ` +
      'customer ID está errado.\n' +
      '  A v22 foi descontinuada em setembro de 2026; ajuste GOOGLE_ADS_API_VERSION.\n' +
      `  Resposta: ${resumo}`
    );
  }

  return `Google Ads ${status}: ${resumo}`;
}

/* ------------------------------------------------------------------ *
 * Mídia do dia
 * ------------------------------------------------------------------ */

export interface MidiaGoogle {
  /** O que o Google cobrou. Sem gross-up: aqui não entra imposto. */
  valorPago: number;
  /** Receita atribuída pelo Google, na janela de conversão dele. */
  receita: number;
  roas: number;
  conversoes: number;
  cliques: number;
  impressoes: number;
  cpc: number;
  cpm: number;
}

const num = (v?: string | number) => Number(v ?? 0);

/**
 * Gasto, vendas e ROAS do dia.
 *
 * `FROM customer` agrega a conta inteira numa linha só — é o equivalente ao
 * `level: 'account'` do Meta. A data é a do fuso configurado NA conta do Google
 * Ads, não o nosso: se um dia a conta estiver em outro fuso, o dia sai
 * deslocado e é lá que se corrige.
 *
 * A receita é a atribuição do Google, que conta conversões no dia do clique,
 * não no dia da compra. Não vai bater com o faturamento do Shopify, e não
 * deveria — são perguntas diferentes.
 */
/**
 * Por que a última leitura falhou, em uma linha — ou `null` se não falhou.
 *
 * Existe porque o boletim dizia "Google: não conectado" tanto quando não havia
 * credencial quanto quando havia e ela tinha expirado. Em 20/09 era o segundo
 * caso, e a frase mandava procurar o problema no lugar errado.
 */
export let ultimaFalhaGoogle: string | null = null;

export async function midiaGoogleDoDia(dia: string): Promise<MidiaGoogle> {
  try {
    const r = await lerMidiaGoogle(dia);
    ultimaFalhaGoogle = null;
    return r;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ultimaFalhaGoogle = /expired or revoked|invalid_grant|revogado/i.test(msg)
      ? "autorização do Google expirou — refazer com npm run google-oauth"
      : msg.split("\n")[0].slice(0, 120);
    throw e;
  }
}

async function lerMidiaGoogle(dia: string): Promise<MidiaGoogle> {
  const linhas = await consultar(
    `SELECT metrics.cost_micros,
            metrics.conversions_value,
            metrics.conversions,
            metrics.clicks,
            metrics.impressions
     FROM customer
     WHERE segments.date = '${dia}'`,
  );

  let valorPago = 0;
  let receita = 0;
  let conversoes = 0;
  let cliques = 0;
  let impressoes = 0;

  for (const l of linhas) {
    // Micros: a API devolve o custo multiplicado por um milhão para não usar
    // ponto flutuante em dinheiro.
    valorPago += num(l.metrics?.costMicros) / 1_000_000;
    receita += num(l.metrics?.conversionsValue);
    conversoes += num(l.metrics?.conversions);
    cliques += num(l.metrics?.clicks);
    impressoes += num(l.metrics?.impressions);
  }

  return {
    valorPago,
    receita,
    roas: valorPago > 0 ? receita / valorPago : 0,
    conversoes,
    cliques,
    impressoes,
    cpc: cliques > 0 ? valorPago / cliques : 0,
    cpm: impressoes > 0 ? (valorPago / impressoes) * 1000 : 0,
  };
}

/** Diz se dá para tentar o Google, sem estourar erro quando não dá. */
export function temGoogleAds(): boolean {
  const c = config();
  return Boolean(
    c.GOOGLE_ADS_CUSTOMER_ID &&
      c.GOOGLE_ADS_CLIENT_ID &&
      c.GOOGLE_ADS_CLIENT_SECRET &&
      c.GOOGLE_ADS_REFRESH_TOKEN,
  );
}

/** Nome e fuso da conta — serve para confirmar que autorizamos a conta certa. */
export async function contaGoogle(): Promise<{ nome: string; fuso: string; moeda: string }> {
  const linhas = (await consultar(
    'SELECT customer.descriptive_name, customer.time_zone, customer.currency_code FROM customer',
  )) as Array<{
    customer?: { descriptiveName?: string; timeZone?: string; currencyCode?: string };
  }>;

  const c = linhas[0]?.customer;
  return {
    nome: c?.descriptiveName ?? '(sem nome)',
    fuso: c?.timeZone ?? '(desconhecido)',
    moeda: c?.currencyCode ?? '(desconhecida)',
  };
}
