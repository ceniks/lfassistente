import { periodoDeVendas, trafegoDoDia, type ResumoVendas, type Trafego } from '../data/shopify.js';
import { midiaDoDia, desempenhoPorNivel, type MidiaMeta, type LinhaMidia } from '../data/meta.js';
import { midiaGoogleDoDia, temGoogleAds, type MidiaGoogle } from '../data/google.js';
import { metaDoDia } from '../data/metas.js';
import { producaoAtual, type Producao } from '../data/producao.js';
import { atendimentoAtual, type Atendimento } from '../data/atendimento.js';
import { reversasDoDia, temTroque, type Reversas } from '../data/troque.js';
import { conferirEstorno, type Conciliacao } from '../data/conciliacao.js';
import { novosVsRecorrentes, type NovosVsRecorrentes } from '../data/shopify.js';
import { coberturaDosCampeoes, type Cobertura } from '../data/cobertura.js';

/**
 * O material do boletim completo.
 *
 * A diferença para o resumo das 8h não é "mais números": é profundidade onde o
 * WhatsApp não comporta. A mensagem diária responde "como foi ontem?" em quinze
 * segundos de leitura. O PDF responde "por que foi assim?" — série de duas
 * semanas, campanha por campanha, funil de tráfego com as taxas entre etapas, e
 * o passivo de trocas por idade.
 *
 * Por isso ele não roda às 8h: custa mais tempo e mais chamadas de API do que
 * faz sentido gastar todo dia sem ninguém pedir.
 */

export const DIAS_DE_SERIE = 14;

export interface PontoSerie {
  dia: string;
  receita: number;
  pedidos: number;
  ticket: number;
}

export interface DadosRelatorio {
  dia: string;
  geradoEm: Date;
  vendas: ResumoVendas;
  /** Duas semanas terminando no dia, para a tendência. */
  serie: PontoSerie[];
  media7d: { receita: number; pedidos: number; ticketMedio: number; descontoPct: number };
  /** O mesmo dia da semana anterior — compara sábado com sábado. */
  semanaPassada: PontoSerie | null;
  trafego: Trafego;
  trafego7d: { sessoes: number; taxaAdicao: number; conversao: number };
  meta: number | null;
  midia: MidiaMeta | null;
  campanhas: LinhaMidia[];
  google: MidiaGoogle | null;
  producao: Producao | null;
  atendimento: Atendimento | null;
  reversas: Reversas | null;
  estornos: Conciliacao | null;
  clientes: NovosVsRecorrentes | null;
  cobertura: Cobertura[] | null;
  leitura?: string;
}

function diasAntes(dia: string, n: number): string[] {
  const base = new Date(`${dia}T12:00:00-03:00`);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(base);
    d.setDate(d.getDate() - (i + 1));
    return d.toISOString().slice(0, 10);
  });
}

/** Tolera falha de uma fonte: um bloco a menos é melhor que relatório nenhum. */
async function opcional<T>(nome: string, f: () => Promise<T | null>): Promise<T | null> {
  try {
    return await f();
  } catch (e) {
    console.error(`[relatorio] ${nome} falhou, seguindo sem o bloco:`, e);
    return null;
  }
}

export async function coletar(dia: string): Promise<DadosRelatorio> {
  // Uma busca só cobre os 15 dias. Ver o comentário em `vendasPorDia`: pedir dia
  // a dia multiplicaria as chamadas e estouraria o balde da Shopify.
  const janela = [dia, ...diasAntes(dia, DIAS_DE_SERIE)];
  const periodo = await periodoDeVendas(janela);
  const vendasPorData = periodo.porDia;
  const vendas = vendasPorData.get(dia)!;

  const serie: PontoSerie[] = janela
    .slice()
    .reverse()
    .map((d) => {
      const v = vendasPorData.get(d);
      return {
        dia: d,
        receita: v?.receita ?? 0,
        pedidos: v?.pedidos ?? 0,
        ticket: v?.ticketMedio ?? 0,
      };
    });

  const seteDias = diasAntes(dia, 7);
  const resumos = seteDias
    .map((d) => vendasPorData.get(d))
    .filter((r): r is ResumoVendas => Boolean(r));

  const somar = <T>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);
  const n = resumos.length || 1;
  const receitaTotal = somar(resumos, (r) => r.receita);
  const descontoTotal = somar(resumos, (r) => r.desconto.total);

  const [
    trafego,
    trafegos7d,
    midia,
    campanhas,
    google,
    meta,
    producao,
    atendimento,
    reversas,
    estornos,
    clientes,
    cobertura,
  ] = await Promise.all([
      trafegoDoDia(dia),
      Promise.all(seteDias.map((d) => trafegoDoDia(d))),
      opcional('mídia', () => midiaDoDia(dia)),
      opcional('campanhas', () => desempenhoPorNivel(dia, 'campaign')),
      opcional('google', () => (temGoogleAds() ? midiaGoogleDoDia(dia) : Promise.resolve(null))),
      opcional('metas', () => metaDoDia(dia)),
      opcional('produção', () => producaoAtual()),
      opcional('atendimento', () => atendimentoAtual(dia)),
      opcional('trocas', () => (temTroque() ? reversasDoDia(dia) : Promise.resolve(null))),
      opcional('estornos', () => conferirEstorno(dia, dia)),
      opcional('clientes', () => novosVsRecorrentes(dia)),
      opcional('cobertura', () =>
        coberturaDosCampeoes(vendasPorData.get(dia)!, periodo),
      ),
    ]);

  // Mesmo dia da semana anterior. Varejo de moda tem semana forte: comparar
  // sábado com a média que inclui terça esconde o padrão em vez de revelar.
  const seteAtras = serie.find((p) => p.dia === diasAntes(dia, 7)[6]) ?? null;

  return {
    dia,
    geradoEm: new Date(),
    vendas,
    serie,
    media7d: {
      receita: receitaTotal / n,
      pedidos: somar(resumos, (r) => r.pedidos) / n,
      ticketMedio: somar(resumos, (r) => r.ticketMedio) / n,
      descontoPct:
        receitaTotal + descontoTotal > 0 ? descontoTotal / (receitaTotal + descontoTotal) : 0,
    },
    semanaPassada: seteAtras,
    trafego,
    trafego7d: {
      sessoes: somar(trafegos7d, (t) => t.sessoes) / n,
      taxaAdicao: somar(trafegos7d, (t) => t.taxaAdicao) / n,
      conversao: somar(trafegos7d, (t) => t.conversao) / n,
    },
    meta,
    midia,
    campanhas: campanhas ?? [],
    google,
    producao,
    atendimento,
    reversas,
    estornos,
    clientes,
    cobertura,
  };
}
