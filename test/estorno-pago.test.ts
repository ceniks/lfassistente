import { describe, expect, it } from 'vitest';
import { valorPago, type Reversa } from '../src/data/troque.js';

/**
 * A distinção que custou seis divergências falsas: o Troquecommerce mostra
 * "Valor solicitado" e "Valor Pago" lado a lado, e a API chama o primeiro de
 * `refund_value`. Só o segundo é dinheiro que saiu.
 */
const reversa = (campos: Partial<Reversa>): Reversa =>
  ({ id: '1', status: 'Finalizado', created_at: '2026-09-14', ...campos }) as Reversa;

describe('valorPago', () => {
  it('devolve o pagamento quando ele existe, mesmo diferente do solicitado', () => {
    // #132008: pediu R$ 944,75, recebeu R$ 559,80.
    expect(valorPago(reversa({ refund_value: 944.75, reverse_payment: { value: 559.8 } }))).toBe(
      559.8,
    );
  });

  it('não confunde solicitado com pago quando não houve pagamento', () => {
    expect(valorPago(reversa({ refund_value: 944.75, reverse_payment: null }))).toBeNull();
    expect(valorPago(reversa({ refund_value: 944.75 }))).toBeNull();
  });

  it('aceita pagamento maior que o solicitado', () => {
    // #133516: pediu R$ 6.000, saiu R$ 6.186,21.
    expect(valorPago(reversa({ refund_value: 6000, reverse_payment: { value: 6186.21 } }))).toBe(
      6186.21,
    );
  });

  it('zero pago é zero, não ausência', () => {
    expect(valorPago(reversa({ refund_value: 100, reverse_payment: { value: 0 } }))).toBe(0);
  });
});
