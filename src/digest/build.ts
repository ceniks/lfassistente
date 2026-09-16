import { config } from '../config.js';
import { mediaPorHora,
  novosVsRecorrentes,
  periodoDeVendas,
  trafegoDoDia,
  type ResumoVendas,
} from '../data/shopify.js';
import { coberturaDosCampeoes } from '../data/cobertura.js';
import { patrimonioDoDia } from '../data/patrimonio.js';
import { margemDoDia } from '../data/margem.js';
import { conferirEstorno } from '../data/conciliacao.js';
import { midiaDoDia } from '../data/meta.js';
import { midiaGoogleDoDia, temGoogleAds } from '../data/google.js';
import { metaDoDia } from '../data/metas.js';
import { producaoAtual } from '../data/producao.js';
import { atendimentoAtual } from '../data/atendimento.js';
import { reversasDoDia, temTroque } from '../data/troque.js';
import { montarResumo, type DadosResumo } from './format.js';
import { redigir } from '../agent/redacao.js';
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
async function media7d(dia: string, vendas: Map<string, ResumoVendas>) {
  const dias = diasAntes(dia, 7);

  const resumos = dias.map((d) => vendas.get(d)).filter((r): r is ResumoVendas => Boolean(r));

  // O ShopifyQL custa 3 pontos por consulta mas leva segundos para responder.
  // Em série, os 7 dias dominavam o tempo do resumo inteiro; em paralelo, o
  // custo somado nem arranha o limite e o tempo vira o da consulta mais lenta.
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
  // Produção e atendimento vêm dos MCPs próprios. Se um deles estiver fora do
  // ar, o resumo sai sem aquele bloco em vez de não sair — um dia sem a linha
  // de produção é muito melhor que silêncio às 8h.
  const opcional = async <T>(nome: string, f: () => Promise<T | null>): Promise<T | null> => {
    try {
      return await f();
    } catch (e) {
      console.error(`[digest] ${nome} falhou, seguindo sem o bloco:`, e);
      return null;
    }
  };

  // Uma busca só cobre o dia e os 14 anteriores — a mesma janela do PDF, para
  // que a cobertura de estoque não dê número diferente nos dois lugares. A
  // média de 7 dias do resumo continua saindo dos 7 primeiros.
  const todosOsDias = [dia, ...diasAntes(dia, 14)];
  const periodo = await periodoDeVendas(todosOsDias);
  const vendasPorData = periodo.porDia;
  const vendas = vendasPorData.get(dia)!;

  const media7dPorHora = mediaPorHora(diasAntes(dia, 7), vendasPorData);


  const [
    trafego,
    midia,
    google,
    meta,
    medias,
    producao,
    atendimento,
    reversas,
    estornos,
    clientes,
    cobertura,
    patrimonio,
  ] = await Promise.all([
    trafegoDoDia(dia),
    opcional('mídia', () => midiaDoDia(dia)),
    // Sem credencial do Google o bloco sai como "não conectado" em vez de
    // derrubar a mídia inteira — o Meta é que paga a conta, o Google é
    // complemento.
    opcional('google', () => (temGoogleAds() ? midiaGoogleDoDia(dia) : Promise.resolve(null))),
    opcional('metas', () => metaDoDia(dia)),
    media7d(dia, vendasPorData),
    opcional('produção', () => producaoAtual()),
    opcional('atendimento', () => atendimentoAtual(dia)),
    opcional('trocas', () => (temTroque() ? reversasDoDia(dia) : Promise.resolve(null))),
    // Confronta reembolso a reembolso com o Troquecommerce. Cabe no resumo
    // porque a busca larga foi trocada por consulta dirigida: ~19s, não ~90s.
    opcional('estornos', () => conferirEstorno(dia, dia)),
    // Exige o escopo read_customers no app da Shopify. Sem ele devolve null e
    // a linha some, sem derrubar o resto.
    opcional('clientes', () => novosVsRecorrentes(dia)),
    opcional('cobertura', () =>
      coberturaDosCampeoes(vendas, periodo),
    ),
    opcional('patrimônio', () => patrimonioDoDia()),
  ]);

  const dados: DadosResumo = {
    dia,
    vendas,
    vendasMedia7d: medias.vendas,
    trafego,
    trafegoMedia7d: medias.trafego,
    meta,
    midia,
    google,
    fluxos: [],
    producao,
    atendimento,
    reversas,
    estornos,
    clientes,
    cobertura,
    patrimonio,
    media7dPorHora,
    margem: margemDoDia(vendas, (midia?.valorPago ?? 0) + (google?.valorPago ?? 0)),
  };

  // A leitura é a única parte que precisa do modelo. Os números já estão prontos.
  //
  // Entregamos a ele a MENSAGEM montada, não o JSON cru. Com o JSON, o modelo
  // refazia as contas por conta própria e chegava a bases diferentes: num teste
  // real ele calculou o desconto sobre a receita (52%) enquanto o resumo mostrava
  // sobre o bruto (34%), e concluiu que o desconto tinha sido mais pesado que a
  // média quando fora menor. A mensagem se contradizia. Lendo o mesmo texto que o
  // Luis lê, não há segunda base possível.
  const semLeitura = montarResumo(dados);

  try {
    dados.leitura = await redigir(`${PROMPT_LEITURA}\n\n${semLeitura}`, 800);
  } catch (e) {
    console.error('[digest] leitura falhou, seguindo sem ela:', e);
    return semLeitura;
  }

  return montarResumo(dados);
}

export function horaDoResumo(): string {
  return config().DIGEST_CRON;
}
