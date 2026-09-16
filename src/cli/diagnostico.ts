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

/**
 * Traduz o erro para o que fazer a respeito.
 *
 * `unauthorized` é o caso comum e o mais confuso: a URL está certa, a chave foi
 * lida, e mesmo assim não passa. Quase sempre é secret criado no projeto errado
 * — cada projeto Supabase tem o seu, e ter dois sistemas não significa ter os
 * secrets nos dois.
 */
function explicar(erro: unknown, projeto: string): string[] {
  const msg = erro instanceof Error ? erro.message : String(erro);
  const linhas = [falha(msg)];

  if (/unauthorized|401|403/i.test(msg)) {
    linhas.push(
      '',
      '    A URL respondeu, então o servidor existe — a chave é que não foi aceita.',
      '    Confira, nessa ordem:',
      `      1. a Edge Function do projeto ${projeto} recebeu a verificação de API key?`,
      `      2. o secret MCP_SERVER_KEY existe NESSE projeto? (cada projeto tem o seu)`,
      '      3. o valor bate exatamente com o do .env, sem espaço no fim?',
    );
  } else if (/fetch failed|ENOTFOUND|ECONNREFUSED/i.test(msg)) {
    linhas.push('', '    A URL não respondeu. Confira se o caminho da função está correto.');
  } else if (/not found|404/i.test(msg)) {
    linhas.push('', '    O caminho existe mas a função não. Confira o nome no fim da URL.');
  }

  return linhas;
}

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
    console.log(explicar(e, 'do Corte Pro').join('\n'));
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
      `\n  carrinhos de ${dia}: ${a?.carrinhos?.noAtendimento.total ?? 0} no atendimento, ` +
        `${a?.carrinhos?.noAtendimento.disparados ?? 0} disparados, ` +
        `${a?.carrinhos?.noAtendimento.naoChegaram ?? 0} não chegaram, ` +
        `${a?.carrinhos?.semCarrinho.length ?? 0} fora da régua`,
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
    console.log(explicar(e, 'do AtendePro').join('\n'));
  }
}

await testarCortePro();
await testarAtendePro();
await fecharConexoes();

console.log('\n');
