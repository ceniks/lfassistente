import { z } from 'zod';

/**
 * Configuração do assistente.
 *
 * Duas camadas, de propósito:
 *
 *  - `config()` lê o que existe e não reclama do que falta. É o que os módulos
 *    usam, e é o que permite testar uma integração de cada vez enquanto as
 *    outras credenciais ainda não chegaram.
 *  - `exigirConfigCompleta()` valida o conjunto obrigatório e é chamada uma vez,
 *    no boot do servidor. Melhor não subir do que subir e falhar às 8h da manhã
 *    sem ninguém olhando.
 */

/** Variável vazia no .env significa "não configurada", não "valor inválido". */
const vazioViraUndefined = (v: unknown) =>
  typeof v === 'string' && v.trim() === '' ? undefined : v;

const opcional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(vazioViraUndefined, schema.optional());

const url = () => z.string().url();

const schema = z.object({
  // --- WhatsApp / Evolution API ---
  EVOLUTION_URL: opcional(url()),
  EVOLUTION_API_KEY: opcional(z.string()),
  EVOLUTION_INSTANCE: opcional(z.string()),
  /** Número que recebe o resumo e é o único autorizado a conversar. Ex: 5511999999999 */
  OWNER_PHONE: opcional(
    z.string().regex(/^\d{12,13}$/, 'use só dígitos, com DDI: 5511999999999'),
  ),

  // --- Claude ---
  ANTHROPIC_API_KEY: opcional(z.string()),
  CLAUDE_MODEL: z.string().default('claude-sonnet-5'),

  // --- Shopify ---
  SHOPIFY_SHOP: opcional(z.string()),
  SHOPIFY_ADMIN_TOKEN: opcional(z.string()),
  SHOPIFY_API_VERSION: z.string().default('2026-07'),

  // --- Meta Ads ---
  META_SYSTEM_TOKEN: opcional(z.string()),
  /** Contas que consolidam no resumo. Hoje só a L&F01 gasta. */
  META_AD_ACCOUNT_IDS: z
    .string()
    .default('2384690018414844')
    .transform((s) => s.split(',').map((v) => v.trim()).filter(Boolean)),
  /**
   * Gross-up de imposto do Meta. Medido na fatura: R$ 32.221,01 de mídia com
   * R$ 4.456,28 de imposto = 13,8304%.
   *
   * Aplica-se SOMENTE ao valor pago e ao ROAS. CPM, CPC e CPA ficam sobre o
   * gasto líquido, para continuarem comparáveis com benchmark de leilão e com o
   * histórico. E vale só para o Meta — no Google o valor da API já é o pago.
   */
  META_TAX_FACTOR: z.coerce.number().min(1).default(1.138304),
  WABA_ID: opcional(z.string()),

  // --- Google Ads ---
  GOOGLE_ADS_CUSTOMER_ID: opcional(z.string()),
  GOOGLE_ADS_DEVELOPER_TOKEN: opcional(z.string()),
  GOOGLE_ADS_REFRESH_TOKEN: opcional(z.string()),
  GOOGLE_ADS_CLIENT_ID: opcional(z.string()),
  GOOGLE_ADS_CLIENT_SECRET: opcional(z.string()),

  // --- Metas (Google Sheets via service account) ---
  GOOGLE_SERVICE_ACCOUNT_JSON: opcional(z.string()),
  METAS_SPREADSHEET_ID: opcional(z.string()),
  METAS_RANGE: z.string().default('Metas!A:B'),

  // --- MCPs próprios ---
  ATENDEPRO_MCP_URL: opcional(url()),
  ATENDEPRO_TOKEN: opcional(z.string()),
  CORTEPRO_MCP_URL: opcional(url()),
  CORTEPRO_TOKEN: opcional(z.string()),

  // --- Runtime ---
  PORT: z.coerce.number().default(3000),
  TZ: z.string().default('America/Sao_Paulo'),
  /** Hora do resumo, no fuso acima. */
  DIGEST_CRON: z.string().default('0 8 * * *'),
  NODE_ENV: z.enum(['development', 'production']).default('production'),
});

export type Config = z.infer<typeof schema>;

let cached: Config | null = null;

export function config(): Config {
  if (cached) return cached;

  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const problemas = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuração inválida:\n${problemas}`);
  }

  cached = parsed.data;
  return cached;
}

/**
 * O que precisa existir para o assistente subir de verdade.
 *
 * Chamada só pelo `index.ts`. As CLIs de diagnóstico e de resumo funcionam com
 * configuração parcial — é o ponto delas.
 */
const OBRIGATORIAS = [
  'EVOLUTION_URL',
  'EVOLUTION_API_KEY',
  'EVOLUTION_INSTANCE',
  'OWNER_PHONE',
  'ANTHROPIC_API_KEY',
  'SHOPIFY_SHOP',
  'SHOPIFY_ADMIN_TOKEN',
  'META_SYSTEM_TOKEN',
] as const satisfies ReadonlyArray<keyof Config>;

export function exigirConfigCompleta(): Config {
  const c = config();
  const faltando = OBRIGATORIAS.filter((k) => !c[k]);

  if (faltando.length) {
    throw new Error(
      `Faltam variáveis obrigatórias no ambiente:\n${faltando.map((k) => `  ${k}`).join('\n')}\n\n` +
        'Preencha o .env (veja o .env.example) ou as variáveis do Railway.',
    );
  }

  return c;
}

/**
 * Lê uma variável que aquele trecho de código não consegue dispensar.
 *
 * Erra com o nome da variável em vez de deixar `undefined` viajar até virar um
 * 401 obscuro três chamadas adiante.
 */
export function exigir<K extends keyof Config>(chave: K): NonNullable<Config[K]> {
  const valor = config()[chave];
  if (valor === undefined || valor === '') {
    throw new Error(
      `${String(chave)} não está configurada. Preencha no .env (veja o .env.example) ou nas variáveis do Railway.`,
    );
  }
  return valor as NonNullable<Config[K]>;
}

/** Diz se uma integração tem o mínimo para ser tentada. */
export function temShopify(): boolean {
  const c = config();
  return Boolean(c.SHOPIFY_SHOP && c.SHOPIFY_ADMIN_TOKEN);
}

export function temMeta(): boolean {
  return Boolean(config().META_SYSTEM_TOKEN);
}

/** JID do dono, no formato que a Evolution usa. */
export function ownerJid(): string {
  const telefone = config().OWNER_PHONE;
  if (!telefone) throw new Error('OWNER_PHONE não configurado');
  return `${telefone}@s.whatsapp.net`;
}
