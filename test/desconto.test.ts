import { describe, expect, it } from 'vitest';
import { quebraDeDesconto } from '../src/data/shopify.js';

/**
 * Os casos vêm de pedidos reais de 13/09/2026. O primeiro é o que motivou a
 * mudança: promoção do site e cupom no mesmo pedido, com o cupom valendo uma
 * fração do total.
 */

const pedido = (
  total: string,
  alocacoes: Array<[valor: string, tipo: string, codigo?: string]>,
) =>
  ({
    name: '#teste',
    discountCodes: alocacoes.filter((a) => a[2]).map((a) => a[2]!),
    tags: [],
    id: 'gid://x',
    createdAt: '',
    totalPriceSet: { shopMoney: { amount: '0' } },
    subtotalPriceSet: null,
    totalDiscountsSet: { shopMoney: { amount: total } },
    transactions: [],
    lineItems: {
      nodes: [
        {
          title: 'item',
          quantity: 1,
          discountAllocations: alocacoes.map(([valor, tipo, codigo]) => ({
            allocatedAmountSet: { shopMoney: { amount: valor } },
            discountApplication: { __typename: tipo, code: codigo ?? null },
          })),
        },
      ],
    },
  }) as unknown as Parameters<typeof quebraDeDesconto>[0];

describe('quebraDeDesconto', () => {
  it('separa a promoção do site do cupom no mesmo pedido (#138767)', () => {
    const q = quebraDeDesconto(
      pedido('232.39', [
        ['199.90', 'AutomaticDiscountApplication'],
        ['32.49', 'DiscountCodeApplication', 'STEFANIFRIZZO'],
      ]),
    );
    expect(q.cupom).toBeCloseTo(32.49, 2);
    expect(q.promocaoAutomatica).toBeCloseTo(199.9, 2);
  });

  it('não credita ao cupom o desconto inteiro só porque existe um cupom', () => {
    const q = quebraDeDesconto(
      pedido('297.89', [
        ['269.90', 'AutomaticDiscountApplication'],
        ['27.99', 'DiscountCodeApplication', 'NEWIN5'],
      ]),
    );
    expect(q.cupom).toBeLessThan(q.promocaoAutomatica);
  });

  it('ignora cupom de troca: é crédito de compra anterior, não desconto', () => {
    const q = quebraDeDesconto(
      pedido('500.00', [['500.00', 'DiscountCodeApplication', 'TROCA110168ZNV']]),
    );
    expect(q.cupom).toBe(0);
    expect(q.promocaoAutomatica).toBe(0);
  });

  it('promoção sozinha não vira cupom', () => {
    const q = quebraDeDesconto(pedido('440.00', [['440.00', 'AutomaticDiscountApplication']]));
    expect(q.cupom).toBe(0);
    expect(q.promocaoAutomatica).toBeCloseTo(440, 2);
  });

  it('desconto sem alocação nenhuma (frete) cai em promoção, não some', () => {
    const q = quebraDeDesconto(pedido('30.00', []));
    expect(q.promocaoAutomatica).toBeCloseTo(30, 2);
    expect(q.cupom).toBe(0);
  });
});
