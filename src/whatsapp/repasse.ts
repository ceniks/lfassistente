/**
 * Repasse de eventos para outro sistema que usa o mesmo número.
 *
 * A Evolution entrega os eventos de uma instância para **um** webhook. Dois
 * projetos no mesmo número significam que o último a configurar leva tudo e o
 * outro emudece, sem erro e sem aviso. Então o assistente continua sendo o
 * único assinante e repassa, filtrando por conversa: o que vem dos JIDs
 * listados sai daqui para o outro sistema e não é tratado localmente.
 *
 * Três decisões que vêm do contrato combinado com o outro lado:
 *
 * **O corpo vai cru.** Nada de traduzir para um formato nosso: o que a
 * Evolution mandou é o que segue, com `key.participant` e tudo. Quem recebe
 * sabe ler o formato da Evolution e não deve depender da nossa interpretação.
 *
 * **Mensagem do próprio bot vai junto.** `fromMe: true` é justamente como o
 * outro sistema confirma que o boletim dele saiu. Filtrar aqui seria decidir
 * por ele.
 *
 * **`connection.update` vai sempre.** Não é de conversa nenhuma, mas é como se
 * descobre que o número caiu — sem isso, o relatório das 8h15 falha calado.
 */
import { config } from '../config.js';

export function temRepasse(): boolean {
  return Boolean(config().WEBHOOK_REPASSE_URL);
}

/** Os JIDs cujos eventos pertencem ao outro sistema. */
export function jidsDeRepasse(): string[] {
  return (config().WEBHOOK_REPASSE_JIDS ?? '')
    .split(',')
    .map((j) => j.trim())
    .filter(Boolean);
}

export function ehDeRepasse(jid?: string): boolean {
  if (!jid || !temRepasse()) return false;
  return jidsDeRepasse().includes(jid);
}

/**
 * Manda o evento adiante.
 *
 * Sem `await` na resposta ao WhatsApp: o webhook já respondeu 200 antes de
 * chegar aqui, e a Evolution não pode ficar esperando o outro sistema. Falha
 * vira log, não exceção — um destino fora do ar não pode derrubar o assistente.
 */
export interface TentativaDeRepasse {
  em: string;
  evento: string | null;
  jid: string | null;
  resultado: string;
}

/**
 * As últimas tentativas, só em memória.
 *
 * Existe por um motivo prático: o destino guarda o evento mas não devolve o
 * que guardou, então "o outro sistema recebeu?" não se responde de fora. Sem
 * este rastro, a única prova está no log do Railway, que exige abrir o painel
 * e some quando a aba fecha. Cinco bastam — é diagnóstico, não histórico.
 */
const ULTIMAS = 5;
const tentativas: TentativaDeRepasse[] = [];

export function ultimosRepasses(): TentativaDeRepasse[] {
  return [...tentativas].reverse();
}

function anotar(corpo: unknown, resultado: string): void {
  const e = corpo as { event?: string; data?: { key?: { remoteJid?: string } } } | null;
  tentativas.push({
    em: new Date().toISOString(),
    evento: e?.event ?? null,
    jid: e?.data?.key?.remoteJid ?? null,
    resultado,
  });
  if (tentativas.length > ULTIMAS) tentativas.shift();
}

export async function repassar(corpo: unknown): Promise<void> {
  const c = config();
  if (!c.WEBHOOK_REPASSE_URL) return;

  try {
    const r = await fetch(c.WEBHOOK_REPASSE_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Evolution-Instance': c.EVOLUTION_INSTANCE ?? '',
        ...(c.WEBHOOK_REPASSE_TOKEN
          ? { Authorization: `Bearer ${c.WEBHOOK_REPASSE_TOKEN}` }
          : {}),
      },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(15_000),
    });
    anotar(corpo, String(r.status));
    if (!r.ok) {
      console.error(`[repasse] destino respondeu ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
  } catch (e) {
    const motivo = e instanceof Error ? e.message : String(e);
    anotar(corpo, `falhou: ${motivo}`);
    console.error('[repasse] falhou:', motivo);
  }
}
