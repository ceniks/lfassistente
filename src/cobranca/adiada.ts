/**
 * O dia cuja cobrança ficou para depois.
 *
 * A conferência incompleta adia a cobrança — e até existir o reteste, adiar
 * era o mesmo que cancelar: o dia 16/11 passou com três pedidos sem
 * explicação, R$ 1.049,74, que nunca foram cobrados. O problema era do
 * provedor do extrato; o efeito era silêncio.
 */
import { criarCaderno, MAX_TENTATIVAS } from "../comum/adiado.js";

const caderno = criarCaderno(
  process.env.COBRANCA_ADIADA ?? "dados/cobranca-adiada.json",
);

export { MAX_TENTATIVAS };
export type { Adiado as Adiada } from "../comum/adiado.js";

export const lerAdiada = () => caderno.ler();
export const adiar = (dia: string, motivo: string) =>
  void caderno.adiar(dia, motivo);
export const limparAdiada = () => caderno.limpar();
