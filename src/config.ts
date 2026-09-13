import { z } from 'zod';

/**
 * Configuração do assistente. Falha no boot se algo obrigatório faltar — é
 * melhor não subir do que subir e falhar às 8h da manhã sem ninguém olhando.
 */
const schema = z.object({
  // --- WhatsApp / Evolution API ---
  EVOLUTION_URL: z.string().url(),
  EVOLUTION_API_KEY: z.string().min(1),
  EVOLUTION_INSTANCE: z.string().min(1),
  /** Número que recebe o resumo e é o único autorizado a conversar. Ex: 5511999999999 */
  OWNER_PHONE: z.string().regex(/^\d{12,13}$/, 'use só dígitos, com DDI: 5511999999999'),

  // --- Claude ---
  ANTHROPIC_API_KEY: z.string().min(1),
  CLAUDE_MODEL: z.string().default('claude-sonnet-5'),

  // --- Shopify ---
  SHOPIFY_SHOP: z.string().min(1).describe('l-f-oficial.myshopify.com'),
  SHOPIFY_ADMIN_TOKEN: z.string().min(1),
  SHOPIFY_API_VERSION: z.string().default('2026-07'),

  // --- Meta Ads ---
  META_SYSTEM_TOKEN: z.string().min(1),
  /** Contas que consolidam no resumo, separadas por vírgula. Hoje só a L&F01 gasta. */
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

  // --- Google Ads (opcional até o developer token sair) ---
  GOOGLE_ADS_CUSTOMER_ID: z.string().optional(),
  GOOGLE_ADS_DEVELOPER_TOKEN: z.string().optional(),
  GOOGLE_ADS_REFRESH_TOKEN: z.string().optional(),
  GOOGLE_ADS_CLIENT_ID: z.string().optional(),
  GOOGLE_ADS_CLIENT_SECRET: z.string().optional(),

  // --- Metas (Google Sheets via service account) ---
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  METAS_SPREADSHEET_ID: z.string().optional(),
  METAS_RANGE: z.string().default('Metas!A:B'),

  // --- MCPs próprios ---
  ATENDEPRO_MCP_URL: z.string().url().optional(),
  ATENDEPRO_TOKEN: z.string().optional(),
  CORTEPRO_MCP_URL: z.string().url().optional(),
  CORTEPRO_TOKEN: z.string().optional(),

  // --- WhatsApp Business (analytics de template) ---
  WABA_ID: z.string().optional(),

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

/** JID do dono, no formato que a Evolution usa. */
export function ownerJid(): string {
  return `${config().OWNER_PHONE}@s.whatsapp.net`;
}
