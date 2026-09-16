/**
 * O check-in geral do estoque: quantas peças a operação tem, e quanto valem.
 *
 * Três lugares diferentes guardam pedaços dessa resposta e nenhum deles sozinho
 * responde "quanto de roupa a L&F tem hoje":
 *
 *  - a Shopify sabe o que está à venda no site, com preço;
 *  - o Corte Pro sabe o custo real de cada peça, porque é ele que fecha o
 *    valor com a oficina;
 *  - e há um limbo entre os dois: peça pronta no galpão que ainda não teve
 *    entrada no site. Ela existe, está paga, e não aparece em lugar nenhum.
 */
import { estoqueDaLoja, type ItemDeEstoque } from './shopify.js';
import { chamarFerramenta } from './mcp-client.js';
import { config } from '../config.js';

export interface Patrimonio {
  loja: { pecas: number; valorDeVenda: number; valorDeCusto: number | null };
  /** Peças na oficina e no caseado. Em corte fica de fora: ainda é tecido. */
  emProducao: { pecas: number; cortes: number };
  /** Pronto no galpão e sem entrada no site, a partir da data de corte. */
  semSubirNoSite: { pecas: number; cortes: number; desde: string; lista: CorteParado[] };
  /** Produtos da loja para os quais não achamos custo no Corte Pro. */
  semCusto: { produtos: number; pecas: number };
}

export interface CorteParado {
  codigo: string;
  produto: string;
  pecas: number;
  chegouNoGalpao: string;
}

/** Só cortes que chegaram ao galpão a partir daqui entram na conta do que falta subir. */
const DESDE_PADRAO = '2026-07-01';

function servidor() {
  const c = config();
  if (!c.CORTEPRO_MCP_URL) return null;
  return { nome: 'cortepro', url: c.CORTEPRO_MCP_URL, token: c.CORTEPRO_TOKEN };
}

/** "R$ 96.307,49" → 96307.49 */
function dinheiroBr(texto: string): number {
  return Number(texto.replace(/\./g, '').replace(',', '.'));
}

/** "14/08/2026" → "2026-08-14", para comparar como texto. */
function isoDeBr(br: string): string {
  const [d, m, a] = br.split('/');
  return `${a}-${m}-${d}`;
}

/**
 * Compara nomes entre Shopify e Corte Pro.
 *
 * Mesma normalização da cobertura: tira acento, caixa, a referência e o que
 * está entre parênteses. "Calça nova espanha (Yonny)" e "Calça Espanha" não
 * viram a mesma coisa — e não deveriam, são modelos diferentes.
 */
export function chaveDeProduto(nome: string): string {
  return nome
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\bref:?\s*[\w-]+/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Palavras que descrevem a variação do modelo, não o modelo.
 *
 * O Corte Pro batiza o corte pelo que o diferencia do anterior — "Calça Nova
 * Londres" é a Calça Londres com modelagem nova, "Casaco Jaqueta Dubai" é o
 * Casaco Dubai. Na Shopify o produto tem só o nome. Sem tirar essas palavras,
 * 4.174 peças ficavam sem custo por causa de um adjetivo.
 */
const PALAVRAS_DE_VARIACAO = new Set([
  'novo',
  'nova',
  'conj',
  'jaqueta',
  'babado',
  'bicudo',
  'listrado',
  'listrada',
  'listardo',
  'longo',
  'curto',
]);

function tokens(chave: string): string[] {
  return chave.split(' ').filter((t) => t && !PALAVRAS_DE_VARIACAO.has(t));
}

/**
 * Um nome casa com o outro quando a categoria é a mesma e os tokens do mais
 * curto cabem inteiros no mais longo.
 *
 * Três exigências, cada uma tirada de um erro real:
 *
 *  - a categoria é o primeiro token e tem de bater exatamente, porque "calça
 *    Itália" e "casaco Itália" são produtos diferentes com o mesmo modelo;
 *  - todos os tokens do mais curto têm de aparecer no mais longo, senão "Calça
 *    Nova York" casaria com o corte "Calça Nova", que é outro produto;
 *  - e o mais curto precisa ter ao menos dois tokens. Corte batizado só com a
 *    categoria — "Casaco", "Calça Nova", "Camisa conj" — encaixaria em tudo da
 *    categoria. Foi o que aconteceu: o Blazer Tóquio herdou em silêncio o custo
 *    de "Blazer bicudo listrado", e Calça Londres ficou sem custo nenhum porque
 *    três cortes genéricos empataram com o certo.
 */
function casa(a: string, b: string): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return false;
  if (ta[0] !== tb[0]) return false;

  const [curto, longo] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (curto.length < 2) return false;

  const cesta = new Set(longo);
  return curto.every((t) => cesta.has(t));
}

interface LinhaDeCorte {
  codigo: string;
  produto: string;
  pecas: number;
  chegouNoGalpao?: string;
}

const LINHA =
  /•\s*([\w-]+)\s*—\s*(.+?)\s*\|\s*([^|]+?)\s*\|\s*(\d+)\s*pç.*?início\s*(\d{2}\/\d{2}\/\d{4})(?:.*?saiu da oficina\s*(\d{2}\/\d{2}\/\d{4}))?/g;

async function listar(srv: NonNullable<ReturnType<typeof servidor>>, status: string) {
  let texto: string;
  try {
    texto = await chamarFerramenta(srv, 'listar_cortes', { status, limite: 200 });
  } catch {
    return [] as LinhaDeCorte[];
  }
  const saida: LinhaDeCorte[] = [];
  for (const m of texto.matchAll(LINHA)) {
    saida.push({ codigo: m[1], produto: m[2].trim(), pecas: Number(m[4]), chegouNoGalpao: m[6] });
  }
  return saida;
}

interface Detalhe {
  pecas: number;
  custoTotal: number;
  subiu: boolean | null;
}

async function detalhe(
  srv: NonNullable<ReturnType<typeof servidor>>,
  codigo: string,
): Promise<Detalhe | null> {
  let texto: string;
  try {
    texto = await chamarFerramenta(srv, 'buscar_corte', { busca: codigo });
  } catch {
    return null;
  }

  const blocos = texto.split(/\n-{3,}\n/);
  const bloco =
    blocos.find((b) => new RegExp(`^CORTE\\s+${codigo}\\b`, 'im').test(b.trim())) ?? blocos[0];

  const pecas = Number(bloco.match(/Total de peças:\s*(\d+)/i)?.[1] ?? 0);
  const custo = bloco.match(/Custo total:\s*R\$\s*([\d.,]+)/i)?.[1];
  const subido = bloco.match(/Estoque subido no sistema:\s*(.+)/i)?.[1]?.trim().toLowerCase();

  return {
    pecas,
    custoTotal: custo ? dinheiroBr(custo) : 0,
    subiu:
      subido === undefined
        ? null
        : subido !== 'não' && subido !== 'nao' && subido !== '—' && subido !== '-' && subido !== '',
  };
}

/** Roda em lotes: o Corte Pro responde um corte por chamada. */
async function emLotes<T, R>(itens: T[], tamanho: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const saida: R[] = [];
  for (let i = 0; i < itens.length; i += tamanho) {
    saida.push(...(await Promise.all(itens.slice(i, i + tamanho).map(f))));
  }
  return saida;
}

export async function patrimonioDoDia(desde = DESDE_PADRAO): Promise<Patrimonio | null> {
  const srv = servidor();
  const loja = await estoqueDaLoja();

  const pecasNaLoja = loja.reduce((t, i) => t + i.unidades, 0);
  const valorDeVenda = loja.reduce((t, i) => t + i.valorDeVenda, 0);

  if (!srv) {
    return {
      loja: { pecas: pecasNaLoja, valorDeVenda, valorDeCusto: null },
      emProducao: { pecas: 0, cortes: 0 },
      semSubirNoSite: { pecas: 0, cortes: 0, desde, lista: [] },
      semCusto: { produtos: loja.length, pecas: pecasNaLoja },
    };
  }

  const [oficina, caseado, galpao, finalizados] = await Promise.all([
    listar(srv, 'na_oficina'),
    listar(srv, 'caseado'),
    listar(srv, 'no_galpao'),
    listar(srv, 'finalizado'),
  ]);

  const emProducao = {
    pecas: [...oficina, ...caseado].reduce((t, c) => t + c.pecas, 0),
    cortes: oficina.length + caseado.length,
  };

  // Candidatos a "não subiu": qualquer corte que já chegou ao galpão a partir
  // da data de corte. Antes disso o campo não era preenchido e o vazio não
  // significa nada — mesma razão do corte 410 na cobertura.
  const candidatos = [...galpao, ...finalizados].filter(
    (c) => c.chegouNoGalpao && isoDeBr(c.chegouNoGalpao) >= desde,
  );

  // Para o custo por peça basta o corte mais recente de cada produto.
  const maisRecentePorProduto = new Map<string, LinhaDeCorte>();
  for (const c of [...finalizados, ...galpao, ...oficina, ...caseado]) {
    const k = chaveDeProduto(c.produto);
    if (!maisRecentePorProduto.has(k)) maisRecentePorProduto.set(k, c);
  }

  const codigos = [
    ...new Set([...candidatos.map((c) => c.codigo), ...[...maisRecentePorProduto.values()].map((c) => c.codigo)]),
  ];
  const detalhes = new Map<string, Detalhe>();
  const lidos = await emLotes(codigos, 6, async (cod) => [cod, await detalhe(srv, cod)] as const);
  for (const [cod, d] of lidos) if (d) detalhes.set(cod, d);

  // Custo por peça, por produto.
  const custoPorPeca = new Map<string, number>();
  for (const [chave, corte] of maisRecentePorProduto) {
    const d = detalhes.get(corte.codigo);
    if (!d || !d.pecas || !d.custoTotal) continue;
    custoPorPeca.set(chave, d.custoTotal / d.pecas);
  }

  const chavesComCusto = [...custoPorPeca.keys()];
  const buscarCusto = (titulo: string): number | undefined => {
    const chave = chaveDeProduto(titulo);
    const exato = custoPorPeca.get(chave);
    if (exato !== undefined) return exato;

    const parecidas = chavesComCusto.filter((k) => casa(k, chave));
    if (parecidas.length !== 1) return undefined; // ambíguo é o mesmo que não achar
    return custoPorPeca.get(parecidas[0]);
  };

  let valorDeCusto = 0;
  let produtosSemCusto = 0;
  let pecasSemCusto = 0;
  for (const item of loja) {
    const c = buscarCusto(item.titulo);
    if (c === undefined) {
      produtosSemCusto++;
      pecasSemCusto += item.unidades;
      continue;
    }
    valorDeCusto += c * item.unidades;
  }

  // Na dúvida o corte conta como já subido: dizer que falta subir peça que já
  // está no site inventa estoque que não existe.
  const parados = candidatos.filter((c) => detalhes.get(c.codigo)?.subiu === false);

  return {
    loja: { pecas: pecasNaLoja, valorDeVenda, valorDeCusto },
    emProducao,
    semSubirNoSite: {
      pecas: parados.reduce((t, c) => t + c.pecas, 0),
      cortes: parados.length,
      desde,
      lista: parados
        .map((c) => ({
          codigo: c.codigo,
          produto: c.produto,
          pecas: c.pecas,
          chegouNoGalpao: c.chegouNoGalpao!,
        }))
        .sort((a, b) => b.pecas - a.pecas),
    },
    semCusto: { produtos: produtosSemCusto, pecas: pecasSemCusto },
  };
}
