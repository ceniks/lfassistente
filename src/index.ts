import cron from 'node-cron';
import { exigirConfigCompleta } from './config.js';
import { criarApp } from './whatsapp/webhook.js';
import { enviarDocumentoAosDonos, enviarTextoAosDonos } from './whatsapp/evolution.js';
import { construirResumo, ontem } from './digest/build.js';
import { verificarContas } from './vigia.js';
import { boletimTerminou, resumoComecou, resumoTerminou } from './digest/estado.js';
import { gerarBoletim } from './relatorio/index.js';

// Valida o conjunto obrigatório antes de qualquer coisa subir.
const c = exigirConfigCompleta();

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

    resumoComecou(dia);

    try {
      // Teto na montagem inteira. Cada fonte já tem o seu, mas um teto de fora
      // garante que às 8h sai boletim ou sai erro — nunca silêncio.
      const texto = await Promise.race([
        construirResumo(dia),
        new Promise<never>((_, rejeitar) =>
          setTimeout(() => rejeitar(new Error('montagem passou de 10 minutos')), 10 * 60_000),
        ),
      ]);
      const entregues = await enviarTextoAosDonos(texto);
      if (entregues === 0) throw new Error('resumo pronto, mas nenhum número recebeu');
      resumoTerminou('enviado');
      console.log(`[digest] enviado para ${entregues} número(s) (${texto.length} caracteres)`);

      // O PDF vai depois, e com try próprio: o resumo em texto é o que não
      // pode faltar. Se o boletim quebrar — uma fonte fora do ar, a API de
      // texto sem crédito — o dia já foi entregue e a falha fica registrada
      // no /diag em vez de derrubar o que já deu certo.
      await enviarBoletim(dia);
    } catch (e) {
      resumoTerminou('falhou', e instanceof Error ? e.message : String(e));
      console.error('[digest] falhou:', e);
      // Silêncio às 8h é pior que uma mensagem de erro: sem aviso, o Luis
      // pensa que o dia foi fraco quando na verdade o resumo não rodou.
      await enviarTextoAosDonos(
        `⚠️ Não consegui montar o resumo de ${dia}.\n\n${e instanceof Error ? e.message : String(e)}`,
      ).catch(() => undefined);
    }
  },
  { timezone: c.TZ },
);

/* ------------------------------------------------------------------ *
 * Vigia da conta de anúncios
 * ------------------------------------------------------------------ *
 *
 * De hora em hora, não uma vez por dia. Uma conta suspensa por fatura em aberto
 * derruba a mídia inteira, e esperar até as 8h da manhã seguinte custaria um dia
 * de veiculação. Só avisa quando o estado muda, para não virar ruído.
 */

/**
 * O boletim completo em PDF, logo depois do resumo.
 *
 * São duas coletas independentes — o resumo e o relatório montam os números
 * por caminhos diferentes — então isto leva mais um ou dois minutos. Vale:
 * o texto serve para ler no semáforo, o PDF é onde estão as tabelas.
 */
async function enviarBoletim(dia: string): Promise<void> {
  try {
    const b = await Promise.race([
      gerarBoletim(dia),
      new Promise<never>((_, rejeitar) =>
        setTimeout(() => rejeitar(new Error('boletim passou de 10 minutos')), 10 * 60_000),
      ),
    ]);

    const entregues = await enviarDocumentoAosDonos(
      { nome: b.nome, base64: b.pdf.toString('base64') },
      b.legenda,
    );
    if (entregues === 0) throw new Error('boletim pronto, mas nenhum número recebeu');

    const kb = Math.round(b.pdf.length / 1024);
    boletimTerminou('enviado', { tamanhoEmKb: kb });
    console.log(`[boletim] enviado para ${entregues} número(s) (${kb} KB)`);
  } catch (e) {
    const erro = e instanceof Error ? e.message : String(e);
    boletimTerminou('falhou', { erro });
    console.error('[boletim] falhou:', e);
    await enviarTextoAosDonos(`⚠️ O resumo saiu, mas o PDF de ${dia} falhou.\n\n${erro}`).catch(
      () => undefined,
    );
  }
}

cron.schedule(c.VIGIA_CRON, () => void verificarContas(), { timezone: c.TZ });

// Uma checagem no boot: se a conta já estiver com problema quando o serviço
// subir, você fica sabendo agora, não na virada da hora.
setTimeout(() => void verificarContas(), 30_000);

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
