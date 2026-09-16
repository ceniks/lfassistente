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
 * Influencer: pedido de seeding.
 *
 * O sinal principal é o cupom **FRETEINFLUENCERS**, não a tag. Medido em
 * 01–15/09: 70 pedidos de valor zero, todos Draft Orders, 68 com esse cupom —
 * mas só 32 com a tag `Influencer`. Os outros saíram como `MS` (21), `MS
 * OUTUBRO` (6), `Mirelawhats` (2) ou sem tag nenhuma (7). Confiar na tag
 * classificava metade do seeding como venda comum.
 *
 * A tag continua valendo em paralelo, com distância ≤ 2 para erro de digitação:
 * existe ao menos um pedido com a tag e sem o cupom (#137936).
 */
export function isInfluencer(pedido: PedidoClassificavel): boolean {
  const temCupomDeSeeding = pedido.discountCodes.some((c) =>
    norm(c).replace(/\s+/g, '').startsWith('freteinfluencer'),
  );
  if (temCupomDeSeeding) return true;

  return pedido.tags.some((t) => {
    const n = norm(t);
    return n === 'influencer' || levenshtein(n, 'influencer') <= 2;
  });
}

/**
 * Reenvio: peça mandada de novo para a cliente, sem cobrança.
 *
 * Aparece como pedido de R$ 0 com um "cupom" que é na verdade uma anotação —
 * "Envio referente ao numero de pedido 131917/ao remetente". Não é venda (não
 * entrou dinheiro), não é troca (não passou pelo TroqueCommerce) e não é
 * seeding. Sem uma categoria própria, entrava como venda de R$ 0 e puxava o
 * ticket médio para baixo.
 */
export function isReenvio(pedido: PedidoClassificavel): boolean {
  if (pedido.discountCodes.some((c) => norm(c).startsWith('envio referente'))) return true;
  // Rede secundária: a anotação é texto livre e uma letra trocada faria o
  // pedido voltar a contar como venda. Uma tag `reenvio` resolve de vez.
  return pedido.tags.some((t) => norm(t) === 'reenvio');
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
  return !isTroca(pedido) && !isInfluencer(pedido) && !isReenvio(pedido);
}

export type Categoria = 'venda' | 'troca' | 'influencer' | 'reenvio';

export function categoria(pedido: PedidoClassificavel): Categoria {
  if (isInfluencer(pedido)) return 'influencer';
  if (isTroca(pedido)) return 'troca';
  if (isReenvio(pedido)) return 'reenvio';
  return 'venda';
}
