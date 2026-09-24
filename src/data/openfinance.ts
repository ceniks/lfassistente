/**
 * O extrato das contas, via Open Finance.
 *
 * Existe por causa de uma fatia que nenhum gateway enxerga: o Pix que a cliente
 * manda direto para a conta da L&F. Até aqui esse dinheiro só existia porque
 * alguém marcou o pedido como pago na Shopify — sem contrapartida em lugar
 * nenhum. Com o extrato, ele passa a ser conferível como qualquer venda de
 * cartão.
 *
 * O acesso é de leitura e vem do MCP.AI, que guarda o consentimento do Open
 * Finance. Uma chave, um POST por consulta. Se a chave não estiver configurada,
 * tudo aqui devolve vazio e o bloco simplesmente não aparece no boletim.
 */
import { config } from "../config.js";

const BASE = "https://api.mcp.ai/api/openfinance";

export function temOpenFinance(): boolean {
  return Boolean(config().MCP_AI_KEY);
}

/**
 * Uma chamada, com paciência.
 *
 * O caminho até o banco passa por proxy e por provedor de Open Finance, e os
 * dois devolvem 502 com página HTML de vez em quando — vimos isso no meio de um
 * teste, não em laboratório. Três tentativas com respiro crescente cobrem o
 * soluço; o que passar disso é falha de verdade e sobe como erro.
 */
async function chamar<T>(rota: string, corpo: unknown): Promise<T> {
  let ultimo: unknown;
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    try {
      return await tentar<T>(rota, corpo);
    } catch (e) {
      ultimo = e;
      const msg = e instanceof Error ? e.message : String(e);
      // Erro de credencial ou de rota não melhora esperando.
      if (/40[0-4]/.test(msg)) throw e;
      if (tentativa < 3) await new Promise((ok) => setTimeout(ok, 2000 * tentativa));
    }
  }
  throw ultimo;
}

async function tentar<T>(rota: string, corpo: unknown): Promise<T> {
  const r = await fetch(`${BASE}/${rota}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config().MCP_AI_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(corpo),
    signal: AbortSignal.timeout(60_000),
  });

  // A resposta nem sempre é JSON: proxy no meio do caminho devolve HTML de erro,
  // e `r.json()` estourava com "Unexpected token <", que não diz nada a ninguém.
  const bruto = await r.text();
  let j: { ok?: boolean; result?: T; error?: { message?: string } };
  try {
    j = JSON.parse(bruto);
  } catch {
    throw new Error(
      `Open Finance ${r.status} em ${rota}: resposta não-JSON — ${bruto.slice(0, 120).replace(/\s+/g, " ")}`,
    );
  }
  if (!r.ok || j.error) {
    throw new Error(`Open Finance ${r.status} em ${rota}: ${j.error?.message ?? "falhou"}`);
  }
  return j.result as T;
}

export interface ContaBancaria {
  id: string;
  banco: string;
  tipo: string;
  numero: string;
  saldo: number;
}

export async function contas(): Promise<ContaBancaria[]> {
  const r = await chamar<{ results: Array<Record<string, unknown>> }>("accounts/list", {});
  return (r.results ?? []).map((a) => ({
    id: String(a.account_id ?? a.id ?? ""),
    banco: String(a.bank ?? ""),
    tipo: `${a.type ?? ""} ${a.subtype ?? ""}`.trim(),
    numero: String(a.number ?? ""),
    saldo: Number(a.balance ?? 0),
  }));
}

/**
 * A conta corrente que recebe as vendas.
 *
 * Por padrão a do PagBank, que é onde cai o Pix da loja. `OPENFINANCE_CONTA`
 * troca por qualquer outra sem mexer em código — o id vem de `contas()`.
 */
async function contaDasVendas(): Promise<ContaBancaria | null> {
  const escolhida = config().OPENFINANCE_CONTA;
  const todas = await contas();
  if (escolhida) return todas.find((c) => c.id === escolhida) ?? null;
  return (
    todas.find((c) => /pagbank/i.test(c.banco) && c.tipo.startsWith("BANK")) ??
    todas.find((c) => c.tipo.startsWith("BANK")) ??
    null
  );
}

export interface EntradaPix {
  id: string;
  /** Data e hora em São Paulo. */
  quando: string;
  dia: string;
  valor: number;
  /** Quem mandou, como o banco descreve. */
  quem: string;
}

/**
 * As entradas por Pix da conta de vendas, no intervalo.
 *
 * Só crédito e só Pix: boleto, TED e tarifa ficam de fora. O intervalo é
 * pedido com folga de um dia para cada lado porque o Pix da cliente e o
 * registro do pedido nem sempre caem no mesmo dia — na prática já vimos Pix
 * chegando na véspera do pedido ser lançado.
 */
export async function entradasPix(de: string, ate: string): Promise<EntradaPix[]> {
  const conta = await contaDasVendas();
  if (!conta) return [];

  /*
   * Lista vazia merece uma segunda chance.
   *
   * Rodando três conferências seguidas, uma delas voltou com zero lançamento
   * num dia que tinha nove — e zero, aqui, não é "não houve Pix": é o bloco
   * inteiro acusando falta de contrapartida em pagamento que existe. Duas
   * tentativas com respiro no meio resolveram; o que sobrar de vazio é tratado
   * como extrato indisponível por quem chama, não como ausência de dinheiro.
   */
  let r = { results: [] as Array<Record<string, unknown>> };
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    r = await chamar<{ results: Array<Record<string, unknown>> }>("transactions/list", {
      account_id: conta.id,
      from: de,
      to: ate,
      page_size: 500,
    });
    if ((r.results ?? []).length) break;
    if (tentativa < 3) await new Promise((ok) => setTimeout(ok, 1500 * tentativa));
  }

  return (r.results ?? [])
    .filter((t) => String(t.operationType ?? "") === "PIX" && Number(t.amount) > 0)
    .map((t) => {
      /*
       * A data vai como o banco manda, sem converter fuso. Converter de UTC
       * jogava o Pix da madrugada para o dia anterior e mostrava horário três
       * horas antes do que aparece no app do banco — e é pelo app que alguém
       * vai conferir. A janela de três dias absorve a diferença de fuso.
       */
      const quando = String(t.date).replace("T", " ").slice(0, 19);
      return {
        id: String(t.id ?? ""),
        quando,
        dia: quando.slice(0, 10),
        valor: Number(t.amount),
        quem: String(t.description ?? "").trim(),
      };
    });
}

/**
 * Pede ao provedor que atualize as conexões agora.
 *
 * Não roda no boletim de propósito: a sincronização é cara, pode pedir nova
 * autenticação em banco com MFA e não é instantânea. Serve para quando o
 * extrato estiver visivelmente atrasado — ver o CLI `extrato`.
 */
export async function sincronizar(): Promise<number> {
  const r = await chamar<{ results?: unknown[] }>("connections/sync", {});
  return (r.results ?? []).length;
}
