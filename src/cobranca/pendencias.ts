/**
 * O livro de pendências: o que o atendimento ainda deve explicar.
 *
 * A cobrança sem memória é inútil — nomeia o pedido uma vez, ninguém responde,
 * e ele some. A cobrança com memória só é aceitável se ela souber parar
 * sozinha: o critério de encerramento aqui não é alguém dar baixa, é a
 * divergência **deixar de aparecer na conferência**. Quando o pagamento
 * aparece no gateway, no extrato ou num comprovante anexado, a pendência
 * fecha sem ninguém fazer nada.
 *
 * Isso importa porque dar baixa à mão é exatamente o tipo de tarefa que não é
 * feita, e uma lista que só cresce vira ruído que todo mundo aprende a
 * ignorar — o oposto do que ela existe para fazer.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const ARQUIVO = process.env.PENDENCIAS ?? "dados/pendencias.json";

export type TipoDePendencia = "sem-contrapartida" | "parcial";

export interface Pendencia {
  pedido: string;
  tipo: TipoDePendencia;
  valor: number;
  motivo: string;
  /** Dia do boletim em que apareceu pela primeira vez. */
  desde: string;
  /** Dias em que foi cobrada no grupo. */
  cobradaEm: string[];
}

export interface Movimento {
  /** Apareceram agora e nunca foram cobradas. */
  novas: Pendencia[];
  /** Continuam em aberto, já cobradas antes. */
  antigas: Pendencia[];
  /** Sumiram da conferência: o dinheiro apareceu. */
  resolvidas: Pendencia[];
}

function ler(): Record<string, Pendencia> {
  try {
    return JSON.parse(readFileSync(ARQUIVO, "utf8")) as Record<string, Pendencia>;
  } catch {
    return {};
  }
}

function gravar(livro: Record<string, Pendencia>): void {
  mkdirSync(dirname(ARQUIVO), { recursive: true });
  writeFileSync(ARQUIVO, JSON.stringify(livro, null, 1));
}

/**
 * Confronta o que a conferência de hoje achou com o livro.
 *
 * `atuais` é a verdade do dia: o que não está nela está resolvido, mesmo que
 * ninguém tenha respondido. O livro nunca inventa pendência — ele só carrega
 * no tempo o que a conferência produziu.
 */
export function conciliar(
  dia: string,
  atuais: Array<Omit<Pendencia, "desde" | "cobradaEm">>,
): Movimento {
  const livro = ler();
  const vistos = new Set(atuais.map((p) => p.pedido));

  const novas: Pendencia[] = [];
  const antigas: Pendencia[] = [];

  for (const a of atuais) {
    const antiga = livro[a.pedido];
    if (antiga) {
      // Valor e motivo são atualizados: um parcial pode mudar de tamanho
      // quando parte do pagamento aparece, e cobrar o número velho seria
      // cobrar errado.
      const atualizada: Pendencia = { ...antiga, valor: a.valor, motivo: a.motivo, tipo: a.tipo };
      livro[a.pedido] = atualizada;
      antigas.push(atualizada);
    } else {
      const nova: Pendencia = { ...a, desde: dia, cobradaEm: [] };
      livro[a.pedido] = nova;
      novas.push(nova);
    }
  }

  const resolvidas = Object.values(livro).filter((p) => !vistos.has(p.pedido));
  for (const r of resolvidas) delete livro[r.pedido];

  gravar(livro);
  return { novas, antigas, resolvidas };
}

/** Registra que estas pendências foram cobradas hoje. */
export function marcarCobradas(dia: string, pedidos: string[]): void {
  const livro = ler();
  for (const p of pedidos) {
    const x = livro[p];
    if (x && !x.cobradaEm.includes(dia)) x.cobradaEm.push(dia);
  }
  gravar(livro);
}

export function emAberto(): Pendencia[] {
  return Object.values(ler()).sort((a, b) => b.valor - a.valor);
}

/** Dias corridos entre dois dias no formato AAAA-MM-DD. */
export function diasEntre(de: string, ate: string): number {
  const ms = new Date(`${ate}T12:00:00-03:00`).getTime() - new Date(`${de}T12:00:00-03:00`).getTime();
  return Math.max(0, Math.round(ms / 86_400_000));
}
