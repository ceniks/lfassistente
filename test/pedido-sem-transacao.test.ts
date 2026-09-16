import { describe, expect, it } from 'vitest';
import { agruparPorDiaDePagamento } from '../src/data/shopify.js';

/**
 * O seeding de influencer sai a R$ 0 e a Shopify marca o pedido como pago sem
 * criar transação — não há dinheiro para capturar. Antes disso ser tratado, o
 * pedido sumia do dia inteiro e a linha de seeding marcava R$ 0 sempre.
 */
const base = {
  id: 'gid://shopify/Order/1',
  name: '#139128',
  tags: ['Influencer'],
  discountCodes: [] as string[],
  app: { name: 'Draft Orders' },
  subtotalPriceSet: null,
  totalDiscountsSet: { shopMoney: { amount: '927.39' } },
  lineItems: { nodes: [] },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pedido = (extra: Record<string, unknown>): any => ({ ...base, ...extra });

describe('dia do pagamento', () => {
  it('usa a captura quando ela existe', () => {
    const p = pedido({
      createdAt: '2026-09-15T13:27:44Z',
      totalPriceSet: { shopMoney: { amount: '450.00' } },
      transactions: [{ kind: 'SALE', status: 'SUCCESS', processedAt: '2026-09-16T02:00:00Z' }],
    });
    expect([...agruparPorDiaDePagamento([p]).keys()]).toEqual(['2026-09-15']);
  });

  it('cai para a data de criação no pedido de R$ 0 sem transação', () => {
    const p = pedido({
      createdAt: '2026-09-15T13:27:44Z',
      totalPriceSet: { shopMoney: { amount: '0.0' } },
      transactions: [],
    });
    expect([...agruparPorDiaDePagamento([p]).keys()]).toEqual(['2026-09-15']);
  });

  it('não adota a criação quando o pedido tem valor e nenhuma captura', () => {
    const p = pedido({
      createdAt: '2026-09-15T13:27:44Z',
      totalPriceSet: { shopMoney: { amount: '450.00' } },
      transactions: [{ kind: 'SALE', status: 'PENDING', processedAt: '2026-09-15T13:27:44Z' }],
    });
    expect(agruparPorDiaDePagamento([p]).size).toBe(0);
  });
});
