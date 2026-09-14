import { coletar } from './dados.js';
import { gerarPdf, nomeDoArquivo } from './pdf.js';
import { perguntarSemContexto } from '../agent/runner.js';
import { PROMPT_RELATORIO } from '../agent/prompt.js';
import { montarResumo } from '../digest/format.js';
import { ontem } from '../digest/build.js';

/**
 * O boletim completo, sob demanda.
 *
 * Não entra no cron das 8h de propósito: leva perto de dois minutos e faz
 * dezenas de chamadas a mais que o resumo diário — campanha por campanha do
 * Meta, quinze dias de vendas, o funil de reversas. Pagar isso todo dia sem
 * ninguém abrir não se justifica.
 */

export interface Boletim {
  dia: string;
  pdf: Buffer;
  nome: string;
  legenda: string;
}

export async function gerarBoletim(dia = ontem()): Promise<Boletim> {
  const dados = await coletar(dia);

  // A leitura do PDF é mais longa que a do WhatsApp — aqui há espaço para
  // desenvolver. Entregamos ao modelo o resumo já montado, não o JSON: com o
  // JSON ele refaz as contas em bases diferentes e contradiz o próprio
  // relatório algumas linhas acima.
  try {
    const contexto = montarResumo({
      dia: dados.dia,
      vendas: dados.vendas,
      vendasMedia7d: dados.media7d,
      trafego: dados.trafego,
      trafegoMedia7d: dados.trafego7d,
      meta: dados.meta,
      midia: dados.midia,
      google: dados.google,
      fluxos: [],
      producao: dados.producao,
      atendimento: dados.atendimento,
      reversas: dados.reversas,
    });
    dados.leitura = await perguntarSemContexto(`${PROMPT_RELATORIO}\n\n${contexto}`);
  } catch (e) {
    console.error('[relatorio] leitura falhou, seguindo sem ela:', e);
  }

  const pdf = await gerarPdf(dados);

  return {
    dia,
    pdf,
    nome: nomeDoArquivo(dia),
    legenda: `Boletim completo de ${dia.split('-').reverse().join('/')}`,
  };
}

/* ------------------------------------------------------------------ *
 * Reconhecimento do pedido
 * ------------------------------------------------------------------ */

const PEDIDO =
  /\b(boletim|relat[óo]rio)\s+(completo|detalhado|em\s+pdf)\b|\bpdf\s+(completo|do\s+dia|de\s+ontem)\b|\bme\s+manda\s+o\s+pdf\b/i;

const MESES: Record<string, string> = {
  jan: '01', fev: '02', mar: '03', abr: '04', mai: '05', jun: '06',
  jul: '07', ago: '08', set: '09', out: '10', nov: '11', dez: '12',
};

/**
 * Decide se a mensagem é um pedido de boletim, sem gastar token.
 *
 * Poderia ser uma ferramenta do agente, mas um pedido que chega dez vezes por
 * semana não precisa passar pelo modelo para ser entendido — e cada passagem
 * custa uns vinte mil tokens de entrada. O reconhecimento é determinístico, e o
 * que não casar aqui cai na conversa normal como antes.
 */
export function pedidoDeBoletim(texto: string): { dia: string } | null {
  if (!PEDIDO.test(texto)) return null;
  return { dia: diaPedido(texto) };
}

function diaPedido(texto: string): string {
  const t = texto.toLowerCase();

  const iso = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  // 13/09 ou 13/09/2026
  const br = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b/);
  if (br) {
    const ano = br[3] ?? String(new Date().getFullYear());
    return `${ano}-${br[2].padStart(2, '0')}-${br[1].padStart(2, '0')}`;
  }

  // 13 de setembro / 13 de set
  const extenso = t.match(/\b(\d{1,2})\s+de\s+([a-zç]{3})/);
  if (extenso && MESES[extenso[2]]) {
    return `${new Date().getFullYear()}-${MESES[extenso[2]]}-${extenso[1].padStart(2, '0')}`;
  }

  if (/\bhoje\b/.test(t)) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }

  return ontem();
}
