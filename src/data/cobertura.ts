/**
 * Quanto tempo o estoque dos campeões ainda aguenta.
 *
 * Nasce de uma lacuna concreta: o relatório dizia que o Casaco Londres vendeu
 * 58 peças e não dizia quantas sobraram. Ruptura de campeão de venda é
 * descoberta hoje quando a venda cai — tarde demais para cortar, costurar e
 * repor. A cobertura em dias antecipa isso.
 */
import { estoqueDeProdutos, type ResumoVendas, type UnidadesDeProduto } from './shopify.js';
import { cortesAbertos, type CorteAberto } from './producao.js';

export interface Cobertura {
  titulo: string;
  /** Vendidas no dia do relatório. */
  vendidasNoDia: number;
  mediaDiaria: number;
  estoque: number | null;
  /** Estoque ÷ média diária. `null` quando não há estoque conhecido. */
  diasDeCobertura: number | null;
  /** Peças em corte, oficina ou caseado — ainda sendo feitas. */
  emProducao: number;
  /** Peças prontas no galpão que ainda não subiram no site. */
  prontasNoGalpao: number;
  /** Data de início do corte mais antigo ainda aberto desse produto. */
  corteMaisAntigo?: string;
}

/**
 * Compara nomes que vêm de dois sistemas com grafias diferentes.
 *
 * O Corte Pro escreve "Blazer filadelfia ref:97 (Blazer)" e a Shopify
 * "Blazer Filadélfia". Tirar acento, caixa, a referência e a categoria entre
 * parênteses faz os dois virarem "blazer filadelfia". O espaço duplo que existe
 * em "Calça  Barcelona" também é normalizado.
 */
function chaveDeProduto(nome: string): string {
  return nome
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\bref:?\s*\d+/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tudo que ainda pode virar estoque: o que está sendo feito mais o que só falta subir. */
export function reposicao(c: Cobertura): number {
  return c.emProducao + c.prontasNoGalpao;
}

export async function coberturaDosCampeoes(
  vendas: ResumoVendas,
  unidadesPorProduto: Map<string, UnidadesDeProduto>,
  diasComVenda: number,
): Promise<Cobertura[]> {
  const campeoes = vendas.topProdutos;
  if (!campeoes.length) return [];

  const chavesDosCampeoes = new Set(campeoes.map((p) => chaveDeProduto(p.titulo)));

  const ids = campeoes
    .map((p) => unidadesPorProduto.get(p.titulo)?.produtoId)
    .filter((id): id is string => Boolean(id));

  // A produção é opcional: sem ela a cobertura ainda vale, só perde o "tem
  // reposição vindo". Falhar aqui derrubaria o bloco inteiro por um extra.
  const [estoque, cortes] = await Promise.all([
    estoqueDeProdutos(ids),
    cortesAbertos((produto) => chavesDosCampeoes.has(chaveDeProduto(produto))).catch(
      () => [] as CorteAberto[],
    ),
  ]);

  const producaoPorProduto = new Map<
    string,
    { pecas: number; prontas: number; maisAntigo?: string }
  >();
  for (const c of cortes) {
    const k = chaveDeProduto(c.produto);
    const atual = producaoPorProduto.get(k) ?? { pecas: 0, prontas: 0 };
    if (c.prontaNoGalpao) atual.prontas += c.pecas;
    else atual.pecas += c.pecas;
    // As datas vêm em dd/mm/aaaa; comparar por tempo evita ordenar texto.
    const emMs = (br: string) => {
      const [d, m, a] = br.split('/');
      return new Date(`${a}-${m}-${d}T12:00:00-03:00`).getTime();
    };
    if (!atual.maisAntigo || emMs(c.inicio) < emMs(atual.maisAntigo)) atual.maisAntigo = c.inicio;
    producaoPorProduto.set(k, atual);
  }

  return campeoes.map((p) => {
    const serie = unidadesPorProduto.get(p.titulo);
    const media = serie ? serie.unidades / diasComVenda : p.pecas;
    const est = serie?.produtoId ? (estoque.get(serie.produtoId)?.unidades ?? null) : null;
    const prod = producaoPorProduto.get(chaveDeProduto(p.titulo));

    return {
      titulo: p.titulo,
      vendidasNoDia: p.pecas,
      mediaDiaria: media,
      estoque: est,
      diasDeCobertura: est !== null && media > 0 ? est / media : null,
      emProducao: prod?.pecas ?? 0,
      prontasNoGalpao: prod?.prontas ?? 0,
      corteMaisAntigo: prod?.maisAntigo,
    };
  });
}
