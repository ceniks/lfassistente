/**
 * Confere a conexão com a Troquecommerce e mostra o que ela responde.
 *
 *   npm run troque-teste                # ontem
 *   npm run troque-teste 2026-09-13
 *   npm run troque-teste 2026-09-13 legada
 *
 * O que este script existe para descobrir, antes de confiar no bloco das 8h:
 *
 *  - o token é da loja certa? Duas lojas com o mesmo formato de token, e usar a
 *    legada devolve zeros perfeitamente convincentes para qualquer dia atual.
 *  - quais valores `reverse_type` e `status` a API realmente usa? O swagger não
 *    documenta o enum de `reverse_type`, então a classificação troca/estorno é
 *    heurística até vermos os valores reais. Aqui eles aparecem crus.
 *  - o campo `reason` vem preenchido? É o motivo da troca, a razão de toda a
 *    integração. Se vier vazio, o bloco perde a linha mais importante.
 */
import {
  listar,
  detalhe,
  tipo,
  temTroque,
  reversasDoDia,
  type Loja,
  type Reversa,
} from '../data/troque.js';
import { ontem } from '../digest/build.js';
import { dinheiro, numero } from '../digest/format.js';

const dia = process.argv[2] ?? ontem();
const loja = (process.argv[3] as Loja) ?? 'atual';

if (!temTroque(loja)) {
  console.error(
    `\nFalta o token da loja "${loja}" no .env ` +
      `(${loja === 'atual' ? 'TROQUE_TOKEN' : 'TROQUE_TOKEN_LEGADO'}).\n` +
      'Pegue em Painel > Automações > API, com a loja certa selecionada no topo.\n',
  );
  process.exit(1);
}

console.log(`\nLoja: ${loja} · dia de referência: ${dia}\n`);

/* --- 1. A API responde? E com quais valores? --- */

let recentes: Reversa[];
try {
  const de = new Date(`${dia}T12:00:00-03:00`);
  de.setDate(de.getDate() - 30);
  recentes = await listar({ criadaDe: de.toISOString().slice(0, 10), criadaAte: dia }, loja);
} catch (e) {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}

console.log(`✓ conexão ok — ${recentes.length} reversas criadas nos 30 dias até ${dia}`);

if (!recentes.length) {
  console.log(
    '\n⚠️  Nenhuma reversa no período. Se a loja opera normalmente, o token provavelmente\n' +
      '   é da outra loja. Troque a seleção no topo do painel e pegue o token de lá.\n',
  );
  process.exit(0);
}

const conta = (f: (r: Reversa) => string) => {
  const m = new Map<string, number>();
  for (const r of recentes) m.set(f(r), (m.get(f(r)) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
};

console.log('\n--- status (valores crus da API) ---');
for (const [k, v] of conta((r) => r.status)) console.log(`  ${String(v).padStart(4)}  ${k}`);

console.log('\n--- reverse_type (valores crus) ---');
for (const [k, v] of conta((r) => r.reverse_type ?? '(vazio)')) console.log(`  ${String(v).padStart(4)}  ${k}`);

console.log('\n--- como o código classificou ---');
for (const [k, v] of conta((r) => tipo(r))) console.log(`  ${String(v).padStart(4)}  ${k}`);
const desconhecidos = recentes.filter((r) => tipo(r) === 'desconhecido');
if (desconhecidos.length) {
  console.log(
    `\n  ⚠️  ${desconhecidos.length} reversas não classificadas. Valores de reverse_type vistos: ` +
      [...new Set(desconhecidos.map((r) => r.reverse_type ?? '(vazio)'))].join(', '),
  );
}

/* --- 2. O detalhe traz motivo e o par devolveu/levou? --- */

console.log('\n--- detalhe de até 3 reversas ---');
for (const r of recentes.slice(0, 3)) {
  try {
    const d = await detalhe(r.id, loja);
    console.log(
      `\n  pedido ${d.ecommerce_number ?? '—'} · ${d.status} · ${d.reverse_type ?? '—'}` +
        ` · criada ${d.created_at.slice(0, 10)}`,
    );
    console.log(
      `    troca ${dinheiro(d.exchange_value ?? 0)} · estorno ${dinheiro(d.refund_value ?? 0)}` +
        ` · retido ${dinheiro(d.retained_value ?? 0)}${d.retention_level ? ` (${d.retention_level})` : ''}`,
    );
    for (const item of d.items ?? []) {
      console.log(
        `    ${item.quantity ?? 1}x ${item.description ?? item.sku}` +
          `${item.reason?.description ? ` — motivo: ${item.reason.description}` : ' — SEM MOTIVO'}` +
          `${item.reason?.client_comment ? `\n        cliente: "${item.reason.client_comment.trim()}"` : ''}` +
          `${item.replaced_item_description ? `\n        trocou por: ${item.replaced_item_description}` : ''}`,
      );
    }
  } catch (e) {
    console.log(`  ✗ detalhe falhou: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const semMotivo = recentes.length;
console.log(
  `\n  (se "SEM MOTIVO" aparecer em todos, o campo reason não está sendo preenchido` +
    ` — confira se a central de trocas pede o motivo à cliente)`,
);
void semMotivo;

/* --- 3. O bloco como sairia no boletim --- */

console.log('\n--- agregado do dia, como iria para o resumo ---');
try {
  const a = await reversasDoDia(dia, loja);
  console.log(`  abertas: ${a.abertas} (${a.aberturasPorTipo.troca} troca · ${a.aberturasPorTipo.estorno} estorno)`);
  console.log(`  concluídas: ${a.concluidas} · canceladas: ${a.canceladas}`);
  console.log(
    `  valores: troca ${dinheiro(a.valorTroca)} · estorno ${dinheiro(a.valorEstorno)} · retido ${dinheiro(a.valorRetido)}`,
  );
  console.log(`  em aberto: ${a.emAberto} · travadas há +7 dias: ${a.travadas}`);
  if (a.motivos.length) {
    console.log('  motivos das concluídas:');
    for (const m of a.motivos) console.log(`    ${numero(m.total)}x ${m.motivo}`);
  }
  for (const p of a.pares.slice(0, 5)) {
    console.log(`  devolveu ${p.devolveu} → levou ${p.levou}${p.motivo ? ` (${p.motivo})` : ''}`);
  }
} catch (e) {
  console.error(`  ✗ ${e instanceof Error ? e.message : String(e)}`);
}

console.log('\n');
process.exit(0);
