/**
 * O balanço de estoque de cada dia, guardado.
 *
 * O boletim calculava o estoque de manhã, mostrava e esquecia. Então
 * "quantas peças o site tinha no dia 19?" só podia ser respondido por
 * dedução: pegar o estoque de hoje e somar de volta as vendas de cada dia.
 *
 * Essa dedução tem um furo que não dá para contornar — ela assume que nada
 * entrou. Em 24/11 ela produziu 55.101 peças para o dia 17, e estava errada,
 * porque em 19/11 subiu a Calça Tóquio. Entrada no meio do caminho inverte o
 * sinal da conta e ninguém tem como saber, depois, de quanto foi.
 *
 * Com o registro diário a pergunta vira consulta. E o que era impossível
 * deduzir passa a ser calculável ao contrário: sabendo o estoque de dois dias
 * e o que foi vendido entre eles, **o que entrou é a diferença** — sem
 * depender de ninguém marcar nada no Corte Pro.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const ARQUIVO = process.env.HISTORICO_ESTOQUE ?? "dados/estoque-diario.json";

export interface BalancoDiario {
  /** Dia em que o estoque foi medido (AAAA-MM-DD, São Paulo). */
  medidoEm: string;
  /** Peças ativas na loja. */
  noSite: number;
  valorDeVenda: number;
  valorDeCusto: number | null;
  /** Oficina + caseado. */
  emProducao: number;
  /** Pronto no galpão e ainda fora do site. */
  prontoForaDoSite: number;
  /** O dia que o boletim cobriu, e quantas peças saíram nele. */
  diaDoBoletim: string;
  vendidasNoDia: number;
}

export interface Movimento {
  de: string;
  ate: string;
  estoqueDe: number;
  estoqueAte: number;
  vendidas: number;
  /**
   * O que entrou no site entre as duas medições.
   *
   * `estoqueAte - estoqueDe + vendidas`. Negativo não é entrada negativa: é
   * peça que saiu do site sem ser vendida — produto despublicado, ajuste de
   * inventário, perda. Vale mostrar como está.
   */
  entraram: number;
}

function ler(): Record<string, BalancoDiario> {
  try {
    return JSON.parse(readFileSync(ARQUIVO, "utf8")) as Record<string, BalancoDiario>;
  } catch {
    return {};
  }
}

export function registrarBalanco(b: BalancoDiario): void {
  const livro = ler();
  livro[b.medidoEm] = b;
  mkdirSync(dirname(ARQUIVO), { recursive: true });
  writeFileSync(ARQUIVO, JSON.stringify(livro, null, 1));
}

export function balancoEm(dia: string): BalancoDiario | null {
  return ler()[dia] ?? null;
}

/** Todos os balanços, do mais antigo para o mais novo. */
export function historico(): BalancoDiario[] {
  return Object.values(ler()).sort((a, b) => a.medidoEm.localeCompare(b.medidoEm));
}

/** A medição imediatamente anterior a `dia`, se houver. */
export function anteriorA(dia: string): BalancoDiario | null {
  const antes = historico().filter((b) => b.medidoEm < dia);
  return antes.at(-1) ?? null;
}

/**
 * O que aconteceu entre duas medições consecutivas.
 *
 * `null` quando não há medição anterior — é o caso do primeiro dia, e dizer
 * "entraram 0" ali seria inventar.
 */
export function movimentoAte(dia: string): Movimento | null {
  const atual = balancoEm(dia);
  const antes = anteriorA(dia);
  if (!atual || !antes) return null;

  /*
   * As vendas contadas são as dos dias cobertos entre as duas medições. Cada
   * balanço guarda as vendas do dia que o boletim cobriu, então somar os
   * registros do intervalo é somar exatamente o que saiu.
   */
  const vendidas = historico()
    .filter((b) => b.medidoEm > antes.medidoEm && b.medidoEm <= dia)
    .reduce((s, b) => s + b.vendidasNoDia, 0);

  return {
    de: antes.medidoEm,
    ate: dia,
    estoqueDe: antes.noSite,
    estoqueAte: atual.noSite,
    vendidas,
    entraram: atual.noSite - antes.noSite + vendidas,
  };
}
