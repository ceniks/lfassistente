/**
 * A cobrança diária no grupo do atendimento.
 *
 * O que entra: pedido pago sem contrapartida nenhuma, e pedido pago em parte.
 * Os dois têm dono e ação clara — anexar comprovante, cobrar o resto, ou
 * desfazer a marcação de pago. O que fica de fora é de propósito: estorno sem
 * reversa e reversa sem estorno são conversa de financeiro, não de
 * atendimento, e misturar os dois públicos é o começo do ruído.
 *
 * Uma trava importante: a cobrança só sai de uma conferência **completa**. Se
 * o extrato não veio inteiro, metade das pendências pode ser falsa, e acusar
 * o atendimento de um buraco que é do banco gasta a credibilidade que faz a
 * mensagem ser lida. Em dia assim o boletim sai e a cobrança não.
 */
import { config } from "../config.js";
import { enviarTexto } from "../whatsapp/evolution.js";
import type { DadosRelatorio } from "../relatorio/dados.js";
import { montarCobranca } from "./mensagem.js";
import { conciliar, marcarCobradas, type Pendencia } from "./pendencias.js";

export function temGrupoDeAtendimento(): boolean {
  return Boolean(config().GRUPO_ATENDIMENTO);
}

type Nova = Omit<Pendencia, "desde" | "cobradaEm">;

/** O que a conferência de hoje considera em aberto, já no formato do livro. */
export function pendenciasDoDia(d: DadosRelatorio): Nova[] {
  const fora: Nova[] = [];

  for (const x of d.contrapartida.divergencias) {
    fora.push({
      pedido: x.pedido,
      tipo: "sem-contrapartida",
      valor: x.valor,
      motivo: x.motivo,
    });
  }

  /*
   * Parciais vêm do bloco de pagos à mão, e só os que ainda devem algo. O
   * frete que ficou fora do link é a causa mais comum — a nota do próprio
   * pedido já diz isso, e repetir aqui poupa a ida ao boletim.
   */
  const jaListados = new Set(fora.map((x) => x.pedido));
  for (const v of d.manual?.vendas ?? []) {
    if (v.situacao !== "parcial" || v.semRastro <= 0.01) continue;
    if (jaListados.has(v.pedido)) continue;
    fora.push({
      pedido: v.pedido,
      tipo: "parcial",
      valor: v.semRastro,
      motivo: v.nota ?? `pago em parte: falta este valor de ${v.metodo}`,
    });
  }

  return fora;
}

/**
 * Concilia, cobra e devolve o que foi feito — para o log e para o `/diag`.
 * Nunca lança: cobrança é acessório do boletim, não pode derrubá-lo.
 */
export async function cobrarNoGrupo(
  dia: string,
  d: DadosRelatorio,
): Promise<{ enviada: boolean; abertas: number; resolvidas: number; motivo?: string }> {
  const grupo = config().GRUPO_ATENDIMENTO;
  if (!grupo) return { enviada: false, abertas: 0, resolvidas: 0, motivo: "sem grupo configurado" };

  if (d.contrapartida.extratoIncompleto) {
    return {
      enviada: false,
      abertas: 0,
      resolvidas: 0,
      motivo: "conferência incompleta nesta leitura — cobrança adiada",
    };
  }

  try {
    const m = conciliar(dia, pendenciasDoDia(d));
    const texto = montarCobranca(dia, m);
    const abertas = m.novas.length + m.antigas.length;

    if (!texto) return { enviada: false, abertas: 0, resolvidas: 0, motivo: "nada a cobrar" };

    await enviarTexto(grupo, texto);
    marcarCobradas(dia, [...m.novas, ...m.antigas].map((p) => p.pedido));
    return { enviada: true, abertas, resolvidas: m.resolvidas.length };
  } catch (e) {
    const motivo = e instanceof Error ? e.message : String(e);
    console.error("[cobranca] falhou:", motivo);
    return { enviada: false, abertas: 0, resolvidas: 0, motivo };
  }
}
