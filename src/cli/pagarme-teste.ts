/**
 * Descobre qual API da Pagar.me a chave abre, antes de escrever integração.
 *
 *   npm run pagarme-teste            # ontem
 *   npm run pagarme-teste 2026-09-16
 *
 * Mesma lição do PagBank: existem duas gerações vivas, com autenticação
 * diferente, e a documentação não diz qual conta usa qual.
 *
 *  - v5 (api.pagar.me/core/v5): chave `sk_...`, Basic com a chave no usuário e
 *    senha vazia. Lista pedidos por `created_since`/`created_until`.
 *  - v1 legada (api.pagar.me/1): `api_key` na query. Lista transações por data.
 *
 * O script bate nas duas e conta o que respondeu. Só leitura.
 */
const chave = process.env.PAGARME_TOKEN?.trim();

if (!chave) {
  console.error(
    "\nFalta PAGARME_TOKEN no .env.\n" +
      "Painel da Pagar.me > Configurações > Chaves de API. A SECRETA (sk_...).\n",
  );
  process.exit(1);
}

const dia =
  process.argv[2] ?? new Date(Date.now() - 864e5).toISOString().slice(0, 10);
console.log(
  `\nChave: ${chave.slice(0, 7)}…${chave.slice(-4)} (${chave.length} caracteres)` +
    `\nDia de referência: ${dia}\n`,
);

async function tentar(nome: string, url: string, init: RequestInit = {}) {
  process.stdout.write(`· ${nome} … `);
  try {
    const r = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(30_000),
    });
    const corpo = await r.text();
    if (!r.ok) {
      console.log(`✗ HTTP ${r.status}`);
      if (corpo.trim())
        console.log(`  ${corpo.slice(0, 250).replace(/\s+/g, " ")}`);
      return null;
    }
    console.log(`✓ HTTP ${r.status} · ${corpo.length} bytes`);
    return corpo;
  } catch (e) {
    console.log(`✗ ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/* --- v5 --- */

const basic = Buffer.from(`${chave}:`).toString("base64");
const v5 = await tentar(
  "v5  /core/v5/orders (lista por data)",
  "https://api.pagar.me/core/v5/orders" +
    `?created_since=${encodeURIComponent(`${dia}T00:00:00-03:00`)}` +
    `&created_until=${encodeURIComponent(`${dia}T23:59:59-03:00`)}&size=5`,
  { headers: { Authorization: `Basic ${basic}`, Accept: "application/json" } },
);

if (v5) {
  const j = JSON.parse(v5) as {
    data?: Array<Record<string, unknown>>;
    paging?: unknown;
  };
  console.log(`  ${j.data?.length ?? 0} pedido(s) nesta página`);
  const p = j.data?.[0];
  if (p) {
    console.log(
      "  Primeiro pedido, campos que interessam para casar com a Shopify:",
    );
    for (const campo of [
      "id",
      "code",
      "amount",
      "status",
      "created_at",
      "customer",
      "charges",
    ]) {
      const v = p[campo];
      const curto =
        campo === "customer"
          ? JSON.stringify({
              name: (v as { name?: string })?.name,
              email: (v as { email?: string })?.email,
            })
          : campo === "charges"
            ? `${(v as unknown[])?.length ?? 0} cobrança(s)`
            : JSON.stringify(v);
      console.log(`    ${campo}: ${String(curto).slice(0, 160)}`);
    }
  }
}

/* --- v1 legada --- */

const v1 = await tentar(
  "v1  /1/transactions (lista por data)",
  `https://api.pagar.me/1/transactions?api_key=${encodeURIComponent(chave)}&count=5`,
);
if (v1) {
  const j = JSON.parse(v1) as Array<Record<string, unknown>>;
  console.log(`  ${j.length} transação(ões)`);
  const t = j[0];
  if (t) {
    for (const campo of [
      "id",
      "amount",
      "cost",
      "status",
      "date_created",
      "installments",
    ]) {
      if (campo in t) console.log(`    ${campo}: ${JSON.stringify(t[campo])}`);
    }
  }
}

console.log("\n─────");
if (v5 || v1) {
  console.log(
    `A ${v5 ? "v5" : "v1"} abriu. É por ela que a conferência dos pedidos pagos à mão vai sair.\n` +
      "Lembrete: o pedido manual da Shopify não tem identificador de pagamento, então a\n" +
      "amarração é por valor, cliente e janela de data — não por id, como no PagBank.",
  );
} else {
  console.log(
    "Nenhuma das duas abriu. Confira se a chave é a SECRETA (sk_...), não a pública.",
  );
}
