/**
 * Descobre o que o token do PagBank que temos realmente abre, antes de
 * escrever qualquer integração em cima dele.
 *
 *   npm run pagbank-teste                # ontem
 *   npm run pagbank-teste 2026-09-16
 *
 * Três coisas que só um teste responde, e que mudam o projeto inteiro:
 *
 *  - o token é de produção ou de sandbox? Os dois têm o mesmo formato e o
 *    painel tem uma chave entre os ambientes. O sandbox responde 200 e devolve
 *    lista vazia para sempre, então uma conferência montada em cima dele diria
 *    "nenhuma divergência" todo dia sem ter olhado venda nenhuma. É o erro mais
 *    caro possível aqui: silencioso e convincente.
 *  - a API nova (api.pagseguro.com) lista por data? Não: em /orders a única
 *    busca aceita é `charge_id`. Ela serve para confirmar uma cobrança que já
 *    sabemos qual é, não para varrer um dia.
 *  - a API antiga (ws.pagseguro.uol.com.br/v3) abre? É outra credencial —
 *    e-mail mais token de segurança — e é a única que lista por intervalo de
 *    data e devolve `feeAmount` e `netAmount`. Sem ela não há conferência
 *    contra a Shopify nem fechamento de caixa.
 *
 * Nada aqui grava nada: só leitura.
 */
const token = process.env.PAGBANK_TOKEN?.trim();
const antigo = process.env.PAGBANK_TOKEN_ANTIGO?.trim();
const email = process.env.PAGBANK_EMAIL?.trim();

if (!token && !antigo) {
  console.error(
    "\nFalta PAGBANK_TOKEN (ou PAGBANK_TOKEN_ANTIGO) no .env.\n" +
      "Novo:   PagBank > Minha conta > Vender > Integrações > Token.\n" +
      "Antigo: PagBank > Preferências > Integrações > Token de segurança.\n",
  );
  process.exit(1);
}

const mascarar = (t: string) =>
  `${t.slice(0, 4)}…${t.slice(-4)} (${t.length} caracteres)`;

const dia =
  process.argv[2] ?? new Date(Date.now() - 864e5).toISOString().slice(0, 10);
const inicio = `${dia}T00:00:00-03:00`;
const fim = `${dia}T23:59:59-03:00`;

console.log(`\nToken novo:   ${token ? mascarar(token) : "(vazio)"}`);
console.log(`Token antigo: ${antigo ? mascarar(antigo) : "(vazio)"}`);
console.log(
  `E-mail:       ${email ?? "(vazio — a API antiga não abre sem ele)"}`,
);
console.log(`Dia de referência: ${dia}\n`);

async function tentar(
  nome: string,
  url: string,
  init: RequestInit,
): Promise<string | null> {
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
        console.log(`  ${corpo.slice(0, 300).replace(/\s+/g, " ")}`);
      return null;
    }
    console.log(`✓ HTTP ${r.status} · ${corpo.length} bytes`);
    return corpo;
  } catch (e) {
    console.log(`✗ ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/* --- 1. API nova: produção ou sandbox? --- */

let ambiente: "produção" | "sandbox" | "nenhum" = "nenhum";
if (token) {
  const bearer = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  const sonda = "/orders?charge_id=sonda-de-ambiente";
  for (const [nome, base] of [
    ["produção", "https://api.pagseguro.com"],
    ["sandbox", "https://sandbox.api.pagseguro.com"],
  ] as const) {
    const r = await tentar(`nova    ${nome.padEnd(8)}${sonda}`, base + sonda, {
      headers: bearer,
    });
    if (r !== null && ambiente === "nenhum") ambiente = nome;
  }
}

/* --- 2. API antiga: a única que lista por data e traz taxa e líquido --- */

let antigaOk = false;
if (email && antigo) {
  const q = new URLSearchParams({
    email,
    token: antigo,
    initialDate: inicio,
    finalDate: fim,
    page: "1",
    maxPageResults: "10",
  });
  const corpo = await tentar(
    "antiga  v3/transactions (lista por data)",
    `https://ws.pagseguro.uol.com.br/v3/transactions?${q}`,
    {
      headers: {
        Accept: "application/vnd.pagseguro.com.br.v3+json;charset=ISO-8859-1",
      },
    },
  );
  if (corpo) {
    antigaOk = true;
    if (corpo.trimStart().startsWith("{")) {
      const j = JSON.parse(corpo) as Record<string, unknown>;
      const bruto = j.transactions;
      const lista = (
        Array.isArray(bruto) ? bruto : bruto ? [bruto] : []
      ) as Array<Record<string, unknown>>;
      console.log(
        `  ${j.resultsInThisPage ?? lista.length} transação(ões) nesta página, ` +
          `${j.totalPages ?? "?"} página(s) no dia`,
      );
      const t = lista[0];
      if (t) {
        console.log("  Primeira transação, campos crus que interessam:");
        for (const campo of [
          "reference",
          "code",
          "date",
          "grossAmount",
          "discountAmount",
          "feeAmount",
          "netAmount",
          "installmentCount",
          "paymentMethod",
          "status",
        ]) {
          if (campo in t)
            console.log(`    ${campo}: ${JSON.stringify(t[campo])}`);
        }
        console.log(
          "\n  `reference` é o que amarra na Shopify: precisa conter o número do\n" +
            "  pedido. Vazio, sobra bater por valor e horário, que erra quando duas\n" +
            "  clientes pagam o mesmo valor no mesmo minuto.",
        );
      }
    } else {
      console.log("  Respondeu XML. Trecho:");
      console.log(`  ${corpo.slice(0, 600).replace(/\n/g, "\n  ")}`);
    }
  }
} else {
  const falta = [!antigo && "PAGBANK_TOKEN_ANTIGO", !email && "PAGBANK_EMAIL"]
    .filter(Boolean)
    .join(" e ");
  console.log(`· antiga  v3/transactions — pulada, falta ${falta}`);
}

/* --- 3. Veredito --- */

console.log("\n─────");
if (ambiente === "sandbox") {
  console.log(
    "ATENÇÃO: o PAGBANK_TOKEN é de SANDBOX, não de produção.\n" +
      "O sandbox tem banco próprio e vazio: responde 200 e devolve lista vazia\n" +
      "para qualquer consulta. Uma conferência montada em cima dele diria\n" +
      '"nenhuma divergência" todo dia sem ter olhado venda nenhuma.\n' +
      "No painel de integrações existe uma chave Sandbox/Produção — o token de\n" +
      "produção fica do outro lado dela, e tem exatamente o mesmo formato.\n",
  );
} else if (ambiente === "produção") {
  console.log("O PAGBANK_TOKEN é de produção.\n");
} else if (token) {
  console.log("O PAGBANK_TOKEN não abriu nem produção nem sandbox.\n");
}
console.log(
  "A API nova não lista por data: em /orders a única busca aceita é charge_id.\n" +
    "Responde por cobrança, uma a uma — confirma um pedido que já sabemos qual\n" +
    "é, não varre o dia.\n",
);
if (antigaOk) {
  console.log(
    "A API antiga abriu. É a que fecha a conta: lista por data e traz taxa e\n" +
      "líquido, então dá para conferir pedido a pedido contra a Shopify.",
  );
} else {
  console.log(
    "A API antiga não abriu. Sem ela a conferência por dia fica inviável.\n" +
      "O token dela fica em PagBank > Preferências > Integrações > Token de\n" +
      "segurança, e vem junto do e-mail da conta. É outro token, não o mesmo.",
  );
}
console.log(
  "\nLembrete: qualquer número daqui cobre só o PagBank. O Mercado Pago responde\n" +
    "pela outra fatia das vendas e precisaria de credencial própria.\n",
);
