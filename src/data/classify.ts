/**
 * Regras de classificação de pedidos da L&F.
 *
 * Verificadas contra a loja em 13/set/2026. Duas descobertas moldam este arquivo:
 *
 *  1. A busca do Shopify NÃO aceita wildcard em tag (`tag:influ*` devolve zero) e
 *     não casa a origem do pedido por nome nem por id (`source_name:14177927169`
 *     devolve zero, mesmo sendo esse o sourceName real do TroqueCommerce).
 *  2. Logo, a classificação não pode sair de uma query — sai da leitura dos
 *     pedidos do dia, que já precisamos fazer para somar o faturamento pago.
 */

export interface PedidoClassificavel {
  name: string;
  app?: { name?: string | null } | null;
  discountCodes: string[];
  tags: string[];
}

/**
 * Normaliza texto para comparação: remove acentos, baixa a caixa e apara.
 *
 * Precisa valer para tags E para cupons. Em 12/09 o mesmo cupom aparece como
 * `MEUCARRINHO` em três pedidos e `meucarrinho` em outro; sem normalizar, a
 * quebra de desconto contaria os dois como cupons diferentes. A tag de
 * influencer, por sua vez, está gravada como `Influencer` com maiúscula.
 */
export function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

/**
 * Distância de Levenshtein, usada só em strings curtas (nomes de tag).
 * Implementação em duas linhas de matriz para não alocar a matriz inteira.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let anterior = Array.from({ length: b.length + 1 }, (_, i) => i);
  let atual = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    atual[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const custo = a[i - 1] === b[j - 1] ? 0 : 1;
      atual[j] = Math.min(
        atual[j - 1] + 1, // inserção
        anterior[j] + 1, // remoção
        anterior[j - 1] + custo, // substituição
      );
    }
    [anterior, atual] = [atual, anterior];
  }

  return anterior[b.length];
}

/**
 * Troca: cupom no formato TROCA##### + 3 letras (gerado automaticamente pelo
 * TroqueCommerce), ou pedido criado pelo app do TroqueCommerce.
 *
 * Usamos `startsWith('troca')` em vez do regex estrito porque existe ao menos um
 * cupom fora do padrão na loja (`Trocateste`), e porque um cupom de troca criado
 * à mão amanhã deve continuar sendo pego.
 */
export function isTroca(pedido: PedidoClassificavel): boolean {
  const app = norm(pedido.app?.name ?? '');
  if (app.includes('troque')) return true;
  return pedido.discountCodes.some((c) => norm(c).startsWith('troca'));
}

/**
 * Influencer: pedido de seeding, marcado com a tag `Influencer` no momento da
 * criação. Sai com valor zero e carrega "Desconto personalizado" +
 * FRETEINFLUENCERS.
 *
 * A distância ≤ 2 cobre erro de digitação sem depender da busca do Shopify, que
 * não faz prefixo em tag. Em 90 dias não apareceu nenhuma variação de grafia —
 * a tolerância é seguro, não remendo.
 */
export function isInfluencer(pedido: PedidoClassificavel): boolean {
  return pedido.tags.some((t) => {
    const n = norm(t);
    return n === 'influencer' || levenshtein(n, 'influencer') <= 2;
  });
}

/**
 * Entra no faturamento, no ticket médio e no top de produtos.
 *
 * `pagoNoDia` vem da consulta, não daqui: são os pedidos cujo pagamento foi
 * confirmado na data de referência, independente de quando o pedido foi criado.
 *
 * Draft orders de venda assistida (tag de vendedora) NÃO são excluídos — são
 * venda real. Em 12/09 foram 10 pedidos, todos pagos, com ticket de R$ 573,04
 * contra R$ 550,41 do dia.
 */
export function contaNoFaturamento(pedido: PedidoClassificavel): boolean {
  return !isTroca(pedido) && !isInfluencer(pedido);
}

export type Categoria = 'venda' | 'troca' | 'influencer';

export function categoria(pedido: PedidoClassificavel): Categoria {
  if (isInfluencer(pedido)) return 'influencer';
  if (isTroca(pedido)) return 'troca';
  return 'venda';
}
