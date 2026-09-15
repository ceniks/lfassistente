import { config } from '../config.js';
import { chamarFerramenta } from './mcp-client.js';

export interface Producao {
  naOficina: number;
  pecasNaOficina: number;
  noGalpao: number;
  atrasados: number;
  /** O corte mais antigo em atraso, que é o que costuma importar. */
  maisCritico?: string;
  diasDeAtrasoDoMaisCritico?: number;
}

function servidor() {
  const c = config();
  if (!c.CORTEPRO_MCP_URL) return null;
  return { nome: 'cortepro', url: c.CORTEPRO_MCP_URL, token: c.CORTEPRO_TOKEN };
}

/**
 * Lê o panorama de produção do Corte Pro.
 *
 * O `resumo_producao` devolve texto formatado para humano, não JSON — então
 * aqui há parse por regex. É frágil por natureza: se o Corte Pro mudar a
 * redação, isto para de achar os números. Por isso cada campo falha para zero
 * em vez de quebrar o resumo inteiro, e o texto cru fica disponível para o
 * agente quando ele precisar de detalhe.
 *
 * Formato esperado:
 *
 *   Panorama da produção (117 cortes cadastrados):
 *   • Finalizado: 56 corte(s), 52213 peças
 *   • Na oficina: 27 corte(s), 27967 peças
 *
 *   Atrasados na oficina (9):
 *   • 466 — Calça Nova ref:114 (retorno previsto 05/09/2026)
 */
export async function producaoAtual(): Promise<Producao | null> {
  const srv = servidor();
  if (!srv) return null;

  const texto = await chamarFerramenta(srv, 'resumo_producao');

  const etapa = (nome: string) => {
    const m = texto.match(
      new RegExp(`${nome}:\\s*(\\d+)\\s*corte\\(s\\),\\s*(\\d+)\\s*peças`, 'i'),
    );
    return { cortes: Number(m?.[1] ?? 0), pecas: Number(m?.[2] ?? 0) };
  };

  const oficina = etapa('Na oficina');
  const galpao = etapa('No galpão');

  const atrasados = Number(texto.match(/Atrasados na oficina \((\d+)\)/i)?.[1] ?? 0);

  // Cada linha de atraso: "• 442 — Colete zurique ref:101 (retorno previsto 16/08/2026)"
  const linhas = [...texto.matchAll(/•\s*(\d+)\s*—\s*(.+?)\s*\(retorno previsto (\d{2}\/\d{2}\/\d{4})\)/g)];

  let maisCritico: string | undefined;
  let diasDeAtraso: number | undefined;

  if (linhas.length) {
    const comData = linhas.map((m) => {
      const [d, mes, ano] = m[3].split('/').map(Number);
      return { descricao: m[2], quando: new Date(ano, mes - 1, d), texto: m[3] };
    });

    comData.sort((a, b) => a.quando.getTime() - b.quando.getTime());
    const pior = comData[0];

    maisCritico = `${pior.descricao} (previsão era ${pior.texto})`;
    diasDeAtraso = Math.floor((Date.now() - pior.quando.getTime()) / 86_400_000);
  }

  return {
    naOficina: oficina.cortes,
    pecasNaOficina: oficina.pecas,
    noGalpao: galpao.cortes,
    atrasados,
    maisCritico,
    diasDeAtrasoDoMaisCritico: diasDeAtraso,
  };
}

/** Texto cru do estoque de tecidos, para quando o Luis perguntar direto. */
export async function estoqueTecidos(tecido?: string, cor?: string): Promise<string | null> {
  const srv = servidor();
  if (!srv) return null;
  return chamarFerramenta(srv, 'estoque_tecidos', {
    tecido: tecido ?? null,
    cor: cor ?? null,
  });
}

/** Um corte que ainda não virou estoque na Shopify. */
export interface CorteAberto {
  codigo: string;
  produto: string;
  pecas: number;
  status: string;
  inicio: string;
  /** Peça pronta no galpão, esperando só a entrada no site. */
  prontaNoGalpao: boolean;
  /** Dia em que saiu da oficina. Só existe para o que está no galpão. */
  saiuDaOficina?: string;
}

/**
 * Os cortes que ainda vão virar peça no estoque da Shopify.
 *
 * O critério é o campo "subiu no site" do Corte Pro, não a etapa. Corte no
 * galpão está dos dois lados: o 445 subiu no dia seguinte à retirada, o 491
 * saiu da oficina em 10/09 e segue sem subir. Por isso o galpão entra na
 * varredura e é conferido corte a corte. Antes do galpão — em corte, na
 * oficina, caseado — a peça pronta ainda não existe e nunca está na Shopify,
 * então não há o que conferir.
 *
 * `interessa` limita a conferência aos produtos que o relatório vai mostrar:
 * cada corte do galpão custa uma chamada extra ao Corte Pro.
 */
const ETAPAS_ANTES_DO_GALPAO = ['em_corte', 'na_oficina', 'caseado'] as const;

/**
 * Antes disto o campo "subiu no site" não era preenchido — o controle começou
 * no corte 410 (CRT-025), de 30/03/2026. Em corte mais antigo o campo vazio
 * não quer dizer que a peça não subiu, só que ninguém marcava. Contar esses
 * como reposição inflaria o número com peça que já está na Shopify há meses,
 * então corte iniciado antes desta data fica de fora.
 */
const INICIO_DO_CONTROLE = '2026-03-30';

/** Datas do Corte Pro vêm em dd/mm/aaaa; comparar em aaaa-mm-dd é o que ordena. */
function emIso(br: string): string {
  const [d, m, a] = br.split('/');
  return `${a}-${m}-${d}`;
}

// "• CRT-027 — Casaco  Londres ref:95 (Casaco) | No galpão | 826 pç | resp. Maria | início 22/05/2026 | saiu da oficina 11/08/2026"
const LINHA_DE_CORTE =
  /•\s*([\w-]+)\s*—\s*(.+?)\s*\|\s*([^|]+?)\s*\|\s*(\d+)\s*pç.*?início\s*(\d{2}\/\d{2}\/\d{4})(?:.*?saiu da oficina\s*(\d{2}\/\d{2}\/\d{4}))?/g;

type Servidor = { nome: string; url: string; token?: string };

async function cortesDaEtapa(srv: Servidor, status: string): Promise<CorteAberto[]> {
  let texto: string;
  try {
    texto = await chamarFerramenta(srv, 'listar_cortes', { status, limite: 200 });
  } catch {
    return [];
  }

  const saida: CorteAberto[] = [];
  for (const m of texto.matchAll(LINHA_DE_CORTE)) {
    saida.push({
      codigo: m[1],
      produto: m[2].trim(),
      status: m[3].trim(),
      pecas: Number(m[4]),
      inicio: m[5],
      prontaNoGalpao: status === 'no_galpao',
      saiuDaOficina: m[6],
    });
  }
  return saida;
}

/**
 * Lê no detalhe do corte se o estoque já foi dado de entrada no site.
 *
 * `null` quando não deu para saber — chamada falhou ou o campo não veio.
 */
async function jaSubiuNoSite(srv: Servidor, codigo: string): Promise<boolean | null> {
  let texto: string;
  try {
    texto = await chamarFerramenta(srv, 'buscar_corte', { busca: codigo });
  } catch {
    return null;
  }

  // A busca por código pode devolver mais de um corte; fica só o bloco do
  // código pedido para não ler o campo do corte vizinho.
  const blocos = texto.split(/\n-{3,}\n/);
  const bloco =
    blocos.find((b) => new RegExp(`^CORTE\\s+${codigo}\\b`, 'im').test(b.trim())) ?? blocos[0];

  const m = bloco.match(/Estoque subido no sistema:\s*(.+)/i);
  if (!m) return null;

  const valor = m[1].trim().toLowerCase();
  return valor !== 'não' && valor !== 'nao' && valor !== '—' && valor !== '-' && valor !== '';
}

export async function cortesAbertos(
  interessa?: (produto: string) => boolean,
): Promise<CorteAberto[]> {
  const srv = servidor();
  if (!srv) return [];

  const querido = (c: CorteAberto) => (interessa ? interessa(c.produto) : true);

  const [antesDoGalpao, galpao] = await Promise.all([
    Promise.all(ETAPAS_ANTES_DO_GALPAO.map((s) => cortesDaEtapa(srv, s))),
    cortesDaEtapa(srv, 'no_galpao'),
  ]);

  const candidatos = galpao.filter((c) => querido(c) && emIso(c.inicio) >= INICIO_DO_CONTROLE);
  const prontas: CorteAberto[] = [];

  // Em lotes: o Corte Pro devolve um corte por chamada e o boletim não pode
  // ficar minutos esperando.
  for (let i = 0; i < candidatos.length; i += 5) {
    const lote = candidatos.slice(i, i + 5);
    const subiu = await Promise.all(lote.map((c) => jaSubiuNoSite(srv, c.codigo)));
    lote.forEach((c, j) => {
      // Na dúvida o corte fica de fora: contar peça que já está na Shopify
      // infla a cobertura, e cobertura inflada é justamente o que esconde a
      // ruptura que este bloco existe para antecipar.
      if (subiu[j] === false) prontas.push(c);
    });
  }

  return [...antesDoGalpao.flat().filter(querido), ...prontas];
}
