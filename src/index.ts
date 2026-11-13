import cron from 'node-cron';
import { exigirConfigCompleta } from './config.js';
import { criarApp } from './whatsapp/webhook.js';
import { enviarDocumentoAosDonos, enviarTextoAosDonos } from './whatsapp/evolution.js';
import { ontem } from './digest/build.js';
import { verificarContas } from './vigia.js';
import { boletimTerminou, resumoComecou, resumoTerminou } from './digest/estado.js';
import { gerarBoletim } from './relatorio/index.js';
import { aquecerCacheDeReversas } from './data/retorno.js';
import { avisarPorEmail } from './digest/alerta.js';
import { cobrarNoGrupo } from './cobranca/index.js';

// Valida o conjunto obrigatório antes de qualquer coisa subir.
const c = exigirConfigCompleta();

/* ------------------------------------------------------------------ *
 * Webhook
 * ------------------------------------------------------------------ */

const app = criarApp();

app.listen(c.PORT, () => {
  console.log(`[lf-assistant] ouvindo na porta ${c.PORT}`);
  // Segundo plano: não segura o boot nem o healthcheck.
  aquecerCacheDeReversas()
    .then(() => console.log('[reversas] cache aquecido'))
    .catch((e) => console.error('[reversas] aquecimento falhou:', e));
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
    console.log(`[boletim] montando ${dia}`);

    resumoComecou(dia);

    // Fora do try: no erro, o que já ficou pronto tem que poder sair por outro
    // caminho. Guardar o PDF só dentro do try era o que fazia "o boletim está
    // pronto" e "você não vai recebê-lo" acontecerem juntos.
    let pronto: { nome: string; pdf: Buffer } | null = null;

    try {
      // Teto na montagem inteira. Cada fonte já tem o seu, mas um teto de fora
      // garante que às 8h sai boletim ou sai erro — nunca silêncio.
      const b = await Promise.race([
        gerarBoletim(dia),
        new Promise<never>((_, rejeitar) =>
          setTimeout(() => rejeitar(new Error('montagem passou de 10 minutos')), 10 * 60_000),
        ),
      ]);
      pronto = { nome: b.nome, pdf: b.pdf };

      const entregues = await enviarDocumentoAosDonos(
        { nome: b.nome, base64: b.pdf.toString('base64') },
        `Segue o boletim do dia ${dia.split('-').reverse().join('/')}`,
      );
      if (entregues === 0) throw new Error('boletim pronto, mas nenhum número recebeu');

      const kb = Math.round(b.pdf.length / 1024);
      resumoTerminou('enviado');
      boletimTerminou('enviado', { tamanhoEmKb: kb });
      console.log(`[boletim] enviado para ${entregues} número(s) (${kb} KB)`);

      /*
       * A cobrança vem depois da entrega, e nunca derruba o boletim.
       *
       * Depois porque o boletim é o documento e a cobrança é consequência
       * dele: se a montagem falhou, não há conferência em que confiar para
       * cobrar ninguém.
       */
      const c = await cobrarNoGrupo(dia, b.dados);
      console.log(
        `[cobranca] ${c.enviada ? `enviada: ${c.abertas} em aberto, ${c.resolvidas} resolvida(s)` : `não enviada (${c.motivo})`}`,
      );
    } catch (e) {
      const erro = e instanceof Error ? e.message : String(e);
      const data = dia.split('-').reverse().join('/');
      console.error('[boletim] falhou:', e);

      // Silêncio às 8h é pior que uma mensagem de erro: sem aviso, o Luis
      // pensa que o dia foi fraco quando na verdade o boletim não rodou.
      await enviarTextoAosDonos(`⚠️ Não consegui montar o boletim de ${dia}.\n\n${erro}`).catch(
        () => undefined,
      );

      /*
       * O e-mail é o caminho que não depende do WhatsApp.
       *
       * Quando a sessão cai — 401, duas vezes em um mês — a mensagem acima vai
       * para o mesmo buraco que engoliu o boletim. Aqui o aviso sai de
       * qualquer jeito, e leva o PDF junto se ele chegou a ficar pronto.
       */
      const porEmail = await avisarPorEmail(
        pronto
          ? `Boletim de ${data} — não saiu pelo WhatsApp`
          : `Boletim de ${data} não foi montado`,
        pronto
          ? `O boletim de ${data} ficou pronto, mas não consegui entregar pelo WhatsApp.\n\n` +
              `Motivo: ${erro}\n\nEle vai em anexo. Para religar o WhatsApp, abra o manager da ` +
              `Evolution e reconecte a instância.`
          : `Não consegui montar o boletim de ${data}.\n\nMotivo: ${erro}`,
        pronto ? { nome: pronto.nome, conteudo: pronto.pdf } : undefined,
      );

      resumoTerminou('falhou', porEmail ? `${erro} (enviado por e-mail)` : erro);
      boletimTerminou('falhou', { erro, porEmail });
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
