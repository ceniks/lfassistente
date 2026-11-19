/**
 * O dia cuja cobrança ficou para depois.
 *
 * A conferência incompleta adia a cobrança — e até aqui adiar era o mesmo que
 * cancelar: ninguém voltava para tentar, e o dia 16/11 passou com três
 * pedidos sem explicação que nunca foram cobrados. O problema era do
 * provedor do extrato, mas o efeito era silêncio.
 *
 * Agora o dia fica anotado e o reteste de hora em hora o retoma, até o
 * extrato responder ou o dia virar — quando o boletim seguinte assume.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const ARQUIVO = process.env.COBRANCA_ADIADA ?? "dados/cobranca-adiada.json";

export interface Adiada {
  dia: string;
  motivo: string;
  tentativas: number;
  desdeEm: string;
}

/** Até quando insistir. Passou disso, o dia seguinte já tem a sua própria. */
export const MAX_TENTATIVAS = 12;

export function lerAdiada(): Adiada | null {
  try {
    return JSON.parse(readFileSync(ARQUIVO, "utf8")) as Adiada;
  } catch {
    return null;
  }
}

export function adiar(dia: string, motivo: string): void {
  const atual = lerAdiada();
  const nova: Adiada =
    atual?.dia === dia
      ? { ...atual, motivo, tentativas: atual.tentativas + 1 }
      : { dia, motivo, tentativas: 1, desdeEm: new Date().toISOString() };
  mkdirSync(dirname(ARQUIVO), { recursive: true });
  writeFileSync(ARQUIVO, JSON.stringify(nova, null, 1));
}

export function limparAdiada(): void {
  try {
    rmSync(ARQUIVO);
  } catch {
    /* já não existia */
  }
}
