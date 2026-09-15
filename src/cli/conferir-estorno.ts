/**
 * Confere reembolso a reembolso, Shopify contra Troquecommerce.
 *
 *   npm run conferir-estorno                     # ontem
 *   npm run conferir-estorno 2026-09-14
 *   npm run conferir-estorno 2026-09-01 2026-09-14
 *
 * A lógica vive em `src/data/conciliacao.ts`, junto com o porquê de cada regra.
 * Aqui só imprime.
 */
import { conferirEstorno } from '../data/conciliacao.js';
import { temTroque } from '../data/troque.js';
import { ontem } from '../digest/build.js';
// Centavos importam numa conferência financeira: sem eles uma diferença de
// R$ 0,40 apareceria como "R$ 0" na coluna de divergência.
import { dinheiroExato as dinheiro } from '../digest/format.js';
import { fecharConexoes } from '../data/mcp-client.js';

const args = process.argv.slice(2).filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const de = args[0] ?? ontem();
const ate = args[1] ?? de;

if (!temTroque()) {
  console.error('\nFalta TROQUE_TOKEN no .env.\n');
  process.exit(1);
}

const c = await conferirEstorno(de, ate);

console.log(`\nConferência de estorno · ${de === ate ? de : `${de} a ${ate}`}\n`);
console.log(`Shopify no período:        ${c.shopify.quantidade} reembolso(s) · ${dinheiro(c.shopify.valor)}`);
console.log(
  `Troquecommerce no período: ${c.troque.quantidade} reversa(s) finalizada(s) com estorno · ${dinheiro(c.troque.valor)}`,
);
if (c.aguardandoPagamento.quantidade) {
  console.log(
    `Aguardando pagamento:      ${c.aguardandoPagamento.quantidade} reversa(s) · ` +
      `${dinheiro(c.aguardandoPagamento.valor)} aprovados e não pagos (fila, não divergência)`,
  );
}

if (c.soShopify.length) {
  console.log(`\n⚠️  SÓ NA SHOPIFY — ${c.soShopify.length} pedido(s): dinheiro saiu sem reversa finalizada`);
  for (const x of c.soShopify) {
    console.log(`  ${x.pedido.padEnd(9)} ${dinheiro(x.valor).padStart(13)}  ${x.situacao}`);
  }
}
if (c.soTroque.length) {
  console.log(`\n⚠️  SÓ NO TROQUECOMMERCE — ${c.soTroque.length} pedido(s): estorno finalizado sem saída na Shopify`);
  for (const x of c.soTroque) {
    console.log(`  ${x.pedido.padEnd(9)} ${dinheiro(x.valor).padStart(13)}  ${x.situacao}`);
  }
}
if (c.valorDiferente.length) {
  console.log(`\n⚠️  VALOR DIFERENTE — ${c.valorDiferente.length} pedido(s)`);
  for (const x of c.valorDiferente) {
    console.log(
      `  ${x.pedido.padEnd(9)} Shopify ${dinheiro(x.shopify).padStart(13)} · Troque ${dinheiro(x.troque).padStart(13)} · ` +
        `diferença ${dinheiro(x.diferenca).padStart(12)}  (reversa de ${x.reversaEm})`,
    );
  }
}
if (!c.soShopify.length && !c.soTroque.length && !c.valorDiferente.length) {
  console.log('\n✓ Nenhuma divergência no período.');
}
console.log(`\n✓ Batem: ${c.batem} pedido(s)\n`);

await fecharConexoes();
process.exit(0);
