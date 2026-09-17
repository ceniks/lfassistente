/**
 * Descobre o que o token do Mercado Pago abre, e — mais importante — se existe
 * um campo que amarre o pagamento ao pedido da Shopify.
 *
 *   npm run mercadopago-teste            # ontem
 *   npm run mercadopago-teste 2026-09-16
 *
 * A pergunta que decide o desenho da conferência é essa última. No PagBank a
 * amarra é exata, porque a Shopify grava o mesmo identificador dos dois lados.
 * Na Pagar.me não há amarra e sobra casar por valor e e-mail, que é mais fraco.
 * Aqui não sabemos ainda: `external_reference` e `metadata` são os candidatos,
 * e é isso que este script imprime cru.
 *
 * Só leitura.
 */
const token = process.env.MERCADOPAGO_TOKEN?.trim();

if (!token) {
  console.error(
    "\nFalta MERCADOPAGO_TOKEN no .env.\n" +
      "Mercado Pago > Credenciais > Credenciais de produção > Access Token (APP_USR-…).\n",
  );
  process.exit(1);
}

const dia =
  process.argv[2] ?? new Date(Date.now() - 864e5).toISOString().slice(0, 10);
console.log(
  `\nToken: ${token.slice(0, 8)}…${token.slice(-4)} (${token.length} caracteres)` +
    `\nDia de referência: ${dia}\n`,
);

const url =
  "https://api.mercadopago.com/v1/payments/search" +
  `?begin_date=${encodeURIComponent(`${dia}T00:00:00.000-03:00`)}` +
  `&end_date=${encodeURIComponent(`${dia}T23:59:59.999-03:00`)}` +
  "&range=date_created&sort=date_created&criteria=desc&limit=5";

process.stdout.write("· /v1/payments/search (lista por data) … ");
const r = await fetch(url, {
  headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  signal: AbortSignal.timeout(30_000),
});
const corpo = await r.text();

if (!r.ok) {
  console.log(`✗ HTTP ${r.status}`);
  console.log(`  ${corpo.slice(0, 300).replace(/\s+/g, " ")}\n`);
  console.log(
    "Confira se é o Access Token de PRODUÇÃO, não o de teste nem a public key.",
  );
  process.exit(1);
}

const j = JSON.parse(corpo) as {
  paging?: { total?: number };
  results?: Array<Record<string, any>>;
};
console.log(`✓ HTTP 200 · ${j.paging?.total ?? "?"} pagamento(s) no dia`);

const p = j.results?.[0];
if (!p) {
  console.log(
    "\nNenhum pagamento no período. Se a loja operou, confira a conta do token.",
  );
  process.exit(0);
}

console.log("\nPrimeiro pagamento, campos crus:");
for (const campo of [
  "id",
  "status",
  "status_detail",
  "transaction_amount",
  "date_approved",
  "payment_method_id",
  "payment_type_id",
  "external_reference",
  "description",
  "order",
]) {
  console.log(`  ${campo}: ${JSON.stringify(p[campo])?.slice(0, 160)}`);
}
console.log(`  metadata: ${JSON.stringify(p.metadata)?.slice(0, 300)}`);
console.log(`  fee_details: ${JSON.stringify(p.fee_details)}`);
console.log(
  `  transaction_details.net_received_amount: ${JSON.stringify(
    p.transaction_details?.net_received_amount,
  )}`,
);

console.log(
  "\n─────\n" +
    "O que decide o desenho: se `external_reference` ou `metadata` trouxerem o número\n" +
    "ou o id do pedido da Shopify, a conferência sai exata como a do PagBank. Se vierem\n" +
    "vazios, sobra casar por valor e horário, que erra quando duas clientes pagam o\n" +
    "mesmo valor no mesmo minuto — e isso precisa ser dito no relatório, não escondido.\n" +
    "Se `fee_details` vier preenchido, a taxa do Pix também deixa de ser estimativa.",
);
