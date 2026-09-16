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
import { CUSTO_POR_CORTE } from './custo-por-corte.js';

export interface Patrimonio {
  loja: {
    pecas: number;
    valorDeVenda: number;
    valorDeCusto: number | null;
    /** Preço de etiqueta só das peças que têm custo — o par honesto do markup. */
    valorDeVendaComCusto: number;
  };
  /** Peças na oficina e no caseado. Em corte fica de fora: ainda é tecido. */
  emProducao: { pecas: number; cortes: number };
  /** Pronto no galpão e sem entrada no site, a partir da data de corte. */
  semSubirNoSite: { pecas: number; cortes: number; desde: string; lista: CorteParado[] };
  /** Produtos da loja para os quais não achamos custo no Corte Pro. */
  semCusto: { produtos: number; pecas: number };
  /** Custo baixo demais para o preço — quase sempre registro errado no corte. */
  custoSuspeito: CustoSuspeito[];
}

/**
 * Peça cujo custo não fecha com o preço.
 *
 * A alfaiataria da L&F trabalha entre 3,5 e 4,7 de markup — conferido corte a
 * corte com o Luis em 16/09. Acima de 6 não é margem boa, é custo faltando no
 * cadastro: a Camisa Layla aparecia a R$ 21,83 quando o painel do Corte Pro
 * mostra R$ 47,58, e a diferença só apareceu porque ele estranhou o total.
 * Esta lista existe para a próxima não depender de alguém estranhar.
 */
export interface CustoSuspeito {
  titulo: string;
  pecas: number;
  precoMedio: number;
  custoPorPeca: number;
  markup: number;
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


interface LinhaDeCorte {
  codigo: string;
  produto: string;
  /** A categoria que o Corte Pro declara, entre parênteses na listagem. */
  categoria: string;
  pecas: number;
  /** Data de início do corte, em ISO, para achar o mais recente. */
  inicio: string;
  chegouNoGalpao?: string;
}

/**
 * As formas pelas quais um corte pode ser reconhecido.
 *
 * O Corte Pro guarda a categoria em campo próprio, e ela nem sempre é a
 * primeira palavra do nome: o corte 2020 se chama "Blazer casaco roma" e está
 * declarado como **Casaco** — é o Casaco Roma da loja, 565 peças que ficavam
 * sem custo por causa disso. Mas o campo também tem erro de digitação (a "Calça
 * Nova montreal" está declarada como Blazer), então nenhuma das duas leituras
 * serve sozinha. Geramos as duas e aceitamos a que casar, desde que só uma
 * casar.
 */
interface Forma {
  categoria: string;
  modelo: string[];
}

function formasDoCorte(c: LinhaDeCorte): Forma[] {
  const nome = tokens(chaveDeProduto(c.produto));
  if (!nome.length) return [];

  const formas: Forma[] = [{ categoria: nome[0], modelo: nome.slice(1) }];

  const cat = chaveDeProduto(c.categoria);
  if (cat && cat !== nome[0]) {
    formas.push({ categoria: cat, modelo: nome.filter((t) => t !== cat) });
  }
  return formas.filter((f) => f.modelo.length > 0);
}

function formaDoProduto(titulo: string): Forma | null {
  const t = tokens(chaveDeProduto(titulo));
  if (t.length < 2) return null;
  return { categoria: t[0], modelo: t.slice(1) };
}

/** O modelo da loja tem de caber inteiro no modelo do corte, ou o contrário. */
function formasCasam(a: Forma, b: Forma): boolean {
  if (a.categoria !== b.categoria) return false;
  const [curto, longo] = a.modelo.length <= b.modelo.length ? [a.modelo, b.modelo] : [b.modelo, a.modelo];
  const cesta = new Set(longo);
  return curto.length > 0 && curto.every((t) => cesta.has(t));
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
    const bruto = m[2].trim();
    const categoria = bruto.match(/\(([^)]*)\)\s*$/)?.[1] ?? '';
    saida.push({
      codigo: m[1],
      produto: bruto,
      categoria,
      pecas: Number(m[4]),
      inicio: isoDeBr(m[5]),
      chegouNoGalpao: m[6],
    });
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
      loja: { pecas: pecasNaLoja, valorDeVenda, valorDeCusto: null, valorDeVendaComCusto: 0 },
      emProducao: { pecas: 0, cortes: 0 },
      semSubirNoSite: { pecas: 0, cortes: 0, desde, lista: [] },
      semCusto: { produtos: loja.length, pecas: pecasNaLoja },
      custoSuspeito: [],
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

  /*
   * Para o custo por peça vale o corte MAIS RECENTE de cada produto, e recente
   * é pela data de início — não pela ordem em que as listas chegaram.
   *
   * A primeira versão pegava o primeiro corte encontrado percorrendo
   * finalizados, galpão, oficina e caseado nessa ordem. Finalizado é, por
   * natureza, o mais antigo: qualquer produto com corte de janeiro herdava o
   * custo de janeiro mesmo tendo corte novo na oficina. O estoque inteiro saía
   * barato demais, com markup de 5 quando os cortes mostram 3,5.
   */
  const maisRecentePorProduto = new Map<string, LinhaDeCorte>();
  for (const c of [...finalizados, ...galpao, ...oficina, ...caseado]) {
    const k = chaveDeProduto(c.produto);
    const atual = maisRecentePorProduto.get(k);
    if (!atual || c.inicio > atual.inicio) maisRecentePorProduto.set(k, c);
  }

  // Só os cortes do galpão precisam de consulta individual — o custo vem da
  // tabela exportada, não da API. Antes eram uns 70 `buscar_corte` por
  // boletim; agora são os poucos candidatos a "não subiu no site".
  const codigos = [...new Set(candidatos.map((c) => c.codigo))];
  const detalhes = new Map<string, Detalhe>();
  const lidos = await emLotes(codigos, 6, async (cod) => [cod, await detalhe(srv, cod)] as const);
  for (const [cod, d] of lidos) if (d) detalhes.set(cod, d);

  /*
   * Custo por peça, do corte mais recente de cada produto, tirado da tabela
   * exportada do Corte Pro.
   *
   * A API não serve para isto: em parte dos cortes o `Custo total` dela é
   * cerca de metade do que o painel mostra (Camisa Layla, R$ 21,83 contra
   * R$ 47,58). Ver o comentário em `custo-por-corte.ts`.
   */
  const custoPorPeca = new Map<string, number>();
  const corteDoCusto = new Map<string, LinhaDeCorte>();

  for (const linha of CUSTO_POR_CORTE) {
    if (!linha.custoPorPeca) continue;
    const chave = chaveDeProduto(linha.produto);
    const atual = corteDoCusto.get(chave);
    if (atual && atual.inicio >= linha.data) continue;

    corteDoCusto.set(chave, {
      codigo: linha.corte,
      produto: linha.produto,
      // A exportação não traz a categoria; o nome carrega ela na frente.
      categoria: '',
      pecas: 0,
      inicio: linha.data,
    });
    custoPorPeca.set(chave, linha.custoPorPeca);
  }

  // Índice de formas, para não recalcular a cada produto da loja.
  const formasPorChave = new Map<string, Forma[]>();
  for (const [chave, corte] of corteDoCusto) {
    formasPorChave.set(chave, formasDoCorte(corte));
  }

  const buscarCusto = (titulo: string): number | undefined => {
    const chave = chaveDeProduto(titulo);
    const exato = custoPorPeca.get(chave);
    if (exato !== undefined) return exato;

    const forma = formaDoProduto(titulo);
    if (!forma) return undefined;

    const parecidas = [...formasPorChave.entries()]
      .filter(([, formas]) => formas.some((f) => formasCasam(f, forma)))
      .map(([k]) => k);

    // Ambíguo é o mesmo que não achar: custo errado é pior que custo ausente.
    if (parecidas.length !== 1) return undefined;
    return custoPorPeca.get(parecidas[0]);
  };

  const MARKUP_ABSURDO = 6;

  let valorDeCusto = 0;
  let valorDeVendaComCusto = 0;
  let produtosSemCusto = 0;
  let pecasSemCusto = 0;
  const custoSuspeito: CustoSuspeito[] = [];

  for (const item of loja) {
    const c = buscarCusto(item.titulo);
    if (c === undefined) {
      produtosSemCusto++;
      pecasSemCusto += item.unidades;
      continue;
    }
    valorDeCusto += c * item.unidades;
    valorDeVendaComCusto += item.valorDeVenda;

    const preco = item.valorDeVenda / item.unidades;
    const markup = c > 0 ? preco / c : Infinity;
    if (markup > MARKUP_ABSURDO) {
      custoSuspeito.push({
        titulo: item.titulo,
        pecas: item.unidades,
        precoMedio: preco,
        custoPorPeca: c,
        markup,
      });
    }
  }

  custoSuspeito.sort((a, b) => b.pecas - a.pecas);

  // Na dúvida o corte conta como já subido: dizer que falta subir peça que já
  // está no site inventa estoque que não existe.
  const parados = candidatos.filter((c) => detalhes.get(c.codigo)?.subiu === false);

  return {
    loja: { pecas: pecasNaLoja, valorDeVenda, valorDeCusto, valorDeVendaComCusto },
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
    custoSuspeito,
  };
}
