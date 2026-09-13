/**
 * Imprime o resumo montado a partir dos números reais de 12/09.
 *
 *   npm run preview
 *
 * Não toca em rede nem precisa de credencial — serve para revisar a forma da
 * mensagem antes de ela existir de verdade.
 */
import { montarResumo } from '../src/digest/format.js';
import { DIA_12_09 } from './fixtures/2026-09-12.js';

const texto = montarResumo(DIA_12_09);

console.log('┌' + '─'.repeat(48) + '┐');
for (const linha of texto.split('\n')) {
  console.log('│ ' + linha.padEnd(46) + ' │');
}
console.log('└' + '─'.repeat(48) + '┘');
console.log(`\n${texto.length} caracteres · limite do WhatsApp por mensagem: 4096`);
