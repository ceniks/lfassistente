import { describe, expect, it } from 'vitest';

/**
 * A conferência do gateway tem uma regra que erra em silêncio se for escrita
 * errada: "o PagBank não tem essa cobrança" e "a consulta falhou" parecem a
 * mesma coisa vistas de fora, e tratar as duas igual inventaria divergência
 * todo dia que o gateway tossisse. Estes testes fixam essa distinção, o
 * cancelamento e a tolerância de centavo.
 */
import { conferir, TOLERANCIA, type Linha } from '../src/data/conferencia-pagbank.js';
import type { TransacaoPagBank } from '../src/data/pagbank.js';

const transacao = (p: Partial<TransacaoPagBank> = {}): TransacaoPagBank => ({
  referencia: 'ref1',
  codigo: 'A6E9',
  data: '2026-09-16T10:00:00-03:00',
  status: 4,
  bruto: 100,
  taxa: 5.93,
  liquido: 94.07,
  valeComoVenda: true,
  ...p,
});

const linha: Linha = {
  pedido: '#1',
  gateway: 'PagBank - Cartão de Crédito',
  referencia: 'ref1',
  valor: 100,
};

describe('conferência do gateway', () => {
  it('aprova quando valor e status batem', () => {
    expect(conferir(linha, transacao()).veredito).toBe('ok');
  });

  it('acusa ausência quando o PagBank não tem a cobrança', () => {
    const r = conferir(linha, null);
    expect(r.veredito).toBe('ausente');
    expect(r.explicacao).toContain('não tem essa cobrança');
  });

  it('acusa status quando a cobrança foi cancelada no PagBank', () => {
    expect(conferir(linha, transacao({ status: 7, valeComoVenda: false })).veredito).toBe('status');
  });

  it('acusa valor quando a diferença passa da tolerância', () => {
    expect(conferir(linha, transacao({ bruto: 100 + TOLERANCIA * 2 })).veredito).toBe('valor');
  });

  it('ignora diferença de arredondamento dentro da tolerância', () => {
    expect(conferir(linha, transacao({ bruto: 100 + TOLERANCIA / 2 })).veredito).toBe('ok');
  });
});
