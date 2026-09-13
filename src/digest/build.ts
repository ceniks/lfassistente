import { config } from '../config.js';
import { vendasDoDia, trafegoDoDia, agregar, pedidosPagosEm } from '../data/shopify.js';
import { midiaDoDia } from '../data/meta.js';
import { metaDoDia } from '../data/metas.js';
import { montarResumo, type DadosResumo } from './format.js';
import { perguntarSemContexto } from '../agent/runner.js';
import { PROMPT_LEITURA } from '../agent/prompt.js';

/** YYYY-MM-DD de ontem no fuso de São Paulo. */
export function ontem(): string {
  const agora = new Date();
  agora.setDate(agora.getDate() - 1);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(agora);
}

function diasAntes(dia: string, n: number): string[] {
  const base = new Date(`${dia}T12:00:00-03:00`);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(base);
    d.setDate(d.getDate() - (i + 1));
    return d.toISOString().slice(0, 10);
  });
}

/**
 * Média dos 7 dias anteriores.
 *
 * Precisa sair do mesmo cálculo do dia — mesma definição de pedido pago, mesmas
 * exclusões. Comparar o ticket de hoje (calculado com a regra nova) contra uma
 * média tirada do painel do Shopify (que conta tudo) daria uma variação
 * inventada: o painel inclui troca e influencer, então a base viria mais baixa e
 * qualquer dia pareceria melhor do que foi.
 */
async function media7d(dia: string) {
  const dias = diasAntes(dia, 7);

  const resumos = await Promise.all(
    dias.map(async (d) => agregar(await pedidosPagosEm(d), d)),
  );
  const trafegos = await Promise.all(dias.map((d) => trafegoDoDia(d)));

  const somar = <T>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);
  const n = resumos.length || 1;

  const receitaTotal = somar(resumos, (r) => r.receita);
  const descontoTotal = somar(resumos, (r) => r.desconto.total);

  return {
    vendas: {
      receita: receitaTotal / n,
      pedidos: somar(resumos, (r) => r.pedidos) / n,
      ticketMedio: somar(resumos, (r) => r.ticketMedio) / n,
      descontoPct:
        receitaTotal + descontoTotal > 0 ? descontoTotal / (receitaTotal + descontoTotal) : 0,
    },
    trafego: {
      sessoes: somar(trafegos, (t) => t.sessoes) / n,
      taxaAdicao: somar(trafegos, (t) => t.taxaAdicao) / n,
      conversao: somar(trafegos, (t) => t.conversao) / n,
    },
  };
}

/**
 * Junta todas as fontes e devolve a mensagem pronta.
 *
 * Produção e atendimento entram pelos MCPs próprios, que o agente consulta — não
 * são chamados aqui para não duplicar a integração.
 */
export async function construirResumo(dia = ontem()): Promise<string> {
  const [vendas, trafego, midia, meta, medias] = await Promise.all([
    vendasDoDia(dia),
    trafegoDoDia(dia),
    midiaDoDia(dia),
    metaDoDia(dia),
    media7d(dia),
  ]);

  const dados: DadosResumo = {
    dia,
    vendas,
    vendasMedia7d: medias.vendas,
    trafego,
    trafegoMedia7d: medias.trafego,
    meta,
    midia,
    google: null,
    fluxos: [],
    producao: null,
    atendimento: null,
  };

  // A leitura é a única parte que precisa do modelo. Os números já estão prontos.
  try {
    dados.leitura = await perguntarSemContexto(
      `${PROMPT_LEITURA}\n\n${JSON.stringify(dados, null, 2)}`,
    );
  } catch (e) {
    console.error('[digest] leitura falhou, seguindo sem ela:', e);
  }

  return montarResumo(dados);
}

export function horaDoResumo(): string {
  return config().DIGEST_CRON;
}
