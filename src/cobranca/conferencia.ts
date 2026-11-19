/**
 * A conferência mínima para cobrar, sem montar o boletim inteiro.
 *
 * A cobrança precisa de cinco blocos: PagBank, Mercado Pago, pagos à mão, Pix
 * no extrato e comprovantes. O boletim traz isso e mais trinta coisas —
 * campanha por campanha do Meta, quinze dias de vendas, o funil de reversas —
 * e leva uns três minutos. Refazer tudo isso de hora em hora só para tentar
 * cobrar de novo seria pagar caro por nada.
 */
import { conferirPagBank, conferirMercadoPago } from "../data/conferencia-pagbank.js";
import { conferirPagosAMao } from "../data/conferencia-manual.js";
import { conferirPixDireto } from "../data/conferencia-pix.js";
import { conferirComprovantes } from "../data/conferencia-comprovantes.js";
import { conferirContrapartida } from "../data/contrapartida.js";
import type { ConferenciaParaCobranca } from "./index.js";

export async function conferenciaParaCobranca(dia: string): Promise<ConferenciaParaCobranca> {
  const [pagbank, mercadopago, manual] = await Promise.all([
    conferirPagBank(dia).catch(() => null),
    conferirMercadoPago(dia).catch(() => null),
    conferirPagosAMao(dia).catch(() => null),
  ]);

  const pix = await conferirPixDireto(dia, manual).catch(() => null);
  const comprovantes = await conferirComprovantes(dia, manual).catch(() => null);

  /*
   * A receita não importa aqui: a cobrança usa a lista de divergências, não a
   * cobertura. Passar 0 faria `cobertura` virar 1 e esconder nada.
   */
  const contrapartida = conferirContrapartida(
    { receitaTotal: 0 } as never,
    pagbank,
    mercadopago,
    manual,
    pix,
    comprovantes,
  );

  return { contrapartida, manual, pix, comprovantes };
}
