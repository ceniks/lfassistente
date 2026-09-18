/**
 * A taxa de retorno rolante: quanto do que a loja vende volta.
 *
 * É o termômetro que faltava. O boletim contava reversa aberta no dia — número
 * que oscila de 20 a 60 e não diz nada — e o bloco de trocas media movimento,
 * não proporção. Ninguém saberia dizer se devolver ficou mais ou menos comum.
 *
 * Três decisões que fazem esse número significar alguma coisa:
 *
 * **Janela rolante, não mês fechado.** Mês fechado é inútil quase o mês
 * inteiro: no dia 3 de outubro seriam três dias de dado e um número que pula
 * conforme quem devolveu na véspera. A janela anda com o calendário e sempre
 * tem 30 dias.
 *
 * **Peça postada, não reversa aberta.** Abrir é um clique, postar é ir à
 * agência — ver `foiPostada`. Contar as abertas inflava a taxa em cerca de um
 * ponto e meio, e de forma instável, porque o mês corrente sempre tem gente que
 * ainda vai postar. Em 19/08 a 17/09 a diferença era 14,0% contra 12,6%.
 *
 * **Troca e estorno separados.** É a quebra que conta a história: entre as duas
 * janelas de agosto e setembro o estorno mal se mexeu (6,9% para 5,9%) enquanto
 * a troca caiu quase à metade (10,6% para 6,7%). O total sozinho esconderia
 * isso.
 *
 * O limite que fica, e está escrito no relatório: numerador e denominador são
 * coortes diferentes. A peça devolvida hoje foi vendida semanas atrás, então a
 * taxa mistura o retorno de uma safra com a venda de outra. Enquanto a venda é
 * estável não atrapalha; num mês de pico o denominador cresce antes do
 * numerador e a taxa cai sozinha. A correção é amarrar cada reversa ao pedido
 * de origem — o Troquecommerce guarda o número em `replaced_order_ecommerce_number`.
 */
import { pecasVendidasEmDuasJanelas } from "./shopify.js";
import { itensDasReversas, type ItemContado } from "./itens-de-reversa.js";
import {
  foiPostada,
  listar,
  temTroque,
  type Loja,
  type Reversa,
} from "./troque.js";

export const DIAS_DA_JANELA = 30;

export interface Janela {
  de: string;
  ate: string;
  vendidas: number;
  /** Peças que a cliente efetivamente postou de volta. */
  postadas: number;
  trocas: number;
  estornos: number;
  /** Peças de reversa aberta que nunca saíram da casa da cliente. */
  naoPostadas: number;
  /** Reversas cujo detalhe não veio — ficam fora da conta, não contam zero. */
  semDetalhe: number;
  taxa: number;
  taxaDeTroca: number;
  taxaDeEstorno: number;
}

export interface Retorno {
  atual: Janela;
  anterior: Janela;
}

const diasAntes = (dia: string, n: number) => {
  const d = new Date(`${dia}T12:00:00-03:00`);
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

function contar(
  reversas: Reversa[],
  itens: Map<string, ItemContado[]>,
  de: string,
  ate: string,
) {
  let postadas = 0;
  let trocas = 0;
  let estornos = 0;
  let naoPostadas = 0;
  let semDetalhe = 0;

  for (const r of reversas) {
    const dia = r.created_at.slice(0, 10);
    if (dia < de || dia > ate) continue;

    const lista = itens.get(r.id);
    if (!lista) {
      semDetalhe += 1;
      continue;
    }

    for (const item of lista) {
      if (!foiPostada(r)) {
        naoPostadas += item.q;
        continue;
      }
      postadas += item.q;
      if (item.troca) trocas += item.q;
      else estornos += item.q;
    }
  }

  return { postadas, trocas, estornos, naoPostadas, semDetalhe };
}

export async function retornoRolante(
  dia: string,
  loja: Loja = "atual",
): Promise<Retorno | null> {
  if (!temTroque(loja)) return null;

  const inicioAtual = diasAntes(dia, DIAS_DA_JANELA - 1);
  const inicioAnterior = diasAntes(dia, DIAS_DA_JANELA * 2 - 1);
  const fimAnterior = diasAntes(dia, DIAS_DA_JANELA);

  const [vendas, reversas] = await Promise.all([
    pecasVendidasEmDuasJanelas(inicioAnterior, inicioAtual, dia),
    listar({ criadaDe: inicioAnterior, criadaAte: dia }, loja),
  ]);

  // A listagem não traz os itens, e é no item que mora a quantidade e a
  // separação entre troca e estorno. O cache busca só o que ainda não viu.
  const itens = await itensDasReversas(reversas, loja);

  const montar = (de: string, ate: string, vendidas: number): Janela => {
    const c = contar(reversas, itens, de, ate);
    const sobre = (x: number) => (vendidas > 0 ? x / vendidas : 0);
    return {
      de,
      ate,
      vendidas,
      ...c,
      taxa: sobre(c.postadas),
      taxaDeTroca: sobre(c.trocas),
      taxaDeEstorno: sobre(c.estornos),
    };
  };

  return {
    atual: montar(inicioAtual, dia, vendas.atual),
    anterior: montar(inicioAnterior, fimAnterior, vendas.anterior),
  };
}
