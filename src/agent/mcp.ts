import { config } from '../config.js';

/**
 * MCPs que o agente enxerga.
 *
 * A restrição que molda este arquivo: o Claude Agent SDK **não abre navegador e
 * não completa fluxo de OAuth**. Um processo rodando sozinho às 3h da manhã não
 * tem quem clique em "autorizar". Por isso todo servidor aqui autentica por
 * token de servidor — bearer, service account ou variável de ambiente.
 *
 * AtendePro e Corte Pro são MCPs da própria L&F e entram como estão, por HTTP
 * com bearer. Shopify, Meta e Google Ads entram por wrappers locais (stdio) que
 * devolvem agregados em vez de payload cru — não é preciosismo: o retorno cru de
 * carrinhos abandonados do AtendePro tem 98 mil caracteres, mais tokens do que o
 * resumo inteiro consome, para uma informação que cabe em três linhas.
 */
export function mcpServers() {
  const c = config();
  const servers: Record<string, unknown> = {};

  if (c.ATENDEPRO_MCP_URL) {
    servers.atendepro = {
      type: 'http',
      url: c.ATENDEPRO_MCP_URL,
      headers: c.ATENDEPRO_TOKEN ? { Authorization: `Bearer ${c.ATENDEPRO_TOKEN}` } : {},
    };
  }

  if (c.CORTEPRO_MCP_URL) {
    servers.cortepro = {
      type: 'http',
      url: c.CORTEPRO_MCP_URL,
      headers: c.CORTEPRO_TOKEN ? { Authorization: `Bearer ${c.CORTEPRO_TOKEN}` } : {},
    };
  }

  // Wrapper local: expõe vendas, tráfego e top de produtos já agregados.
  servers.loja = {
    command: 'node',
    args: ['dist/mcp/loja-server.js'],
  };

  return servers;
}

/**
 * Fase 1 é leitura pura.
 *
 * Nenhuma ferramenta de escrita entra nesta lista. Quando fizer sentido soltar
 * ações — pausar campanha, criar cupom, ajustar estoque — o desenho é: o agente
 * propõe, pede confirmação no chat, executa depois do "sim" e registra em log.
 * Até lá, um agente sem permissão de escrita não tem como errar caro.
 */
export const allowedTools = [
  'mcp__atendepro__*',
  'mcp__cortepro__*',
  'mcp__loja__*',
];
