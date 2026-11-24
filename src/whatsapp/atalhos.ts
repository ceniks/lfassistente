/**
 * Perguntas que não precisam do agente.
 *
 * Cada passagem pelo agente custa dezenas de milhares de tokens e de 30 a 60
 * segundos, porque ele carrega o prompt e as ferramentas e decide o que
 * consultar. Para uma pergunta cuja resposta é um número só, isso é
 * desperdício puro: reconhecer a pergunta por padrão de texto custa zero, e a
 * consulta direta leva menos de um segundo.
 */

/**
 * "Quantas peças tem no site?" e variações.
 *
 * Exige as duas coisas — falar de peças/estoque **e** do site/loja — para não
 * sequestrar perguntas parecidas que querem outra coisa ("quantas peças
 * vendemos ontem", "estoque de tecido") e que o agente responde melhor.
 */
export function perguntaDeEstoqueNoSite(texto: string): boolean {
  const t = texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

  const sobreEstoque = /\b(pecas?|estoque|unidades)\b/.test(t);
  const sobreSite = /\b(site|loja|shopify|no ar|disponive(l|is))\b/.test(t);
  const outraCoisa = /\b(vend|tecido|rolo|oficina|producao|corte|galpao|ontem|semana|mes)\w*/.test(t);

  // "estoque no site", seco, já é a pergunta inteira: não exige "quantas".
  return sobreEstoque && sobreSite && !outraCoisa;
}
