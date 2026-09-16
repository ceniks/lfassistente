import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/**
 * Cliente MCP para os servidores próprios da L&F (AtendePro e Corte Pro).
 *
 * Por que chamar direto em vez de deixar o agente chamar: o resumo das 8h
 * precisa ser determinístico. Se os números de produção e atendimento viessem
 * de uma consulta feita pelo modelo, dois dias iguais poderiam render mensagens
 * diferentes. O agente continua tendo acesso aos mesmos MCPs para conversar —
 * são caminhos paralelos, de propósito.
 */

const conexoes = new Map<string, Client>();

/**
 * Teto de espera. Sem isto uma conexão pendurada trava quem chamou para
 * sempre: o boletim das 8h ficou sem sair porque uma chamada ao Corte Pro
 * nunca voltou nem falhou. Erro dá para tratar; silêncio não.
 */
const LIMITE_CONEXAO = 20_000;
const LIMITE_CHAMADA = 60_000;

async function comPrazo<T>(promessa: Promise<T>, ms: number, oque: string): Promise<T> {
  let alarme: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promessa,
      new Promise<never>((_, rejeitar) => {
        alarme = setTimeout(() => rejeitar(new Error(`${oque}: sem resposta em ${ms / 1000}s`)), ms);
      }),
    ]);
  } finally {
    if (alarme) clearTimeout(alarme);
  }
}

async function conectar(nome: string, url: string, token?: string): Promise<Client> {
  const existente = conexoes.get(nome);
  if (existente) return existente;

  const client = new Client({ name: 'lf-assistant', version: '0.1.0' }, { capabilities: {} });

  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  });

  await comPrazo(client.connect(transport), LIMITE_CONEXAO, `${nome}: conexão`);
  conexoes.set(nome, client);
  return client;
}

/**
 * Chama uma ferramenta e devolve o conteúdo de texto concatenado.
 *
 * Os dois servidores respondem de formas diferentes — o AtendePro devolve JSON
 * dentro do bloco de texto, o Corte Pro devolve texto já formatado para humano.
 * Quem chama decide o que fazer com a string.
 */
export async function chamarFerramenta(
  servidor: { nome: string; url: string; token?: string },
  ferramenta: string,
  argumentos: Record<string, unknown> = {},
): Promise<string> {
  const client = await conectar(servidor.nome, servidor.url, servidor.token);

  let resultado;
  try {
    resultado = await comPrazo(
      client.callTool({ name: ferramenta, arguments: argumentos }),
      LIMITE_CHAMADA,
      `${servidor.nome}.${ferramenta}`,
    );
  } catch (e) {
    // Conexão guardada que deu errado provavelmente está morta: a próxima
    // chamada reconecta em vez de bater na mesma parede.
    conexoes.delete(servidor.nome);
    await client.close().catch(() => undefined);
    throw e;
  }

  const blocos = (resultado.content ?? []) as Array<{ type: string; text?: string }>;
  return blocos
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text)
    .join('\n');
}

/** Igual ao acima, mas já faz o parse do JSON. Usado com o AtendePro. */
export async function chamarJson<T>(
  servidor: { nome: string; url: string; token?: string },
  ferramenta: string,
  argumentos: Record<string, unknown> = {},
): Promise<T> {
  const texto = await chamarFerramenta(servidor, ferramenta, argumentos);
  try {
    return JSON.parse(texto) as T;
  } catch {
    throw new Error(`${servidor.nome}.${ferramenta} não devolveu JSON: ${texto.slice(0, 200)}`);
  }
}

export async function fecharConexoes(): Promise<void> {
  for (const [nome, client] of conexoes) {
    try {
      await client.close();
    } catch {
      // Fechar conexão na saída é cortesia, não requisito.
    }
    conexoes.delete(nome);
  }
}
