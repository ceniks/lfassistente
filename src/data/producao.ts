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

/** Um corte aberto na produção, para cruzar com a cobertura de estoque. */
export interface CorteAberto {
  codigo: string;
  produto: string;
  pecas: number;
  status: string;
  inicio: string;
}

/**
 * Os cortes que ainda vão virar peça no estoque.
 *
 * Serve a uma pergunta só: quando o relatório disser que um campeão de venda
 * tem quatro dias de cobertura, existe reposição vindo? Sem isso a linha de
 * estoque assusta sem informar.
 *
 * Só etapas que ainda não entraram no estoque. "No galpão" fica de fora porque
 * já foi contado pela Shopify — somar as duas coisas contaria a mesma peça
 * duas vezes e daria falsa sensação de folga.
 */
const ETAPAS_QUE_AINDA_VIRAM_ESTOQUE = ['em_corte', 'na_oficina', 'caseado'] as const;

export async function cortesAbertos(): Promise<CorteAberto[]> {
  const srv = servidor();
  if (!srv) return [];

  const saida: CorteAberto[] = [];

  for (const status of ETAPAS_QUE_AINDA_VIRAM_ESTOQUE) {
    let texto: string;
    try {
      texto = await chamarFerramenta(srv, 'listar_cortes', { status, limite: 200 });
    } catch {
      continue;
    }

    // "• 506 — Blazer filadelfia ref:97 (Blazer) | Na oficina | 1335 pç | resp. João | início 04/09/2026"
    const linhas = texto.matchAll(
      /•\s*(\d+)\s*—\s*(.+?)\s*\|\s*([^|]+?)\s*\|\s*(\d+)\s*pç.*?início\s*(\d{2}\/\d{2}\/\d{4})/g,
    );
    for (const m of linhas) {
      saida.push({
        codigo: m[1],
        produto: m[2].trim(),
        status: m[3].trim(),
        pecas: Number(m[4]),
        inicio: m[5],
      });
    }
  }

  return saida;
}
