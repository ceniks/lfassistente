/**
 * Cronometra cada etapa do resumo, isoladamente.
 *
 *   npm run tempos 2026-09-12
 *
 * Existe porque "o resumo demorou" não é diagnóstico: as fontes são seis e uma
 * só delas travando parece igual a todas lentas. Aqui cada uma responde por si.
 */
import { vendasPorDia, trafegoDoDia } from '../data/shopify.js';
import { midiaDoDia } from '../data/meta.js';
import { midiaGoogleDoDia, temGoogleAds } from '../data/google.js';
import { metaDoDia } from '../data/metas.js';
import { producaoAtual } from '../data/producao.js';
import { atendimentoAtual } from '../data/atendimento.js';
import { perguntarSemContexto } from '../agent/runner.js';
import { ontem } from '../digest/build.js';

const dia = process.argv[2] ?? ontem();

async function cronometrar(nome: string, f: () => Promise<unknown>) {
  const t = Date.now();
  try {
    const r = await f();
    const ms = Date.now() - t;
    const amostra = JSON.stringify(r ?? null).slice(0, 90);
    console.log(`${String(ms).padStart(7)} ms  ✓ ${nome.padEnd(14)} ${amostra}`);
  } catch (e) {
    const ms = Date.now() - t;
    console.log(
      `${String(ms).padStart(7)} ms  ✗ ${nome.padEnd(14)} ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`,
    );
  }
}

const dias = Array.from({ length: 8 }, (_, i) => {
  const d = new Date(`${dia}T12:00:00-03:00`);
  d.setDate(d.getDate() - i);
  return d.toISOString().slice(0, 10);
});

console.log(`\ndia ${dia}\n`);

await cronometrar('shopify 8 dias', () => vendasPorDia(dias));
await cronometrar('tráfego 1 dia', () => trafegoDoDia(dia));
await cronometrar('tráfego 7 par.', () => Promise.all(dias.slice(1).map((d) => trafegoDoDia(d))));
await cronometrar('meta', () => midiaDoDia(dia));
await cronometrar('google', () => (temGoogleAds() ? midiaGoogleDoDia(dia) : Promise.resolve(null)));
await cronometrar('metas planilha', () => metaDoDia(dia));
await cronometrar('produção', () => producaoAtual());
await cronometrar('atendimento', () => atendimentoAtual(dia));
await cronometrar('agente', () => perguntarSemContexto('Responda apenas: ok'));

console.log('\n');
process.exit(0);
