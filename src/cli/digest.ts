/**
 * Monta e imprime o resumo de um dia, sem enviar nada.
 *
 *   npm run digest            -> ontem
 *   npm run digest 2026-09-12 -> um dia específico
 *
 * É como conferir a mensagem antes de confiar nela às 8h da manhã. Passe
 * --enviar para mandar de verdade no WhatsApp.
 */
import { construirResumo, ontem } from '../digest/build.js';
import { enviarTextoAosDonos } from '../whatsapp/evolution.js';
import { fecharConexoes } from '../data/mcp-client.js';

const args = process.argv.slice(2);
const enviar = args.includes('--enviar');
const dia = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? ontem();

const texto = await construirResumo(dia);
console.log(texto);
console.log(`\n---\n${texto.length} caracteres`);

if (enviar) {
  await enviarTextoAosDonos(texto);
  console.log('enviado.');
}

// As conexões com os MCPs ficam abertas de propósito — o servidor as reaproveita
// entre uma pergunta e outra. Numa CLI isso vira um processo que imprime tudo e
// nunca termina, e quem estiver lendo pelo pipe não vê nada até matar na unha.
await fecharConexoes();
process.exit(0);
