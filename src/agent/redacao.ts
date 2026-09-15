/**
 * Geração de texto puro, sem agente.
 *
 * As duas leituras — a do resumo das 8h e a do boletim — são texto entra, texto
 * sai: recebem o relatório já montado e devolvem dois parágrafos. Não precisam
 * de ferramenta, de MCP nem de loop de decisão.
 *
 * Usar o SDK do agente para isso custa caro de um jeito que não aparece: ele
 * carrega o prompt de sistema e as definições de ferramenta a cada chamada.
 * Medido em 15/09/2026, com o mesmo pedido de dois parágrafos:
 *
 *     SDK do agente   20.964 tokens de entrada
 *     API direta          81 tokens de entrada
 *
 * São 258 vezes mais para escrever exatamente o mesmo texto. O agente continua
 * certo para a conversa no WhatsApp, onde ele precisa escolher ferramentas e
 * buscar dados; para redigir um parágrafo sobre números já calculados, não.
 */
import Anthropic from '@anthropic-ai/sdk';
import { config, exigir } from '../config.js';

let cliente: Anthropic | null = null;

function api(): Anthropic {
  if (!cliente) cliente = new Anthropic({ apiKey: exigir('ANTHROPIC_API_KEY') });
  return cliente;
}

const SISTEMA =
  'Você escreve a leitura diária da operação da L&F, uma marca brasileira de alfaiataria feminina. ' +
  'Escreve para o dono da empresa, que conhece o negócio a fundo e não precisa de explicação de conceito. ' +
  'Use exatamente os números que receber; não recalcule nada e não invente comparação que não esteja no texto.';

/**
 * Pede um texto ao modelo e devolve o que ele escreveu.
 *
 * O raciocínio estendido vem desligado, e isso não é economia de centavos: com
 * ele ligado o modelo gasta o orçamento de saída pensando e **trunca o texto no
 * meio da frase**. Foi assim que a leitura das 8h saiu cortada em "a falha nos
 * disparos de carrin". Medido no mesmo pedido, em 15/09:
 *
 *     com raciocínio, teto 1.200   1.200 tokens de saída, texto cortado
 *     com raciocínio, teto 4.000   1.035 tokens de saída, 541 caracteres
 *     sem raciocínio, teto 1.200     299 tokens de saída, 738 caracteres
 *
 * Sem raciocínio sai mais texto, inteiro, por um terço dos tokens. Para redigir
 * um parágrafo sobre números já calculados não há o que deliberar.
 */
export async function redigir(prompt: string, maxTokens = 1500): Promise<string> {
  const corpo = {
    model: config().CLAUDE_MODEL,
    max_tokens: maxTokens,
    system: SISTEMA,
    messages: [{ role: 'user' as const, content: prompt }],
  };

  // Nem todo modelo aceita desligar o raciocínio explicitamente. Se este não
  // aceitar, vale mais entregar a leitura com raciocínio ligado do que falhar.
  let r: Anthropic.Message;
  try {
    r = await api().messages.create({ ...corpo, thinking: { type: 'disabled' } });
  } catch {
    r = await api().messages.create(corpo);
  }

  const texto = r.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  if (!texto) throw new Error('modelo não devolveu texto');

  // Truncar a leitura é pior que não ter leitura: uma frase cortada parece
  // dado faltando, e quem lê não sabe o que ficou de fora.
  if (r.stop_reason === 'max_tokens') {
    throw new Error(`leitura truncada no teto de ${maxTokens} tokens`);
  }

  return texto;
}
