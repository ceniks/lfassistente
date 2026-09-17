/**
 * O outro lado do estoque: o que não gira.
 *
 * O bloco dos campeões responde "o que está acabando". Ninguém respondia "o que
 * está parado", e é ali que o capital some sem fazer barulho: peça sem giro não
 * dispara alerta, não aparece no topo de lista nenhuma, e segue ocupando
 * dinheiro e galpão indefinidamente.
 *
 * As duas regras são do Luis, e juntas elas descrevem estoque parado de
 * verdade:
 *
 *  1. **250 peças ou mais**, mantidas nos últimos 30 dias. Abaixo disso, giro
 *     lento é grade normal de fim de coleção, não capital preso.
 *  2. **menos de 7 unidades por dia**, na média de 30 dias. Esse é o piso do
 *     que a operação considera um produto vivo.
 *  3. **cadastrado há mais de 30 dias**. Produto recém-lançado nasce com
 *     estoque cheio e venda pequena — é lançamento, não encalhe. Sem esta
 *     regra, toda coleção nova entraria na lista no mês seguinte à estreia.
 *
 * Uma limitação que precisa estar escrita: a Shopify informa o estoque de
 * AGORA, não o histórico. "Manteve 250 peças nos últimos 30 dias" é lido como
 * "tem 250 peças hoje e vendeu pouco no período" — o que é quase sempre a mesma
 * coisa, já que vender pouco não derruba estoque. A regra da idade do cadastro
 * cobre o caso mais óbvio (produto que nem existia há 30 dias), mas não o corte
 * de reposição que chegou esta semana num produto antigo. Para isso só serve
 * histórico: gravar o estoque todo dia a partir de hoje resolve em um mês.
 *
 * O que ordena a lista é o custo do excesso, não a quantidade: 50 blazers
 * prendem mais dinheiro que 300 regatas. Excesso é o estoque acima do que 90
 * dias de venda consumiriam — sem ele, os próprios campeões apareciam aqui, e
 * alerta que pega tudo não pega nada.
 */
import { estoqueDaLoja, unidadesVendidasEm } from "./shopify.js";
import { tabelaDeCusto } from "./patrimonio.js";

/** Regra do Luis: abaixo disso não é capital preso, é grade normal. */
const MINIMO_DE_ESTOQUE = 250;
/** Regra do Luis: o piso do que a operação considera um produto vivo. */
const MAXIMO_POR_DIA = 7;
/** Regra do Luis: produto novo não está parado, está estreando. */
const IDADE_MINIMA_EM_DIAS = 30;
/** A janela das regras. */
export const DIAS_DA_JANELA = 30;

/**
 * Cobertura considerada saudável, usada só para medir o excesso em reais.
 *
 * 90 dias é o ciclo da L&F: corte, oficina, caseado e chegada ao galpão levam
 * semanas, então estoque curto demais vira ruptura. O que passa disso já não
 * cobre risco, está parado.
 */
const DIAS_ALVO = 90;

export interface Encalhado {
  titulo: string;
  unidades: number;
  /** A preço de etiqueta. */
  valorDeVenda: number;
  /** Custo do estoque inteiro. `null` quando o modelo não tem corte no Corte Pro. */
  custo: number | null;
  vendidas: number;
  /** Média diária na janela de 30 dias. */
  porDia: number;
  /** Dias para o estoque acabar nesse ritmo. `null` quando não vende. */
  diasParaAcabar: number | null;
  /** Peças acima do que 90 dias de venda consumiriam. */
  excesso: number;
  /** O custo dessas peças — é este número que importa. */
  custoDoExcesso: number | null;
  /** Não vendeu nenhuma unidade na janela. */
  semGiro: boolean;
}

export interface Encalhe {
  itens: Encalhado[];
  produtos: number;
  unidades: number;
  /** Custo do estoque inteiro dos produtos que caíram na regra. */
  custo: number;
  /** Custo só do excesso — o que dá para liberar sem criar ruptura. */
  custoDoExcesso: number;
  semGiro: { produtos: number; unidades: number };
  /**
   * Produtos que passam nas duas regras mas têm cobertura saudável mesmo assim.
   *
   * Acontece por aritmética: 250 peças vendendo 6,9 por dia dão 36 dias de
   * cobertura, que é pouco, não muito. Eles entram na contagem porque a regra é
   * a regra, mas não são capital preso, e o relatório precisa dizer quantos são
   * para o total não ser lido como se tudo ali estivesse parado.
   */
  semExcesso: number;
  /** Quanto do estoque total isso representa, para dar escala. */
  unidadesNaLoja: number;
  custoNaLoja: number;
  /** Produtos sem custo no Corte Pro: o total é piso, não valor exato. */
  produtosSemCusto: number;
  dias: number;
  minimoDeEstoque: number;
  maximoPorDia: number;
  idadeMinima: number;
  /** Produtos que passariam nas outras regras mas são novos demais. */
  novosDemais: number;
}

export async function estoqueParado(ate: string): Promise<Encalhe> {
  const inicio = new Date(`${ate}T12:00:00-03:00`);
  inicio.setDate(inicio.getDate() - (DIAS_DA_JANELA - 1));
  const de = inicio.toISOString().slice(0, 10);

  const [estoque, custoDe, vendidasPorProduto] = await Promise.all([
    estoqueDaLoja(),
    tabelaDeCusto(),
    unidadesVendidasEm(de, ate),
  ]);

  const itens: Encalhado[] = [];
  let unidadesNaLoja = 0;
  let custoNaLoja = 0;
  let produtosSemCusto = 0;
  let novosDemais = 0;

  for (const item of estoque) {
    unidadesNaLoja += item.unidades;
    const unitario = custoDe(item.titulo);
    const custo = unitario !== undefined ? unitario * item.unidades : null;
    if (custo === null) produtosSemCusto++;
    else custoNaLoja += custo;

    if (item.unidades < MINIMO_DE_ESTOQUE) continue;

    const vendidas = vendidasPorProduto.get(item.titulo) ?? 0;
    const porDia = vendidas / DIAS_DA_JANELA;
    if (porDia >= MAXIMO_POR_DIA) continue;

    // Lançamento nasce com estoque cheio e venda pequena. Sem esta regra, toda
    // coleção nova cairia aqui no mês seguinte à estreia.
    const idade = (Date.now() - new Date(item.criadoEm).getTime()) / 86_400_000;
    if (idade < IDADE_MINIMA_EM_DIAS) {
      novosDemais++;
      continue;
    }

    const diasParaAcabar = porDia > 0 ? item.unidades / porDia : null;
    const excesso = Math.max(0, Math.round(item.unidades - porDia * DIAS_ALVO));

    itens.push({
      titulo: item.titulo,
      unidades: item.unidades,
      valorDeVenda: item.valorDeVenda,
      custo,
      vendidas,
      porDia,
      diasParaAcabar,
      excesso,
      custoDoExcesso: unitario !== undefined ? unitario * excesso : null,
      semGiro: vendidas === 0,
    });
  }

  // O custo do excesso manda na ordem. Produto sem custo conhecido cai para o
  // fim: ele não pode competir por um número que não temos.
  itens.sort((a, b) => (b.custoDoExcesso ?? -1) - (a.custoDoExcesso ?? -1));

  const semGiro = itens.filter((i) => i.semGiro);

  return {
    itens,
    produtos: itens.length,
    unidades: itens.reduce((t, i) => t + i.unidades, 0),
    custo: itens.reduce((t, i) => t + (i.custo ?? 0), 0),
    custoDoExcesso: itens.reduce((t, i) => t + (i.custoDoExcesso ?? 0), 0),
    semGiro: {
      produtos: semGiro.length,
      unidades: semGiro.reduce((t, i) => t + i.unidades, 0),
    },
    semExcesso: itens.filter((i) => i.excesso === 0).length,
    unidadesNaLoja,
    custoNaLoja,
    produtosSemCusto,
    dias: DIAS_DA_JANELA,
    minimoDeEstoque: MINIMO_DE_ESTOQUE,
    maximoPorDia: MAXIMO_POR_DIA,
    idadeMinima: IDADE_MINIMA_EM_DIAS,
    novosDemais,
  };
}
