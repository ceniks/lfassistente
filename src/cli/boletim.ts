/**
 * Gera o boletim completo e salva em arquivo, sem enviar nada.
 *
 *   npm run boletim                 # ontem
 *   npm run boletim 2026-09-13
 *   npm run boletim 2026-09-13 --enviar
 *
 * Serve para conferir o PDF antes de confiar nele — abrir, ver se as tabelas
 * couberam, se o gráfico ficou legível, se nenhum bloco sumiu por falha de
 * fonte de dados.
 */
import { writeFile } from 'node:fs/promises';
import { gerarBoletim } from '../relatorio/index.js';
import { enviarDocumento } from '../whatsapp/evolution.js';
import { fecharConexoes } from '../data/mcp-client.js';
import { exigir } from '../config.js';
import { ontem } from '../digest/build.js';

const args = process.argv.slice(2);
const enviar = args.includes('--enviar');
const dia = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? ontem();

const inicio = Date.now();
console.log(`\nMontando o boletim de ${dia}…`);

const b = await gerarBoletim(dia);

await writeFile(b.nome, b.pdf);
console.log(
  `\n✓ ${b.nome} — ${Math.round(b.pdf.length / 1024)} KB em ${((Date.now() - inicio) / 1000).toFixed(1)}s`,
);

if (enviar) {
  await enviarDocumento(
    exigir('OWNER_PHONE'),
    { nome: b.nome, base64: b.pdf.toString('base64') },
    b.legenda,
  );
  console.log('enviado no WhatsApp.');
}

await fecharConexoes();
process.exit(0);
