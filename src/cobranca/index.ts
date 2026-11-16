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
import { responsaveisDePedidos } from "../data/shopify.js";

export interface UltimaCobranca {
  dia: string;
  em: string;
  enviada: boolean;
  abertas: number;
  resolvidas: number;
  motivo?: string;
}

/**
 * O resultado da última cobrança, em memória.
 *
 * Existe porque "nenhuma mensagem chegou no grupo" tem três causas que de
 * fora parecem a mesma: não havia o que cobrar, a conferência veio
 * incompleta, ou o envio falhou. Sem isto, responder "está correto?" exige
 * refazer a conferência de cada dia à mão — foi o que custou esta resposta
 * uma vez.
 */
let ultima: UltimaCobranca | null = null;

export function ultimaCobranca(): UltimaCobranca | null {
  return ultima;
}

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
  const anotar = (r: { enviada: boolean; abertas: number; resolvidas: number; motivo?: string }) => {
    ultima = { dia, em: new Date().toISOString(), ...r };
    return r;
  };

  const grupo = config().GRUPO_ATENDIMENTO;
  if (!grupo) return anotar({ enviada: false, abertas: 0, resolvidas: 0, motivo: "sem grupo configurado" });

  if (d.contrapartida.extratoIncompleto) {
    return anotar({
      enviada: false,
      abertas: 0,
      resolvidas: 0,
      motivo: "conferência incompleta nesta leitura — cobrança adiada",
    });
  }

  /*
   * Marco zero: o que é de antes não se cobra.
   *
   * A conferência é por dia e só enxerga os pedidos daquele dia, então o
   * passado não entra sozinho. Esta trava existe para o caso de alguém rodar
   * o boletim de um dia antigo à mão — aí a cobrança sairia com pedidos que
   * já foram resolvidos por fora, cobrando gente por coisa velha.
   */
  const desde = config().COBRANCA_DESDE;
  if (desde && dia < desde) {
    return anotar({ enviada: false, abertas: 0, resolvidas: 0, motivo: `dia anterior ao marco (${desde})` });
  }

  try {
    const pendentes = pendenciasDoDia(d);

    // Uma consulta só, e apenas para quem vai ser cobrado.
    const responsaveis = await responsaveisDePedidos(pendentes.map((p) => p.pedido)).catch(
      () => new Map<string, string>(),
    );
    for (const p of pendentes) {
      const quem = responsaveis.get(p.pedido);
      if (quem) p.responsavel = quem;
    }

    const m = conciliar(dia, pendentes);
    const texto = montarCobranca(dia, m);
    const abertas = m.novas.length + m.antigas.length;

    if (!texto) {
      return anotar({ enviada: false, abertas: 0, resolvidas: 0, motivo: "nada a cobrar" });
    }

    await enviarTexto(grupo, texto);
    marcarCobradas(dia, [...m.novas, ...m.antigas].map((p) => p.pedido));
    return anotar({ enviada: true, abertas, resolvidas: m.resolvidas.length });
  } catch (e) {
    const motivo = e instanceof Error ? e.message : String(e);
    console.error("[cobranca] falhou:", motivo);
    return anotar({ enviada: false, abertas: 0, resolvidas: 0, motivo });
  }
}
