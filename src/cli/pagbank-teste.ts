/**
 * Descobre QUAL API do PagBank o token que temos abre, antes de escrever
 * qualquer integração em cima dele.
 *
 *   npm run pagbank-teste                # ontem
 *   npm run pagbank-teste 2026-09-16
 *
 * Existem duas APIs vivas e elas não servem para a mesma coisa:
 *
 *  - a nova (api.pagseguro.com, token Bearer) é boa para consultar UM pedido
 *    que você já sabe o id, e ruim para listar: `GET /orders` costuma exigir
 *    `reference_id`. Sem listagem por data não há conferência contra a Shopify.
 *  - a antiga (ws.pagseguro.uol.com.br/v3, e-mail + token) lista por intervalo
 *    de datas e é a única que devolve `feeAmount` e `netAmount` — bruto, taxa e
 *    líquido por transação. É ela que fecha caixa e confere os 6,10%.
 *
 * Por isso o script não assume: bate nas duas e conta o que cada uma respondeu.
 * Nada aqui grava nada — é só leitura.
 */
const token = process.env.PAGBANK_TOKEN?.trim();
const email = process.env.PAGBANK_EMAIL?.trim();

if (!token) {
  console.error(
    '\nFalta PAGBANK_TOKEN no .env.\n' +
      'PagBank > Minha conta > Vender > Integrações > Token.\n',
  );
  process.exit(1);
}

const dia = process.argv[2] ?? new Date(Date.now() - 864e5).toISOString().slice(0, 10);
const inicio = `${dia}T00:00:00-03:00`;
const fim = `${dia}T23:59:59-03:00`;

const oculto = `${token.slice(0, 4)}…${token.slice(-4)} (${token.length} caracteres)`;
console.log(`\nToken: ${oculto}`);
console.log(`E-mail: ${email ?? '(vazio — só a API nova pode funcionar)'}`);
console.log(`Dia de referência: ${dia}\n`);

async function tentar(nome: string, url: string, init: RequestInit) {
  process.stdout.write(`· ${nome} … `);
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
    const corpo = await r.text();
    if (!r.ok) {
      console.log(`✗ HTTP ${r.status}`);
      console.log(`  ${corpo.slice(0, 400).replace(/\n/g, '\n  ')}\n`);
      return null;
    }
    console.log(`✓ HTTP ${r.status} · ${corpo.length} bytes`);
    return corpo;
  } catch (e) {
    console.log(`✗ ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/* --- 1. API antiga: a única que lista por data e devolve taxa e líquido --- */

let antigaOk = false;
if (email) {
  const q = new URLSearchParams({
    email,
    token,
    initialDate: inicio,
    finalDate: fim,
    page: '1',
    maxPageResults: '10',
  });
  const corpo = await tentar(
    'antiga  v3/transactions (lista por data)',
    `https://ws.pagseguro.uol.com.br/v3/transactions?${q}`,
    { headers: { Accept: 'application/json;charset=ISO-8859-1' } },
  );
  if (corpo) {
    antigaOk = true;
    // A v3 responde XML por padrão e JSON quando o Accept pede. Aceitamos os dois.
    if (corpo.trimStart().startsWith('{')) {
      const j = JSON.parse(corpo) as {
        totalPages?: number;
        resultsInThisPage?: number;
        transactions?: unknown;
      };
      const lista = Array.isArray(j.transactions)
        ? j.transactions
        : j.transactions
          ? [j.transactions]
          : [];
      console.log(
        `  ${j.resultsInThisPage ?? lista.length} transação(ões) nesta página, ` +
          `${j.totalPages ?? '?'} página(s) no dia`,
      );
      const t = lista[0] as Record<string, unknown> | undefined;
      if (t) {
        console.log('  Primeira transação, campos crus que interessam:');
        for (const campo of [
          'reference',
          'code',
          'date',
          'grossAmount',
          'discountAmount',
          'feeAmount',
          'netAmount',
          'installmentCount',
          'paymentMethod',
          'status',
        ]) {
          if (campo in t) console.log(`    ${campo}: ${JSON.stringify(t[campo])}`);
        }
        console.log(
          '\n  `reference` é o que amarra na Shopify: precisa conter o número do pedido.\n' +
            '  Se vier vazio, a conferência tem que ser por valor e horário, que é pior.',
        );
      }
    } else {
      console.log('  Respondeu XML. Trecho:');
      console.log(`  ${corpo.slice(0, 600).replace(/\n/g, '\n  ')}`);
    }
  }
} else {
  console.log('· antiga  v3/transactions — pulada, falta PAGBANK_EMAIL\n');
}

/* --- 2. API nova: valida o token e mostra se dá para listar --- */

const bearer = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

await tentar('nova    /public-keys (só valida o token)', 'https://api.pagseguro.com/public-keys', {
  method: 'POST',
  headers: { ...bearer, 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'card' }),
});

await tentar(
  'nova    /orders (tenta listar por data)',
  `https://api.pagseguro.com/orders?created_at_start=${encodeURIComponent(inicio)}` +
    `&created_at_end=${encodeURIComponent(fim)}&size=5`,
  { headers: bearer },
);

/* --- 3. Veredito --- */

console.log('\n─────');
if (antigaOk) {
  console.log(
    'A API antiga abriu. É a que serve: lista por data e traz taxa e líquido,\n' +
      'então dá para conferir pedido a pedido contra a Shopify e fechar caixa.',
  );
} else {
  console.log(
    'A API antiga não abriu. Sem ela não há listagem por data, e a conferência\n' +
      'contra a Shopify fica inviável — a API nova só responde por pedido, um a um.\n' +
      'O token antigo fica em PagBank > Preferências > Integrações > Token de segurança,\n' +
      'e vem junto do e-mail da conta. É outro token, não o mesmo.',
  );
}
console.log(
  'Lembrete: qualquer número daqui cobre só o PagBank. O Mercado Pago responde\n' +
    'pela outra fatia das vendas e precisaria de credencial própria.\n',
);
