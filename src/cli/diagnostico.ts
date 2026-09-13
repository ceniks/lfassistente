/**
 * Testa a conexão com os MCPs próprios e mostra o que cada um respondeu.
 *
 *   npm run diagnostico
 *
 * Serve para responder três perguntas antes de confiar no resumo das 8h:
 * a chave funciona, as ferramentas esperadas existem, e o parse acertou os
 * números. O terceiro é o que mais importa — o `resumo_producao` do Corte Pro
 * devolve texto formatado para humano, e um parse silenciosamente errado
 * produziria um resumo bonito e falso.
 *
 * Nenhum segredo é impresso: a saída mostra só o tamanho da chave configurada.
 */
import { config } from '../config.js';
import { chamarFerramenta, fecharConexoes } from '../data/mcp-client.js';
import { producaoAtual } from '../data/producao.js';
import { atendimentoAtual, campanhasRfm } from '../data/atendimento.js';
import { ontem } from '../digest/build.js';

const c = config();
const dia = process.argv[2] ?? ontem();

const ok = (s: string) => `  ✓ ${s}`;
const falha = (s: string) => `  ✗ ${s}`;

function cabecalho(titulo: string) {
  console.log(`\n${'─'.repeat(60)}\n${titulo}\n${'─'.repeat(60)}`);
}

/** Nunca imprime o valor — só confirma que existe e quantos caracteres tem. */
function conferirEnv(nomeUrl: string, url?: string, nomeToken?: string, token?: string) {
  if (!url) {
    console.log(falha(`${nomeUrl} não está configurada`));
    return false;
  }
  console.log(ok(`${nomeUrl} = ${url}`));
  if (nomeToken) {
    console.log(
      token
        ? ok(`${nomeToken} configurada (${token.length} caracteres)`)
        : falha(`${nomeToken} vazia`),
    );
  }
  return true;
}

async function testarCortePro() {
  cabecalho('CORTE PRO');

  if (!conferirEnv('CORTEPRO_MCP_URL', c.CORTEPRO_MCP_URL, 'CORTEPRO_TOKEN', c.CORTEPRO_TOKEN)) {
    return;
  }

  try {
    const bruto = await chamarFerramenta(
      { nome: 'cortepro', url: c.CORTEPRO_MCP_URL!, token: c.CORTEPRO_TOKEN },
      'resumo_producao',
    );
    console.log(ok('conexão e chamada funcionaram'));
    console.log('\n  --- texto cru devolvido ---');
    console.log(
      bruto
        .split('\n')
        .map((l) => `  │ ${l}`)
        .join('\n'),
    );

    const p = await producaoAtual();
    console.log('\n  --- como o parse leu ---');
    console.log(`  na oficina: ${p?.naOficina} cortes, ${p?.pecasNaOficina} peças`);
    console.log(`  no galpão: ${p?.noGalpao} cortes`);
    console.log(`  atrasados: ${p?.atrasados}`);
    console.log(`  mais crítico: ${p?.maisCritico ?? '—'}`);
    console.log(`  dias de atraso: ${p?.diasDeAtrasoDoMaisCritico ?? '—'}`);

    if (!p?.naOficina && !p?.atrasados) {
      console.log(
        falha('todos os números vieram zerados — o formato do texto provavelmente mudou'),
      );
    }
  } catch (e) {
    console.log(falha(e instanceof Error ? e.message : String(e)));
  }
}

async function testarAtendePro() {
  cabecalho('ATENDEPRO');

  if (
    !conferirEnv('ATENDEPRO_MCP_URL', c.ATENDEPRO_MCP_URL, 'ATENDEPRO_TOKEN', c.ATENDEPRO_TOKEN)
  ) {
    return;
  }

  try {
    const a = await atendimentoAtual(dia);
    console.log(ok('conexão e chamada funcionaram'));
    console.log(`\n  fila: ${a?.aguardando} aguardando`);
    for (const x of a?.porAtendente ?? []) console.log(`    ${x.nome}: ${x.total}`);
    console.log(`    sem atendente: ${a?.semAtendente}`);
    console.log(`  por canal: ${a?.porCanal.map((x) => `${x.canal} ${x.total}`).join(' · ')}`);
    console.log(
      `\n  carrinhos de ${dia}: ${a?.carrinhosGerados} gerados, ` +
        `${a?.carrinhosEnviados} enviados, ${a?.carrinhosComErro} com erro, ` +
        `${a?.carrinhosRespondidos} respondidos`,
    );
    console.log(`  NPS 7d: ${a?.npsSeteDias ?? '—'} (${a?.npsRespostas} respostas)`);

    const rfm = await campanhasRfm();
    if (rfm.length) {
      const enviadas = rfm.reduce((s, x) => s + x.enviadas, 0);
      const compras = rfm.reduce((s, x) => s + x.compras, 0);
      console.log(`\n  RFM: ${rfm.length} campanhas, ${enviadas} mensagens, ${compras} compras`);
      if (compras === 0 && enviadas > 0) {
        console.log(
          falha('nenhuma compra atribuída em nenhuma campanha — atribuição pode estar desligada'),
        );
      }
    }
  } catch (e) {
    console.log(falha(e instanceof Error ? e.message : String(e)));
  }
}

await testarCortePro();
await testarAtendePro();
await fecharConexoes();

console.log('\n');
