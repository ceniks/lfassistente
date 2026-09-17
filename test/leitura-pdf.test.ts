import { describe, expect, it } from 'vitest';
import { limparParaPdf } from '../src/relatorio/pdf.js';

/**
 * A Helvetica do PDFKit usa WinAnsi e não tem emoji: o "📊" da síntese saía
 * como "&þ" no meio da primeira linha do boletim.
 */
describe('limpeza da leitura para o PDF', () => {
  it('tira emoji', () => {
    expect(limparParaPdf('📊 **L&F · quarta** — síntese')).toBe('L&F · quarta — síntese');
  });

  it('tira o negrito de markdown sem comer o texto', () => {
    expect(limparParaPdf('o **ticket** subiu')).toBe('o ticket subiu');
  });

  it('mantém acento, cifrão e travessão', () => {
    expect(limparParaPdf('R$ 82.545 — conversão caiu')).toBe('R$ 82.545 — conversão caiu');
  });

  it('vira bullet a lista de markdown', () => {
    expect(limparParaPdf('- primeiro\n- segundo')).toBe('• primeiro\n• segundo');
  });
});
