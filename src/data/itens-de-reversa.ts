/**
 * O cache de itens das reversas.
 *
 * A taxa de retorno precisa contar PEÇAS, não reversas: cada reversa traz duas
 * em média, e a proporção entre troca e estorno só existe no item — o
 * `reverse_type` da reversa não serve de atalho (das 851 reversas postadas de
 * 19/08 a 17/09, 93 vinham marcadas "Sem Reembolso" e mesmo assim tinham itens
 * de troca e de estorno dentro).
 *
 * O problema é que a listagem do Troquecommerce não traz `items` — só o detalhe
 * traz, uma chamada por reversa. São ~2.200 reversas em sessenta dias e a API
 * entrega de 4 a 7 por segundo faça o que fizer com a concorrência: sete
 * minutos para montar um bloco do boletim, todo dia, relendo o que não mudou.
 *
 * Então guardamos em disco o mínimo que a conta usa — quantidade e se é troca —
 * com o `updated_at` ao lado. Cada boletim busca só o que nunca viu ou o que
 * mudou desde a última vez: na operação normal são as reversas do dia, uns
 * vinte segundos. Status e data vêm sempre da listagem, que é fresca, então uma
 * reversa que foi postada hoje é contada hoje sem rebuscar nada.
 *
 * O arquivo é descartável por construção: sumiu (deploy novo, container
 * reciclado), o primeiro boletim reconstrói. Por isso ele não vai para o git.
 */
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { detalhe, type Loja, type Reversa } from "./troque.js";

export interface ItemContado {
  q: number;
  troca: boolean;
}

interface Registro {
  atualizada: string;
  itens: ItemContado[];
}

const ARQUIVO = process.env.CACHE_REVERSAS ?? "dados/reversas-itens.json";

/** Quantas reversas buscar de uma vez. Acima disso a API não vai mais rápido. */
const SIMULTANEAS = 8;

async function carregar(): Promise<Map<string, Registro>> {
  try {
    const bruto = await readFile(ARQUIVO, "utf8");
    return new Map(Object.entries(JSON.parse(bruto) as Record<string, Registro>));
  } catch {
    return new Map();
  }
}

async function gravar(cache: Map<string, Registro>): Promise<void> {
  try {
    await mkdir(dirname(ARQUIVO), { recursive: true });
    const tmp = `${ARQUIVO}.tmp`;
    await writeFile(tmp, JSON.stringify(Object.fromEntries(cache)));
    // Troca atômica: um boletim interrompido no meio da escrita deixaria um
    // JSON truncado, e o próximo leitor cairia no catch e refaria tudo.
    await rename(tmp, ARQUIVO);
  } catch (e) {
    console.error("[reversas] não consegui gravar o cache, seguindo:", e);
  }
}

/**
 * Os itens de cada reversa da lista, buscando só o que falta.
 *
 * Devolve um mapa por id. Reversa cujo detalhe falhou fica de fora do mapa — a
 * conta trata como desconhecida em vez de contar zero peça, que empurraria a
 * taxa para baixo em silêncio.
 */
export async function itensDasReversas(
  reversas: Reversa[],
  loja: Loja = "atual",
  /**
   * Teto de buscas nesta chamada. Com o cache frio (deploy novo) são ~2.200
   * detalhes, uns sete minutos — o boletim das 8h tem teto de dez. Passado o
   * limite, busca o que dá, grava e desiste: o bloco sai no dia seguinte em vez
   * de derrubar o boletim inteiro.
   */
  limite = Infinity,
): Promise<Map<string, ItemContado[]>> {
  const cache = await carregar();

  const todosFaltando = reversas.filter((r) => {
    const guardado = cache.get(r.id);
    return !guardado || guardado.atualizada !== (r.updated_at ?? "");
  });
  const faltando = todosFaltando.slice(0, limite);

  if (faltando.length) {
    const t0 = Date.now();
    let i = 0;
    let erros = 0;
    // Grava de tempos em tempos, não só no fim: a primeira montagem busca
    // milhares de reversas e leva minutos, e um processo morto no meio jogaria
    // tudo fora. Com o salvamento parcial a próxima tentativa continua de onde
    // parou.
    const A_CADA = 250;
    let prontos = 0;
    const buscar = async () => {
      while (i < faltando.length) {
        const r = faltando[i++];
        try {
          const d = await detalhe(r.id, loja);
          cache.set(r.id, {
            atualizada: r.updated_at ?? "",
            itens: (d.items ?? []).map((it) => ({
              q: it.quantity ?? 1,
              troca: Boolean(it.is_exchange),
            })),
          });
        } catch {
          erros += 1;
        }
        prontos += 1;
        if (prontos % A_CADA === 0) await gravar(cache);
      }
    };
    await Promise.all(Array.from({ length: SIMULTANEAS }, buscar));
    const s = ((Date.now() - t0) / 1000).toFixed(1);
    console.error(
      `[reversas] ${faltando.length - erros} detalhe(s) novos em ${s}s` +
        (erros ? ` · ${erros} falharam` : ""),
    );
    await gravar(cache);
  }

  if (todosFaltando.length > faltando.length) {
    throw new Error(
      `cache de reversas ainda aquecendo: faltam ${todosFaltando.length - faltando.length}`,
    );
  }

  const saida = new Map<string, ItemContado[]>();
  for (const r of reversas) {
    const guardado = cache.get(r.id);
    if (guardado) saida.set(r.id, guardado.itens);
  }
  return saida;
}
