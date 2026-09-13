import { config, exigir } from '../config.js';

/**
 * Cliente da Evolution API.
 *
 * Só o que o assistente precisa: mandar texto e mandar documento. O resto da
 * API existe mas não nos interessa — quanto menos superfície, menos coisa para
 * quebrar quando a Evolution mudar de versão.
 */

async function post<T>(rota: string, corpo: unknown): Promise<T> {
  const res = await fetch(`${exigir('EVOLUTION_URL')}${rota}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: exigir('EVOLUTION_API_KEY'),
    },
    body: JSON.stringify(corpo),
  });

  if (!res.ok) {
    throw new Error(`Evolution ${res.status} em ${rota}: ${await res.text()}`);
  }

  return (await res.json()) as T;
}

/** WhatsApp corta mensagem muito longa. O resumo cabe, mas resposta de conversa nem sempre. */
const LIMITE = 4000;

export async function enviarTexto(numero: string, texto: string): Promise<void> {
  const instancia = exigir('EVOLUTION_INSTANCE');

  for (const parte of fatiar(texto, LIMITE)) {
    await post(`/message/sendText/${instancia}`, {
      number: numero,
      text: parte,
      linkPreview: false,
    });
  }
}

export async function enviarDocumento(
  numero: string,
  arquivo: { nome: string; base64: string; mimetype?: string },
  legenda?: string,
): Promise<void> {
  await post(`/message/sendMedia/${exigir('EVOLUTION_INSTANCE')}`, {
    number: numero,
    mediatype: 'document',
    mimetype: arquivo.mimetype ?? 'application/pdf',
    media: arquivo.base64,
    fileName: arquivo.nome,
    caption: legenda,
  });
}

/**
 * Quebra em pedaços respeitando parágrafo, para não cortar no meio de uma linha
 * de número. Uma mensagem partida no meio de "R$ 16.7" é pior que duas
 * mensagens.
 */
function fatiar(texto: string, limite: number): string[] {
  if (texto.length <= limite) return [texto];

  const partes: string[] = [];
  let atual = '';

  for (const paragrafo of texto.split('\n\n')) {
    if (atual.length + paragrafo.length + 2 > limite) {
      if (atual) partes.push(atual.trim());
      atual = paragrafo;
    } else {
      atual = atual ? `${atual}\n\n${paragrafo}` : paragrafo;
    }
  }

  if (atual) partes.push(atual.trim());
  return partes;
}
