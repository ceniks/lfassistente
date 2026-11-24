/**
 * O leitor da listagem de cortes do Corte Pro.
 *
 * Existe num arquivo só porque a mesma listagem alimenta dois blocos —
 * patrimônio e cobertura dos campeões — e, quando o formato mudou, cada um
 * tinha a sua regex para ficar desatualizada em separado.
 *
 * E mudou. Até novembro cada corte vinha numa linha:
 *
 *   • CRT-027 — Casaco Londres ref:95 (Casaco) | No galpão | 826 pç | resp. Maria | início 22/05/2026
 *
 * Agora vem em quatro, com o código em outro lugar:
 *
 *   • CORTE 489 (codigo=489; codigo_interno=516) — Calça Barcelona Citizen ref:130 (Calça)
 *     No galpão | 1228 pç | resp. João Pereira | início 09/10/2026
 *     oficina R$ 32,00/pç = R$ 39.296,00 | …
 *     retirada da oficina 17/11/2026 | vencimento 12/12/2026 | a pagar
 *
 * O efeito do descompasso foi mudo e caro: zero corte reconhecido, "Em
 * produção: 0 peças" no check-in com 9.092 peças na oficina, e a coluna de
 * reposição dos campeões vazia — que é justamente o número que avisa antes da
 * ruptura. Por isso `lerCortes` confere o que leu contra o total que o
 * próprio Corte Pro declara no cabeçalho e **reclama** quando não bate: a
 * próxima mudança de formato vira erro, não silêncio.
 */

export interface CorteDoTexto {
  /** O `codigo` do Corte Pro (489, 487B) — o que `buscar_corte` entende. */
  codigo: string;
  /** Produto com a categoria no fim, como o Corte Pro escreve. */
  produto: string;
  categoria: string;
  status: string;
  pecas: number;
  /** dd/mm/aaaa, como veio. */
  inicio: string;
  /** Quando saiu da oficina; só existe para o que já está no galpão. */
  saiuDaOficina?: string;
}

const CABECALHO = /(\d+)\s*corte\(s\)/i;

/** Formato atual: cabeçalho com o código, e os campos nas linhas seguintes. */
const NOVO = /^•\s*CORTE\s+(\S+)\s*\(codigo=([^;)]+)[^)]*\)\s*—\s*(.+?)\s*$/i;

/** Formato antigo, de uma linha só. Mantido para não quebrar se voltar. */
const ANTIGO =
  /^•\s*([\w-]+)\s*—\s*(.+?)\s*\|\s*([^|]+?)\s*\|\s*(\d+)\s*pç.*?início\s*(\d{2}\/\d{2}\/\d{4})(?:.*?saiu da oficina\s*(\d{2}\/\d{2}\/\d{4}))?/i;

const categoriaDe = (produto: string) =>
  produto.match(/\(([^)]*)\)\s*$/)?.[1] ?? "";

/**
 * Lê a listagem. Lança quando leu menos cortes do que o cabeçalho anuncia —
 * ler pela metade é pior que não ler, porque vira número errado com cara de
 * número certo.
 */
export function lerCortes(texto: string): CorteDoTexto[] {
  const fora: CorteDoTexto[] = [];
  const blocos = texto.split(/\n(?=•)/);

  for (const bloco of blocos) {
    const linhas = bloco.split("\n");
    const primeira = linhas[0] ?? "";

    const antigo = primeira.match(ANTIGO);
    if (antigo) {
      fora.push({
        codigo: antigo[1],
        produto: antigo[2].trim(),
        categoria: categoriaDe(antigo[2]),
        status: antigo[3].trim(),
        pecas: Number(antigo[4]),
        inicio: antigo[5],
        saiuDaOficina: antigo[6],
      });
      continue;
    }

    const novo = primeira.match(NOVO);
    if (!novo) continue;

    const corpo = linhas.slice(1).join("\n");
    const campos = corpo.match(
      /^\s*([^|\n]+?)\s*\|\s*(\d+)\s*pç\s*\|.*?início\s*(\d{2}\/\d{2}\/\d{4})/m,
    );
    if (!campos) continue;

    const retirada = corpo.match(/retirada da oficina\s*(\d{2}\/\d{2}\/\d{4})/);

    fora.push({
      codigo: novo[2].trim(),
      produto: novo[3].trim(),
      categoria: categoriaDe(novo[3]),
      status: campos[1].trim(),
      pecas: Number(campos[2]),
      inicio: campos[3],
      saiuDaOficina: retirada?.[1],
    });
  }

  const anunciados = Number(texto.match(CABECALHO)?.[1] ?? NaN);
  if (Number.isFinite(anunciados) && fora.length < anunciados) {
    throw new Error(
      `Corte Pro: li ${fora.length} de ${anunciados} corte(s) — o formato da listagem mudou`,
    );
  }

  return fora;
}
