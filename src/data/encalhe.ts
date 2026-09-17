/**
 * O outro lado do estoque: o que não vende.
 *
 * O bloco dos campeões responde "o que está acabando". Ninguém respondia "o
 * que está parado", e é ali que o capital some sem fazer barulho: peça sem
 * giro não gera alerta, não aparece no topo de lista nenhuma, e continua
 * ocupando dinheiro e galpão indefinidamente. Em 17/09/2026 eram 35.491 peças
 * no site e R$ 2,18 milhões de custo — basta uma fatia disso estar imóvel para
 * valer mais que qualquer otimização de campanha.
 *
 * A régua é a venda dos últimos 15 dias, a mesma da cobertura, para que os dois
 * blocos não discordem. Duas situações, e elas são diferentes:
 *
 *  - **sem giro**: nenhuma unidade vendida na janela. É o caso grave.
 *  - **excesso**: vende, mas tem estoque muito além do que o ritmo consome.
 *
 * A primeira régua que tentei — "mais de 90 dias de cobertura" — marcava o
 * Blazer Las Vegas e a Calça Barcelona, os dois campeões do dia, como
 * encalhados. Não estavam: vendem 650 e 835 peças em 15 dias, só têm estoque
 * fundo. Nessa régua 77% do estoque da loja virava alerta, e alerta que pega
 * tudo não pega nada.
 *
 * O que separa de verdade não é a cobertura, é o **excesso**: quanto de estoque
 * existe ACIMA do que 90 dias de venda consumiriam. O campeão com 109 dias tem
 * excesso quase nulo; a peça com 2.432 dias tem excesso de quase tudo. E o que
 * ordena é o custo desse excesso, não a quantidade: 50 blazers prendem mais
 * dinheiro que 300 regatas.
 */
import { estoqueDaLoja, type PeriodoDeVendas } from "./shopify.js";
import { tabelaDeCusto } from "./patrimonio.js";

/** Acima disso, o estoque atual demora demais para virar dinheiro. */

/**
 * Cobertura considerada saudável. Estoque além disso é o excesso.
 *
 * 90 dias é o ciclo da L&F: corte, oficina, caseado e chegada ao galpão levam
 * semanas, então estoque curto demais vira ruptura. O que passa disso já não
 * cobre risco, está parado.
 */
const DIAS_ALVO = 90;

export type SituacaoDeGiro = "sem-giro" | "excesso";

export interface Encalhado {
  titulo: string;
  unidades: number;
  /** A preço de etiqueta. */
  valorDeVenda: number;
  /** Custo parado. `null` quando o modelo não tem corte no Corte Pro. */
  custo: number | null;
  vendidas15d: number;
  /** Dias para o estoque acabar no ritmo da janela. `null` quando não vende. */
  diasParaAcabar: number | null;
  /** Peças acima do que 90 dias de venda consumiriam. */
  excesso: number;
  /** O custo dessas peças — é este número que importa. */
  custoDoExcesso: number | null;
  situacao: SituacaoDeGiro;
}

export interface Encalhe {
  itens: Encalhado[];
  semGiro: { produtos: number; unidades: number; custo: number };
  excesso: { produtos: number; unidades: number; custo: number };
  /** Quanto do estoque total está parado, para dar escala ao número. */
  unidadesNaLoja: number;
  custoNaLoja: number;
  /** Produtos sem custo no Corte Pro: o total parado é piso, não valor exato. */
  produtosSemCusto: number;
}

export async function estoqueParado(
  periodo: PeriodoDeVendas,
): Promise<Encalhe> {
  const [estoque, custoDe] = await Promise.all([
    estoqueDaLoja(),
    tabelaDeCusto(),
  ]);

  const dias = Math.max(1, periodo.diasComVenda);
  const itens: Encalhado[] = [];
  let unidadesNaLoja = 0;
  let custoNaLoja = 0;
  let produtosSemCusto = 0;

  for (const item of estoque) {
    unidadesNaLoja += item.unidades;
    const unitario = custoDe(item.titulo);
    const custo = unitario !== undefined ? unitario * item.unidades : null;
    if (custo === null) produtosSemCusto++;
    else custoNaLoja += custo;

    if (item.unidades <= 0) continue;

    const vendidas15d =
      periodo.unidadesPorProduto.get(item.titulo)?.unidades ?? 0;
    const porDia = vendidas15d / dias;
    const diasParaAcabar = porDia > 0 ? item.unidades / porDia : null;

    const excesso = Math.max(0, Math.round(item.unidades - porDia * DIAS_ALVO));
    if (excesso === 0) continue;

    itens.push({
      titulo: item.titulo,
      unidades: item.unidades,
      valorDeVenda: item.valorDeVenda,
      custo,
      vendidas15d,
      diasParaAcabar,
      excesso,
      custoDoExcesso: unitario !== undefined ? unitario * excesso : null,
      situacao: vendidas15d === 0 ? "sem-giro" : "excesso",
    });
  }

  // O custo do excesso manda na ordem. Produto sem custo conhecido cai para o
  // fim: ele não pode competir por um número que não temos.
  itens.sort((a, b) => (b.custoDoExcesso ?? -1) - (a.custoDoExcesso ?? -1));

  const soma = (s: SituacaoDeGiro) => {
    const desses = itens.filter((i) => i.situacao === s);
    return {
      produtos: desses.length,
      unidades: desses.reduce((t, i) => t + i.excesso, 0),
      custo: desses.reduce((t, i) => t + (i.custoDoExcesso ?? 0), 0),
    };
  };

  return {
    itens,
    semGiro: soma("sem-giro"),
    excesso: soma("excesso"),
    unidadesNaLoja,
    custoNaLoja,
    produtosSemCusto,
  };
}
