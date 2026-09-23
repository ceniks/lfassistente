import express, { type Request, type Response } from 'express';
import { config, ehDono } from '../config.js';
import { enviarTexto, enviarDocumento, estadoDaInstancia, baixarMidia } from './evolution.js';
import { rotasDeRh } from '../rh/web.js';
import {
  descartarLote,
  enviarLote,
  loteDe,
  pendenciasDeConfiguracao,
  prepararLote,
  resumoDoLote,
} from '../rh/fluxo.js';
import { perguntar } from '../agent/runner.js';
import { gerarBoletim, pedidoDeBoletim } from '../relatorio/index.js';
import { ultimaTentativa } from '../digest/estado.js';

/**
 * Webhook da Evolution.
 *
 * Ele precisa ser público para a Evolution alcançar, então três camadas de
 * defesa, em ordem de custo: allowlist de JID (uma comparação de string),
 * verificação da apikey, e TLS por cima — no Railway o TLS já vem pronto.
 *
 * A allowlist é a que mais importa. Se a mensagem não vier de um dos números
 * autorizados, o agente nem é acordado, e ninguém consegue gastar token
 * mandando mensagem para o número do assistente.
 *
 * A resposta volta para quem perguntou, não para a lista inteira: duas pessoas
 * conversando com o assistente não precisam ler as perguntas uma da outra. O
 * que é broadcast — resumo das 8h, alerta do vigia — vai para todos.
 */

interface EventoEvolution {
  event?: string;
  instance?: string;
  data?: {
    key?: { remoteJid?: string; fromMe?: boolean; id?: string };
    message?: {
      conversation?: string;
      extendedTextMessage?: { text?: string };
      documentMessage?: { fileName?: string; mimetype?: string };
      documentWithCaptionMessage?: {
        message?: { documentMessage?: { fileName?: string; mimetype?: string } };
      };
    };
    pushName?: string;
  };
}

/** Ids já processados, para não responder duas vezes se a Evolution reenviar. */
const vistos = new Set<string>();
const MAX_VISTOS = 500;

export function criarApp() {
  const app = express();
  // 25 MB: o PDF de holerites sobe em base64 pelo corpo da requisição, e um
  // mês inteiro de folha passa fácil de 2 MB depois de codificado.
  app.use(express.json({ limit: '25mb' }));

  // A página de RH: sobe o PDF, confere, envia. Protegida por senha própria.
  app.use('/rh', rotasDeRh());

  // Estado de quem depende de coisa externa: a conexão do WhatsApp e a última
  // tentativa de resumo. Manhã sem boletim se explica aqui, sem abrir painel.
  app.get('/diag', async (_req, res) => {
    // Só sim/não: o que está configurado neste ambiente. Existe porque um bloco
    // sumido do boletim é indistinguível de fonte com credencial faltando, e
    // ler variável do painel do Railway é lento e fácil de errar.
    const c = config();
    const integracoes = {
      pagbank: Boolean(c.PAGBANK_TOKEN && c.PAGBANK_EMAIL),
      pagbankTokenAntigo: Boolean(c.PAGBANK_TOKEN_ANTIGO),
      mercadopago: Boolean(c.MERCADOPAGO_TOKEN),
      pagarme: Boolean(c.PAGARME_TOKEN),
      googleAds: Boolean(c.GOOGLE_ADS_REFRESH_TOKEN),
      gmail: Boolean(c.GMAIL_REFRESH_TOKEN),
      troque: Boolean(c.TROQUE_TOKEN),
      paginaDeRh: Boolean(c.RH_SENHA),
      openFinance: Boolean(c.MCP_AI_KEY),
    };
    res.json({
      integracoes,
      commit: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? 'desconhecido',
      agora: new Date().toISOString(),
      fuso: config().TZ,
      cronDoResumo: config().DIGEST_CRON,
      whatsapp: await estadoDaInstancia(),
      ultimoResumo: ultimaTentativa(),
    });
  });

  // Devolve o commit que está no ar. Sem isso, "o deploy já subiu?" só se
  // responde pelo painel do Railway — e a resposta some quando a aba fecha.
  app.get('/health', (_req, res) =>
    res.json({
      ok: true,
      commit: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? 'desconhecido',
      subidoEm: process.env.RAILWAY_DEPLOYMENT_CREATED_AT ?? null,
    }),
  );

  app.post('/wa/webhook', async (req: Request, res: Response) => {
    // Responde imediatamente: a Evolution não deve esperar o agente pensar.
    res.status(200).json({ ok: true });

    try {
      await tratar(req);
    } catch (e) {
      console.error('[webhook] falhou:', e);
    }
  });

  return app;
}

async function tratar(req: Request): Promise<void> {
  const apikey = req.header('apikey') ?? req.header('x-api-key');
  if (apikey !== config().EVOLUTION_API_KEY) {
    console.warn('[webhook] apikey inválida, ignorando');
    return;
  }

  const evento = req.body as EventoEvolution;
  if (evento.event !== 'messages.upsert') return;

  const key = evento.data?.key;
  if (!key?.remoteJid || key.fromMe) return;

  // A allowlist: só quem está no OWNER_PHONE conversa com o assistente.
  if (!ehDono(key.remoteJid)) {
    console.warn(`[webhook] mensagem de ${key.remoteJid} ignorada (fora da allowlist)`);
    return;
  }

  // Responder para o JID recebido, e não para o número configurado, também
  // resolve o caso do nono dígito: devolvemos exatamente para onde a Evolution
  // disse que a mensagem veio.
  const quem = (key.remoteJid.split('@')[0] ?? '').split(':')[0] ?? '';

  if (key.id) {
    if (vistos.has(key.id)) return;
    vistos.add(key.id);
    if (vistos.size > MAX_VISTOS) {
      // Set mantém ordem de inserção: descarta os mais antigos.
      for (const id of [...vistos].slice(0, 100)) vistos.delete(id);
    }
  }

  const documento =
    evento.data?.message?.documentMessage ??
    evento.data?.message?.documentWithCaptionMessage?.message?.documentMessage;

  if (documento) {
    await tratarDocumento(quem, evento, documento);
    return;
  }

  const texto =
    evento.data?.message?.conversation ??
    evento.data?.message?.extendedTextMessage?.text ??
    '';

  if (!texto.trim()) return;

  // Confirmação de holerite antes de qualquer outra coisa: quem respondeu
  // "confirmo" está respondendo a uma pergunta, não abrindo assunto novo.
  if (loteDe(quem) && (await tratarConfirmacao(quem, texto))) return;

  console.log(`[webhook] pergunta: ${texto.slice(0, 120)}`);

  // Atalho antes do agente: "manda o boletim completo" chega toda semana e não
  // precisa de modelo para ser entendido. Reconhecer por regex custa zero token
  // e não erra; o que não casar aqui segue para a conversa normal.
  const pedido = pedidoDeBoletim(texto);
  if (pedido) {
    await enviarBoletim(quem, pedido.dia);
    return;
  }

  const resposta = await perguntar(texto);

  if (resposta.erro && !resposta.texto) {
    await enviarTexto(quem, `Não consegui responder agora: ${resposta.erro}`);
    return;
  }

  await enviarTexto(quem, resposta.texto);

  if (resposta.ferramentasUsadas.length) {
    console.log(`[webhook] usou: ${resposta.ferramentasUsadas.join(', ')}`);
  }
}

/**
 * PDF recebido: divide por funcionária e devolve a lista para conferência.
 *
 * Nada é enviado aqui. O lote fica esperando o "confirmo" — ver `src/rh/fluxo.ts`.
 */
async function tratarDocumento(
  quem: string,
  evento: EventoEvolution,
  documento: { fileName?: string; mimetype?: string },
): Promise<void> {
  const nome = documento.fileName ?? 'arquivo.pdf';

  if (!/pdf/i.test(documento.mimetype ?? '') && !/\.pdf$/i.test(nome)) {
    await enviarTexto(quem, 'Recebi o arquivo, mas só sei tratar PDF de holerite por enquanto.');
    return;
  }

  const falta = await pendenciasDeConfiguracao();
  if (falta.length) {
    await enviarTexto(quem, `Antes de mexer em holerite falta configurar ${falta.join(' e ')}.`);
    return;
  }

  await enviarTexto(quem, `📄 Recebi *${nome}*. Separando por funcionária…`);

  try {
    const lote = await prepararLote(quem, await baixarMidia(evento.data), nome);
    await enviarTexto(quem, resumoDoLote(lote));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[holerite] falhou:', e);
    await enviarTexto(quem, `Não consegui separar o PDF: ${msg.slice(0, 300)}`);
  }
}

/** Responde "confirmo" e "cancelar". Devolve false se o texto era outra coisa. */
async function tratarConfirmacao(quem: string, texto: string): Promise<boolean> {
  const t = texto
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();

  if (/^(cancela|cancelar|deixa|esquece)/.test(t)) {
    descartarLote(quem);
    await enviarTexto(quem, 'Descartei o lote. Nada foi enviado.');
    return true;
  }

  if (!/^(confirmo|confirmar|pode enviar|envia|enviar|pode mandar)\b/.test(t)) return false;

  await enviarTexto(quem, 'Enviando…');
  try {
    const r = await enviarLote(quem);
    const linhas = [`✅ Enviados: ${r.enviados.length}`];
    if (r.falhas.length) {
      linhas.push(`⚠️ Falharam: ${r.falhas.length}`);
      for (const f of r.falhas) linhas.push(`• ${f.nome} (${f.email}): ${f.erro.slice(0, 120)}`);
    }
    await enviarTexto(quem, linhas.join('\n'));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await enviarTexto(quem, `Não consegui enviar: ${msg.slice(0, 300)}`);
  }
  return true;
}

/**
 * Gera e manda o PDF.
 *
 * O aviso antes de começar não é gentileza: são perto de dois minutos de
 * coleta, e sem ele o assistente fica mudo tempo demais para parecer vivo.
 */
async function enviarBoletim(numero: string, dia: string): Promise<void> {
  const dataBr = dia.split('-').reverse().join('/');

  await enviarTexto(numero, `📄 Montando o boletim completo de ${dataBr}. Leva cerca de um minuto.`);

  try {
    const b = await gerarBoletim(dia);
    await enviarDocumento(numero, { nome: b.nome, base64: b.pdf.toString('base64') }, b.legenda);
    console.log(`[webhook] boletim de ${dia} enviado (${Math.round(b.pdf.length / 1024)} KB)`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[webhook] boletim falhou:', e);
    await enviarTexto(numero, `Não consegui montar o boletim de ${dataBr}: ${msg.slice(0, 300)}`);
  }
}
