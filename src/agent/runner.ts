import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';
import { mcpServers, allowedTools } from './mcp.js';
import { SYSTEM_PROMPT } from './prompt.js';

/**
 * Histórico por conversa. Uma sessão só, já que só o Luis fala com o assistente.
 *
 * Limitado de propósito: reenviar histórico inteiro a cada turno é o jeito mais
 * rápido de queimar dinheiro em token. Vinte turnos cobrem qualquer conversa
 * real sobre a operação do dia.
 */
const MAX_TURNOS = 20;
const historico: Array<{ papel: 'user' | 'assistant'; texto: string }> = [];

export interface Resposta {
  texto: string;
  ferramentasUsadas: string[];
  erro?: string;
}

export async function perguntar(pergunta: string): Promise<Resposta> {
  const c = config();
  historico.push({ papel: 'user', texto: pergunta });

  const contexto = historico
    .slice(-MAX_TURNOS)
    .map((h) => `${h.papel === 'user' ? 'Luis' : 'Você'}: ${h.texto}`)
    .join('\n\n');

  const ferramentasUsadas: string[] = [];
  let resultado = '';
  let erro: string | undefined;

  try {
    for await (const msg of query({
      prompt: contexto,
      options: {
        model: c.CLAUDE_MODEL,
        systemPrompt: SYSTEM_PROMPT,
        mcpServers: mcpServers() as never,
        allowedTools,
        // Sem acesso ao disco nem ao shell: o agente lê dados, não mexe na máquina.
        settingSources: [],
      },
    })) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        const fora = (msg.mcp_servers ?? []).filter(
          (s: { status: string }) => s.status === 'failed' || s.status === 'needs-auth',
        );
        if (fora.length) {
          console.warn('[agent] MCP indisponível:', fora);
        }
      }

      if (msg.type === 'assistant') {
        for (const bloco of msg.message.content) {
          if (bloco.type === 'tool_use' && bloco.name.startsWith('mcp__')) {
            ferramentasUsadas.push(bloco.name);
          }
        }
      }

      if (msg.type === 'result') {
        if (msg.subtype === 'success') resultado = msg.result;
        else erro = `execução falhou: ${msg.subtype}`;
      }
    }
  } catch (e) {
    erro = e instanceof Error ? e.message : String(e);
  }

  if (resultado) historico.push({ papel: 'assistant', texto: resultado });

  return { texto: resultado, ferramentasUsadas, erro };
}

/** Pergunta isolada, sem histórico — usada pelo resumo das 8h. */
export async function perguntarSemContexto(prompt: string): Promise<string> {
  const c = config();

  for await (const msg of query({
    prompt,
    options: {
      model: c.CLAUDE_MODEL,
      systemPrompt: SYSTEM_PROMPT,
      settingSources: [],
    },
  })) {
    if (msg.type !== 'result') continue;

    const resultado = msg.subtype === 'success' ? msg.result : '';

    // O SDK devolve falha de autenticação como texto de resposta bem-sucedida.
    // Sem esta checagem, "Invalid API key · Please run /login" seria impresso no
    // resumo como se fosse a leitura do dia — uma mensagem de erro disfarçada de
    // análise é pior que nenhuma análise.
    if (!resultado || pareceErroDoSdk(resultado)) {
      throw new Error(`agente não respondeu: ${resultado || msg.subtype}`);
    }

    return resultado;
  }

  throw new Error('agente não devolveu resultado');
}

const SINAIS_DE_ERRO = [
  /invalid api key/i,
  /please run \/login/i,
  /authentication_error/i,
  /credit balance is too low/i,
  /rate.?limit/i,
];

function pareceErroDoSdk(texto: string): boolean {
  return texto.length < 300 && SINAIS_DE_ERRO.some((r) => r.test(texto));
}

export function limparHistorico(): void {
  historico.length = 0;
}
