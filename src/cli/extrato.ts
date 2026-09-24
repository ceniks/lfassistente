/**
 * O extrato das contas pelo Open Finance, na mão.
 *
 *   npm run extrato                      # contas e últimas entradas por Pix
 *   npm run extrato -- 2026-09-22        # só um dia
 *   npm run extrato -- --sincronizar     # pede atualização ao provedor antes
 *
 * Existe para responder "o extrato está atrasado?" sem abrir painel nenhum, e
 * para forçar a sincronização quando estiver.
 */
import { contas, entradasPix, sincronizar, temOpenFinance } from '../data/openfinance.js';

if (!temOpenFinance()) {
  console.error('Falta MCP_AI_KEY no .env.');
  process.exit(1);
}

if (process.argv.includes('--sincronizar')) {
  // A sincronização é demorada e o provedor responde 502 quando passa do teto
  // do proxy — o pedido segue valendo do lado de lá, então isso é aviso, não
  // erro que deva parar a leitura do extrato.
  try {
    console.log(`sincronizando… ${await sincronizar()} conexão(ões) atualizadas\n`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`sincronização não confirmou (${msg.slice(0, 80)}…) — seguindo com o que já está guardado\n`);
  }
}

for (const c of await contas()) {
  console.log(`${c.banco.padEnd(20)} ${c.tipo.padEnd(24)} ${c.numero.padEnd(16)} R$ ${c.saldo.toFixed(2)}`);
}

const dia = process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const ate = dia ?? new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
const de = dia ?? (() => {
  const d = new Date();
  d.setDate(d.getDate() - 6);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
})();

const entradas = await entradasPix(de, ate);
console.log(`\nentradas por Pix de ${de} a ${ate}: ${entradas.length}`);
for (const e of entradas) {
  console.log(`  ${e.quando}  R$ ${e.valor.toFixed(2).padStart(10)}  ${e.quem.slice(0, 44)}`);
}
if (entradas.length) console.log(`\nlançamento mais recente: ${entradas.map((e) => e.quando).sort().at(-1)}`);
