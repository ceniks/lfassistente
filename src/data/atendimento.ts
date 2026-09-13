import { config } from '../config.js';
import { chamarJson } from './mcp-client.js';

export interface Atendimento {
  aguardando: number;
  porAtendente: Array<{ nome: string; total: number }>;
  semAtendente: number;
  porCanal: Array<{ canal: string; total: number }>;
  carrinhosGerados: number;
  carrinhosComErro: number;
  carrinhosEnviados: number;
  carrinhosRespondidos: number;
  npsSeteDias: number | null;
  npsRespostas: number;
}

function servidor() {
  const c = config();
  if (!c.ATENDEPRO_MCP_URL) return null;
  return { nome: 'atendepro', url: c.ATENDEPRO_MCP_URL, token: c.ATENDEPRO_TOKEN };
}

interface Agente {
  id: string;
  display_name: string;
  active_conversations_count: number;
  distribution_percentage: number;
}

interface Conversa {
  status: string;
  channel: string;
  assigned_agent_id: string | null;
}

interface Carrinho {
  status: 'pending' | 'sent' | 'replied' | 'dismissed' | 'error';
}

const CANAIS: Record<string, string> = {
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  email: 'e-mail',
};

/**
 * Panorama de atendimento para o resumo.
 *
 * Duas coisas que a contagem bruta esconde e que por isso são separadas aqui:
 *
 *  - Conversas **sem atendente atribuído**. Em 13/09 eram 18 das 43 — o
 *    transbordo de uma distribuição apontada 100% para uma pessoa só. Somadas ao
 *    total, viram "43 aguardando" e a informação se perde.
 *  - Carrinhos com status `error`. São disparos que não saíram; no dia 12/09
 *    foram 21% deles. Isso não aparece em relatório de conversão nenhum e é
 *    receita parada num canal já construído.
 */
export async function atendimentoAtual(dia: string): Promise<Atendimento | null> {
  const srv = servidor();
  if (!srv) return null;

  const [agentes, conversas, carrinhos, nps] = await Promise.all([
    chamarJson<{ profiles: Agente[] }>(srv, 'list_agents', { limit: 50 }),
    chamarJson<{ count: number; conversations: Conversa[] }>(srv, 'list_conversations', {
      status: 'waiting',
      limit: 200,
    }),
    chamarJson<{ count: number; carts: Carrinho[] }>(srv, 'list_abandoned_carts', {
      start_date: dia,
      end_date: dia,
      limit: 200,
    }),
    npsDosUltimosDias(srv, dia, 7),
  ]);

  const nomePorId = new Map(agentes.profiles.map((a) => [a.id, a.display_name.trim()]));

  const porAtendente = new Map<string, number>();
  const porCanal = new Map<string, number>();
  let semAtendente = 0;

  for (const c of conversas.conversations) {
    if (c.assigned_agent_id) {
      const nome = nomePorId.get(c.assigned_agent_id) ?? 'não identificado';
      porAtendente.set(nome, (porAtendente.get(nome) ?? 0) + 1);
    } else {
      semAtendente++;
    }

    const canal = CANAIS[c.channel] ?? c.channel;
    porCanal.set(canal, (porCanal.get(canal) ?? 0) + 1);
  }

  const contar = (status: Carrinho['status']) =>
    carrinhos.carts.filter((c) => c.status === status).length;

  return {
    aguardando: conversas.count,
    porAtendente: [...porAtendente.entries()]
      .map(([nome, total]) => ({ nome, total }))
      .sort((a, b) => b.total - a.total),
    semAtendente,
    porCanal: [...porCanal.entries()]
      .map(([canal, total]) => ({ canal, total }))
      .sort((a, b) => b.total - a.total),
    carrinhosGerados: carrinhos.count,
    carrinhosComErro: contar('error'),
    carrinhosEnviados: contar('sent'),
    carrinhosRespondidos: contar('replied'),
    npsSeteDias: nps.nps,
    npsRespostas: nps.responses,
  };
}

async function npsDosUltimosDias(
  srv: { nome: string; url: string; token?: string },
  ate: string,
  dias: number,
): Promise<{ nps: number | null; responses: number }> {
  const fim = new Date(`${ate}T12:00:00-03:00`);
  const inicio = new Date(fim);
  inicio.setDate(inicio.getDate() - (dias - 1));

  try {
    const r = await chamarJson<{ nps: number; responses: number }>(srv, 'nps_summary', {
      start_date: inicio.toISOString().slice(0, 10),
      end_date: ate,
    });
    return { nps: r.nps, responses: r.responses };
  } catch {
    // NPS é acessório: se falhar, o resumo sai sem ele.
    return { nps: null, responses: 0 };
  }
}

/**
 * Campanhas de RFM com métrica de envio.
 *
 * Vale monitorar por um motivo específico: em 13/09/2026, as 12 campanhas
 * existentes somavam 9.151 mensagens enviadas e **zero** compra atribuída, e
 * duas delas tinham 100% de falha de envio. Ou a atribuição não está ligada, ou
 * o RFM não gerou venda — e as duas hipóteses pedem ações opostas.
 */
export async function campanhasRfm(): Promise<
  Array<{ nome: string; enviadas: number; falhas: number; respostas: number; compras: number }>
> {
  const srv = servidor();
  if (!srv) return [];

  const r = await chamarJson<{
    campaigns: Array<{
      name: string;
      total_sent: number;
      total_failed: number;
      total_replied: number;
      total_purchased: number;
    }>;
  }>(srv, 'list_rfm_campaigns', { limit: 20 });

  return r.campaigns.map((c) => ({
    nome: c.name.trim(),
    enviadas: c.total_sent,
    falhas: c.total_failed,
    respostas: c.total_replied,
    compras: c.total_purchased,
  }));
}
