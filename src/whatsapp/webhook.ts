import express, { type Request, type Response } from 'express';
import { config, ownerJid, exigir } from '../config.js';
import { enviarTexto, enviarDocumento } from './evolution.js';
import { perguntar } from '../agent/runner.js';
import { gerarBoletim, pedidoDeBoletim } from '../relatorio/index.js';

/**
 * Webhook da Evolution.
 *
 * Ele precisa ser público para a Evolution alcançar, então três camadas de
 * defesa, em ordem de custo: allowlist de JID (uma comparação de string),
 * verificação da apikey, e TLS por cima — no Railway o TLS já vem pronto.
 *
 * A allowlist é a que mais importa. Se a mensagem não vier do número do Luis, o
 * agente nem é acordado, e ninguém consegue gastar token dele mandando mensagem
 * para o número do assistente.
 */

interface EventoEvolution {
  event?: string;
  instance?: string;
  data?: {
    key?: { remoteJid?: string; fromMe?: boolean; id?: string };
    message?: {
      conversation?: string;
      extendedTextMessage?: { text?: string };
    };
    pushName?: string;
  };
}

/** Ids já processados, para não responder duas vezes se a Evolution reenviar. */
const vistos = new Set<string>();
const MAX_VISTOS = 500;

export function criarApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (_req, res) => res.json({ ok: true }));

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

  // A allowlist: só o dono conversa com o assistente.
  if (key.remoteJid !== ownerJid()) {
    console.warn(`[webhook] mensagem de ${key.remoteJid} ignorada (fora da allowlist)`);
    return;
  }

  if (key.id) {
    if (vistos.has(key.id)) return;
    vistos.add(key.id);
    if (vistos.size > MAX_VISTOS) {
      // Set mantém ordem de inserção: descarta os mais antigos.
      for (const id of [...vistos].slice(0, 100)) vistos.delete(id);
    }
  }

  const texto =
    evento.data?.message?.conversation ??
    evento.data?.message?.extendedTextMessage?.text ??
    '';

  if (!texto.trim()) return;

  console.log(`[webhook] pergunta: ${texto.slice(0, 120)}`);

  // Atalho antes do agente: "manda o boletim completo" chega toda semana e não
  // precisa de modelo para ser entendido. Reconhecer por regex custa zero token
  // e não erra; o que não casar aqui segue para a conversa normal.
  const pedido = pedidoDeBoletim(texto);
  if (pedido) {
    await enviarBoletim(pedido.dia);
    return;
  }

  const resposta = await perguntar(texto);

  if (resposta.erro && !resposta.texto) {
    await enviarTexto(
      exigir('OWNER_PHONE'),
      `Não consegui responder agora: ${resposta.erro}`,
    );
    return;
  }

  await enviarTexto(exigir('OWNER_PHONE'), resposta.texto);

  if (resposta.ferramentasUsadas.length) {
    console.log(`[webhook] usou: ${resposta.ferramentasUsadas.join(', ')}`);
  }
}

/**
 * Gera e manda o PDF.
 *
 * O aviso antes de começar não é gentileza: são perto de dois minutos de
 * coleta, e sem ele o assistente fica mudo tempo demais para parecer vivo.
 */
async function enviarBoletim(dia: string): Promise<void> {
  const numero = exigir('OWNER_PHONE');
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
