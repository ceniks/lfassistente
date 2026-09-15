import { describe, expect, it } from 'vitest';
import { categoriaDoProduto } from '../src/data/shopify.js';

describe('categoriaDoProduto', () => {
  it('usa a primeira palavra do nome da peça', () => {
    expect(categoriaDoProduto('Calça Londres')).toBe('Calça');
    expect(categoriaDoProduto('Blazer Filadélfia')).toBe('Blazer');
    expect(categoriaDoProduto('Casaco Roma')).toBe('Casaco');
  });

  it('aguenta o espaço duplo que existe no catálogo', () => {
    // "Calça  Barcelona" está assim na loja, com dois espaços.
    expect(categoriaDoProduto('Calça  Barcelona')).toBe('Calça');
  });

  it('normaliza a caixa para não criar duas categorias do mesmo tipo', () => {
    expect(categoriaDoProduto('CAMISA Teodora')).toBe('Camisa');
    expect(categoriaDoProduto('camisa Teodora')).toBe('Camisa');
  });

  it('não quebra com título vazio', () => {
    expect(categoriaDoProduto('   ')).toBe('Sem categoria');
  });
});
