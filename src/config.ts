import { z } from "zod";

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
  typeof v === "string" && v.trim() === "" ? undefined : v;

const opcional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(vazioViraUndefined, schema.optional());

const url = () => z.string().url();

const schema = z.object({
  // --- WhatsApp / Evolution API ---
  EVOLUTION_URL: opcional(url()),
  EVOLUTION_API_KEY: opcional(z.string()),
  EVOLUTION_INSTANCE: opcional(z.string()),
  /**
   * Quem recebe o resumo e pode conversar com o assistente.
   *
   * Aceita mais de um número, separados por vírgula. O resumo das 8h e os
   * alertas do vigia vão para todos; uma resposta de conversa volta só para
   * quem perguntou.
   *
   * Ex: 5511999999999 ou 5511999999999,5511888888888
   */
  OWNER_PHONE: opcional(
    z
      .string()
      .regex(
        /^\d{12,13}(\s*,\s*\d{12,13})*$/,
        "use só dígitos, com DDI, separados por vírgula: 5511999999999,5511888888888",
      ),
  ),

  // --- Claude ---
  ANTHROPIC_API_KEY: opcional(z.string()),
  CLAUDE_MODEL: z.string().default("claude-sonnet-5"),

  // --- Shopify ---
  SHOPIFY_SHOP: opcional(z.string()),
  /**
   * Credenciais do app no Dev Dashboard. A Shopify descontinuou os custom apps
   * do admin, que davam token fixo; hoje um serviço troca estas duas por um
   * token de 24h (client credentials grant).
   */
  SHOPIFY_CLIENT_ID: opcional(z.string()),
  SHOPIFY_CLIENT_SECRET: opcional(z.string()),
  /** Só para quem ainda mantém um custom app legado. Tem precedência se existir. */
  SHOPIFY_ADMIN_TOKEN: opcional(z.string()),
  SHOPIFY_API_VERSION: z.string().default("2026-07"),

  // --- Meta Ads ---
  META_SYSTEM_TOKEN: opcional(z.string()),
  /** Contas que consolidam no resumo. Hoje só a L&F01 gasta. */
  META_AD_ACCOUNT_IDS: z
    .string()
    .default("2384690018414844")
    .transform((s) =>
      s
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  /**
   * Gross-up de imposto do Meta. Medido na fatura: R$ 32.221,01 de mídia com
   * R$ 4.456,28 de imposto = 13,8304%.
   *
   * Aplica-se SOMENTE ao valor pago e ao ROAS. CPM, CPC e CPA ficam sobre o
   * gasto líquido, para continuarem comparáveis com benchmark de leilão e com o
   * histórico. E vale só para o Meta — no Google o valor da API já é o pago.
   */
  META_TAX_FACTOR: z.coerce.number().min(1).default(1.138304),

  /*
   * Custos que a Shopify não informa e por isso entram como parâmetro.
   *
   * A taxa do meio de pagamento não vem na API: `transactions.fees` só é
   * preenchido para Shopify Payments, e a L&F usa PagBank e Mercado Pago —
   * conferido em 16/09/2026, todos os pedidos voltam com `fees: []`. O mesmo
   * vale para o custo real do frete, que está na fatura dos Correios e não no
   * pedido.
   *
   * Ficam em zero por padrão de propósito: margem com taxa inventada é pior
   * que margem incompleta, e o boletim avisa quando o parâmetro está zerado.
   */
  /**
   * Taxa de desconto do cartão, usada só onde não dá para medir.
   *
   * A taxa **não é única**: medida transação a transação no PagBank em
   * 16/09/2026, ela foi de 3,12% à vista a 7,38% em 8x, com média de 5,93% no
   * dia — e a média muda com o mix de parcelamento, então fixar um percentual
   * erra sozinho de um dia para o outro. Onde há credencial (PagBank), a
   * margem usa o `feeAmount` de cada transação e ignora este parâmetro. Ele
   * sobra para o Mercado Pago e para qualquer gateway sem acesso.
   *
   * Os 6,10% que estavam aqui eram a linha do 6x da tabela do PagBank.
   */
  TAXA_CARTAO_PCT: z.coerce.number().min(0).max(30).default(0),
  /**
   * Parcelamento assumido quando não há como medir.
   *
   * Em 16/09/2026 a média ponderada pelo valor deu 5,6 parcelas — 8x sozinho
   * foi 44% do volume no cartão. 6 é a aproximação conservadora, e só é usada
   * onde não existe credencial para ler a taxa cobrada.
   */
  PARCELAS_MEDIAS: z.coerce.number().int().min(1).max(10).default(6),
  TAXA_PIX_PCT: z.coerce.number().min(0).max(30).default(0.99),
  TAXA_BOLETO_PCT: z.coerce.number().min(0).max(30).default(0),
  /** Comissão da Shopify por usar gateway externo, sobre toda venda. */
  TAXA_PLATAFORMA_PCT: z.coerce.number().min(0).max(30).default(0.6),
  /**
   * Custo médio de postagem, por pedido despachado.
   *
   * R$ 27,55 = a fatura dos Correios de agosto de 2026, R$ 127.497,12, sobre
   * os 4.628 pedidos despachados no mês. É média de fatura fechada, não
   * estimativa — mas é média: pedido pesado para o Norte custa muito mais que
   * peça única na capital, e isso não aparece aqui.
   *
   * Vale reconferir a cada fatura. A conta cobre todo pedido que gera
   * postagem, incluindo troca, seeding e reenvio.
   */
  CUSTO_FRETE_POR_PEDIDO: z.coerce.number().min(0).default(27.55),
  /**
   * Token do PagBank.
   *
   * Não entra na margem — a taxa já é conhecida (6,10% / 0,99%). Existe para
   * medir caixa: quanto do faturamento já pingou na conta e quanto está em
   * recebível. Cobre só o PagBank; o Mercado Pago responde pela outra fatia e
   * precisaria de credencial própria, então qualquer número daqui é parcial e
   * tem que ser rotulado como tal.
   */
  /**
   * Chave secreta da Pagar.me.
   *
   * Existe por causa dos pedidos pagos à mão: a atendente cria um rascunho,
   * manda um link da Pagar.me e marca como pago na Shopify. Em 16/09 foram
   * R$ 6.572 assim — 8% do faturamento — sem cobrança em gateway nenhum dos
   * que o boletim conhecia. A conferência inversa do PagBank confirmou que o
   * dinheiro não passou por lá.
   *
   * A amarração não pode ser por id: pedido manual não tem `payment_id`. É por
   * valor, cliente e janela de data — menos exato que o PagBank, e suficiente
   * porque são poucos por dia.
   */
  PAGARME_TOKEN: opcional(z.string()),
  /**
   * Access token de produção do Mercado Pago.
   *
   * É o gateway do Pix da loja — R$ 13.666 em 35 transações no dia 16/09, a
   * última fatia grande ainda estimada. O PagBank e a Pagar.me já entram pela
   * taxa cobrada; aqui ainda se aplica TAXA_PIX_PCT sobre o valor, o que só
   * está certo enquanto a taxa do Pix não mudar nem variar.
   */
  MERCADOPAGO_TOKEN: opcional(z.string()),
  PAGBANK_TOKEN: opcional(z.string()),
  /**
   * Token da API antiga (ws.pagseguro.uol.com.br).
   *
   * É outro token, não o mesmo da API nova. Só ele lista transações por
   * intervalo de data e devolve `feeAmount` e `netAmount` — sem isso não há
   * conferência contra a Shopify nem fechamento de caixa. Vem acompanhado do
   * e-mail da conta.
   */
  PAGBANK_TOKEN_ANTIGO: opcional(z.string()),
  /** E-mail da conta, exigido junto do token antigo. */
  PAGBANK_EMAIL: opcional(z.string()),
  WABA_ID: opcional(z.string()),
  /**
   * Token separado para o WhatsApp.
   *
   * Precisa existir porque o WhatsApp da L&F mora em outro portfólio (L&F
   * Alfaiataria) que não é o dos anúncios. Um token de usuário do sistema só
   * enxerga ativos do portfólio onde foi gerado — não há token que cubra os
   * dois. Se ficar vazio, o código cai no META_SYSTEM_TOKEN, que funciona no
   * caso de alguém um dia consolidar tudo num portfólio só.
   */
  META_WHATSAPP_TOKEN: opcional(z.string()),
  /**
   * ID do portfólio empresarial dono do WhatsApp.
   *
   * Necessário porque `/me/businesses` devolve lista vazia para token de
   * usuário do sistema — o `/me` dele é o próprio usuário, não a pessoa que o
   * criou, e ele não "pertence" a portfólio nenhum pela ótica dessa aresta. Sem
   * o ID explícito não há como listar as contas do WhatsApp.
   */
  META_BUSINESS_ID: opcional(z.string()),

  // --- Google Ads ---
  /**
   * ID da conta. Aceita com ou sem hífen: a interface do Google Ads mostra
   * "834-963-5391" e a API exige "8349635391", então normalizamos aqui em vez
   * de esperar que ninguém esqueça de tirar os traços ao copiar.
   */
  GOOGLE_ADS_CUSTOMER_ID: opcional(
    z.string().transform((v) => v.replace(/\D/g, "")),
  ),
  /**
   * Só preencher se a conta estiver sob uma gerenciadora (MCC): é o ID dela.
   * Fora desse caso, mandar o header atrapalha em vez de ajudar.
   */
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: opcional(
    z.string().transform((v) => v.replace(/\D/g, "")),
  ),
  GOOGLE_ADS_CLIENT_ID: opcional(z.string()),
  GOOGLE_ADS_CLIENT_SECRET: opcional(z.string()),
  /** Obtido uma vez com `npm run google-oauth`. Não expira. */
  GOOGLE_ADS_REFRESH_TOKEN: opcional(z.string()),
  /**
   * O Google aposenta versões da API a cada poucos meses — a v22 saiu de
   * circulação em setembro de 2026. Fica em variável para a troca ser um
   * redeploy, não um commit.
   */
  GOOGLE_ADS_API_VERSION: z.string().default("v25"),
  /**
   * Descontinuado pelo Google em 09/09/2026: o acesso passou a ser gerenciado
   * pela organização do Cloud e o header developer-token é ignorado. Fica aqui
   * só para integrações antigas que ainda o enviam.
   */
  GOOGLE_ADS_DEVELOPER_TOKEN: opcional(z.string()),

  // --- Metas (Google Sheets via service account) ---
  GOOGLE_SERVICE_ACCOUNT_JSON: opcional(z.string()),
  METAS_SPREADSHEET_ID: opcional(z.string()),
  METAS_RANGE: z.string().default("Metas!A:B"),

  // --- Holerites (mesma service account das metas) ---
  /** Planilha com nome, e-mail e apelido de cada funcionária. */
  RH_SPREADSHEET_ID: opcional(z.string()),
  RH_RANGE: z.string().default("Funcionarios!A:C"),

  // --- Envio de e-mail (Gmail da empresa, senha de app) ---
  SMTP_HOST: z.string().default("smtp.gmail.com"),
  SMTP_PORT: z.coerce.number().int().positive().default(465),
  SMTP_USER: opcional(z.string()),
  /** Senha de app do Google, não a senha da conta. */
  SMTP_PASSWORD: opcional(z.string()),
  /** Remetente exibido; vazio usa o próprio SMTP_USER. */
  SMTP_FROM: z.string().default(""),
  /** `{mes}` vira "Agosto/2026" no assunto do e-mail. */
  HOLERITE_ASSUNTO: z.string().default("Holerite de {mes} - {nome}"),

  /**
   * Autorização do Gmail (escopo gmail.send), obtida no mesmo cliente OAuth do
   * Google Ads. Preferida ao SMTP: nenhuma senha circula.
   */
  GMAIL_REFRESH_TOKEN: opcional(z.string()),

  // --- Repasse de eventos do WhatsApp para outro sistema no mesmo número ---
  /** Destino dos eventos. Vazio: nada é repassado. */
  WEBHOOK_REPASSE_URL: opcional(url()),
  /** Segredo que o outro lado exige no `Authorization: Bearer`. */
  WEBHOOK_REPASSE_TOKEN: opcional(z.string()),
  /** JIDs cujos eventos pertencem ao outro sistema, separados por vírgula. */
  WEBHOOK_REPASSE_JIDS: opcional(z.string()),

  /** Senha da página de holerites. Sem ela a página fica desligada. */
  RH_SENHA: opcional(z.string()),

  /**
   * Chave do MCP.AI — dá acesso de leitura ao Open Finance (extrato do PagBank
   * e do Santander). É o que permite conferir o Pix que cai direto na conta,
   * sem passar por gateway.
   */
  MCP_AI_KEY: opcional(z.string()),

  /** Id da conta cujo extrato confere o Pix. Vazio: a conta corrente do PagBank. */
  OPENFINANCE_CONTA: opcional(z.string()),

  /**
   * Pedir ao provedor que atualize o extrato antes de ler.
   *
   * Ligado por padrão: sem isso, o boletim das 8h lê a última visita ao banco,
   * que costuma ser da véspera. `false` desliga, para quando a sincronização
   * estiver custando mais do que entrega.
   */
  OPENFINANCE_SINCRONIZAR: z.coerce.boolean().default(true),
  /** Quanto esperar pela sincronização antes de seguir sem ela. */
  OPENFINANCE_TETO_SINC_MS: z.coerce.number().int().positive().default(45_000),

  /**
   * Texto do e-mail do holerite. Marcadores: {tratamento}, {primeiro}, {nome}
   * e {mes}. Fica aqui para poder mudar sem deploy; a página ainda deixa
   * editar antes de cada envio.
   */
  HOLERITE_CORPO: z
    .string()
    .default(
      "{tratamento} {primeiro},\n\n" +
        "Segue em anexo seu holerite referente ao mês de {mes}.\n\n" +
        "Agradecemos o seu empenho e dedicação!\n\n" +
        "Atenciosamente,\nL E FASHION EIRELI\n",
    ),

  // --- MCPs próprios ---
  ATENDEPRO_MCP_URL: opcional(url()),
  ATENDEPRO_TOKEN: opcional(z.string()),
  CORTEPRO_MCP_URL: opcional(url()),
  CORTEPRO_TOKEN: opcional(z.string()),

  // --- Troquecommerce ---
  /**
   * Duas lojas, dois tokens: a migração para o Shopify foi em 08/04/2026 e as
   * reversas de vendas anteriores ficaram na loja antiga (Nuvemshop). O resumo
   * diário usa só a atual.
   */
  TROQUE_TOKEN: opcional(z.string()),
  TROQUE_TOKEN_LEGADO: opcional(z.string()),

  // --- Runtime ---
  PORT: z.coerce.number().default(3000),
  TZ: z.string().default("America/Sao_Paulo"),
  /** Hora do resumo, no fuso acima. */
  DIGEST_CRON: z.string().default("0 8 * * *"),
  /** De quanto em quanto tempo checar a saúde da conta de anúncios. */
  VIGIA_CRON: z.string().default("0 * * * *"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("production"),
});

export type Config = z.infer<typeof schema>;

let cached: Config | null = null;

export function config(): Config {
  if (cached) return cached;

  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const problemas = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
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
  "EVOLUTION_URL",
  "EVOLUTION_API_KEY",
  "EVOLUTION_INSTANCE",
  "OWNER_PHONE",
  "ANTHROPIC_API_KEY",
  "SHOPIFY_SHOP",
  "META_SYSTEM_TOKEN",
] as const satisfies ReadonlyArray<keyof Config>;

export function exigirConfigCompleta(): Config {
  const c = config();
  const faltando = OBRIGATORIAS.filter((k) => !c[k]);

  if (faltando.length) {
    throw new Error(
      `Faltam variáveis obrigatórias no ambiente:\n${faltando.map((k) => `  ${k}`).join("\n")}\n\n` +
        "Preencha o .env (veja o .env.example) ou as variáveis do Railway.",
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
export function exigir<K extends keyof Config>(
  chave: K,
): NonNullable<Config[K]> {
  const valor = config()[chave];
  if (valor === undefined || valor === "") {
    throw new Error(
      `${String(chave)} não está configurada. Preencha no .env (veja o .env.example) ou nas variáveis do Railway.`,
    );
  }
  return valor as NonNullable<Config[K]>;
}

/** Diz se uma integração tem o mínimo para ser tentada. */
export function temShopify(): boolean {
  const c = config();
  if (!c.SHOPIFY_SHOP) return false;
  return Boolean(
    c.SHOPIFY_ADMIN_TOKEN || (c.SHOPIFY_CLIENT_ID && c.SHOPIFY_CLIENT_SECRET),
  );
}

export function temMeta(): boolean {
  return Boolean(config().META_SYSTEM_TOKEN);
}

/** Os números autorizados, já separados e sem espaço. */
export function donos(): string[] {
  const bruto = config().OWNER_PHONE;
  if (!bruto) throw new Error("OWNER_PHONE não configurado");
  return bruto
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
}

/** JIDs no formato que a Evolution usa. */
export function donosJids(): string[] {
  return donos().map((n) => `${n}@s.whatsapp.net`);
}

/**
 * As formas com e sem o nono dígito do mesmo celular brasileiro.
 *
 * Existe por causa de uma armadilha real: a Evolution devolve o JID no formato
 * em que o WhatsApp registrou a conta, e contas antigas ainda aparecem sem o 9
 * (551197937982) enquanto o dono digita o número com ele (5511997937982).
 * Comparação literal deixaria o dono trancado do lado de fora do próprio
 * assistente, e o sintoma seria mudo: mensagem ignorada, nenhum erro.
 */
function variantes(numero: string): string[] {
  const d = numero.replace(/\D/g, "");
  if (!d.startsWith("55") || d.length < 12) return [d];

  const ddd = d.slice(2, 4);
  const resto = d.slice(4);
  const com9 = resto.length === 8 ? `9${resto}` : resto;
  const sem9 =
    resto.length === 9 && resto.startsWith("9") ? resto.slice(1) : resto;

  return [...new Set([`55${ddd}${com9}`, `55${ddd}${sem9}`])];
}

/**
 * A allowlist: este JID é de alguém autorizado?
 *
 * O `split(':')` não é decorativo. Quando a mensagem vem de um aparelho
 * secundário, o Baileys devolve `5511999999999:12@s.whatsapp.net`, e sem cortar
 * o sufixo os dígitos do aparelho grudam no telefone — vira outro número, e o
 * dono é silenciosamente ignorado ao responder do notebook em vez do celular.
 */
export function ehDono(jid: string): boolean {
  const numero = (jid.split("@")[0] ?? "").split(":")[0] ?? "";
  const doJid = new Set(variantes(numero));
  return donos().some((d) => variantes(d).some((v) => doJid.has(v)));
}
