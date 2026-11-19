/**
 * O boletim que não saiu.
 *
 * Em 09/10 e em 10/11 o boletim ficou pronto e não foi entregue porque o
 * WhatsApp tinha caído; nos dois casos o conserto foi você perceber a
 * ausência e pedir. O e-mail resolveu o aviso; isto resolve a entrega: o dia
 * fica anotado e o vigia de hora em hora refaz a tentativa.
 */
import { criarCaderno, MAX_TENTATIVAS } from "../comum/adiado.js";

const caderno = criarCaderno(
  process.env.BOLETIM_ADIADO ?? "dados/boletim-adiado.json",
);

export { MAX_TENTATIVAS };
export const lerBoletimAdiado = () => caderno.ler();
export const adiarBoletim = (dia: string, motivo: string) =>
  void caderno.adiar(dia, motivo);
export const limparBoletimAdiado = () => caderno.limpar();
