/**
 * Gera a conferência de estorno em PDF.
 *
 *   npm run conferir-estorno-pdf 2026-09-01 2026-09-15
 */
import { writeFile } from 'node:fs/promises';
import { conferirEstorno } from '../data/conciliacao.js';
import { gerarPdfConciliacao } from '../relatorio/pdf-conciliacao.js';
import { temTroque } from '../data/troque.js';
import { ontem } from '../digest/build.js';
import { fecharConexoes } from '../data/mcp-client.js';

const args = process.argv.slice(2).filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const de = args[0] ?? ontem();
const ate = args[1] ?? de;

if (!temTroque()) {
  console.error('\nFalta TROQUE_TOKEN no .env.\n');
  process.exit(1);
}

const inicio = Date.now();
console.log(`\nConferindo ${de} a ${ate}…`);

const c = await conferirEstorno(de, ate);
const pdf = await gerarPdfConciliacao(c);
const nome = `lf-conferencia-estorno-${de}_a_${ate}.pdf`;
await writeFile(nome, pdf);

const divergentes = c.soShopify.length + c.soTroque.length + c.valorDiferente.length;
console.log(
  `\n✓ ${nome} — ${Math.round(pdf.length / 1024)} KB em ${((Date.now() - inicio) / 1000).toFixed(1)}s` +
    `\n  ${divergentes} pedido(s) divergente(s), ${c.batem} conferido(s) batem\n`,
);

await fecharConexoes();
process.exit(0);
