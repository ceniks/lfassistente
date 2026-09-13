import cron from 'node-cron';
import { config } from './config.js';
import { criarApp } from './whatsapp/webhook.js';
import { enviarTexto } from './whatsapp/evolution.js';
import { construirResumo, ontem } from './digest/build.js';

const c = config();

/* ------------------------------------------------------------------ *
 * Webhook
 * ------------------------------------------------------------------ */

const app = criarApp();

app.listen(c.PORT, () => {
  console.log(`[lf-assistant] ouvindo na porta ${c.PORT}`);
  console.log(`[lf-assistant] resumo agendado: ${c.DIGEST_CRON} (${c.TZ})`);
});

/* ------------------------------------------------------------------ *
 * Resumo diário
 * ------------------------------------------------------------------ *
 *
 * node-cron dentro do processo, não o cron do Railway. Três motivos:
 *
 *  - O cron do Railway roda em UTC. 08:00 de São Paulo seria `0 11 * * *`, e
 *    toda mudança de horário viraria uma conversão manual. Aqui o fuso é
 *    declarado e o horário é o que está escrito.
 *  - O cron do Railway exige que o processo termine, e pula a execução seguinte
 *    se a anterior ainda estiver rodando — silenciosamente.
 *  - Este processo já está de pé 24/7 por causa do webhook. Um serviço a menos.
 */

cron.schedule(
  c.DIGEST_CRON,
  async () => {
    const dia = ontem();
    console.log(`[digest] montando resumo de ${dia}`);

    try {
      const texto = await construirResumo(dia);
      await enviarTexto(c.OWNER_PHONE, texto);
      console.log(`[digest] enviado (${texto.length} caracteres)`);
    } catch (e) {
      console.error('[digest] falhou:', e);
      // Silêncio às 8h é pior que uma mensagem de erro: sem aviso, o Luis
      // pensa que o dia foi fraco quando na verdade o resumo não rodou.
      await enviarTexto(
        c.OWNER_PHONE,
        `⚠️ Não consegui montar o resumo de ${dia}.\n\n${e instanceof Error ? e.message : String(e)}`,
      ).catch(() => undefined);
    }
  },
  { timezone: c.TZ },
);

/* ------------------------------------------------------------------ *
 * Encerramento
 * ------------------------------------------------------------------ */

for (const sinal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sinal, () => {
    console.log(`[lf-assistant] ${sinal} recebido, encerrando`);
    process.exit(0);
  });
}

process.on('unhandledRejection', (motivo) => {
  console.error('[lf-assistant] promise rejeitada sem tratamento:', motivo);
});
