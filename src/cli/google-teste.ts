/**
 * Confere se o Google Ads está respondendo e se os números fazem sentido.
 *
 *   npm run google-teste            # ontem
 *   npm run google-teste 2026-09-10 # um dia específico
 *
 * Duas conferências que importam mais que o "conectou":
 *
 *  - o NOME e o FUSO da conta. Autorizar a conta errada não dá erro nenhum;
 *    devolve zeros muito convincentes. E se o fuso não for São Paulo, o "dia"
 *    do Google não é o nosso dia.
 *  - os últimos 7 dias. Um dia zerado pode ser real; sete zerados seguidos
 *    quase sempre significam conta errada ou período sem veiculação.
 */
import { contaGoogle, midiaGoogleDoDia, temGoogleAds } from '../data/google.js';
import { config } from '../config.js';
import { ontem } from '../digest/build.js';
import { dinheiro, dinheiroExato, numero } from '../digest/format.js';

const dia = process.argv[2] ?? ontem();
const c = config();

if (!temGoogleAds()) {
  console.error(
    '\nFalta credencial do Google Ads. Precisa das quatro:\n' +
      `  GOOGLE_ADS_CUSTOMER_ID      ${c.GOOGLE_ADS_CUSTOMER_ID ? '✓' : '✗'}\n` +
      `  GOOGLE_ADS_CLIENT_ID        ${c.GOOGLE_ADS_CLIENT_ID ? '✓' : '✗'}\n` +
      `  GOOGLE_ADS_CLIENT_SECRET    ${c.GOOGLE_ADS_CLIENT_SECRET ? '✓' : '✗'}\n` +
      `  GOOGLE_ADS_REFRESH_TOKEN    ${c.GOOGLE_ADS_REFRESH_TOKEN ? '✓' : '✗'}\n`,
  );
  process.exit(1);
}

console.log(`\nAPI ${c.GOOGLE_ADS_API_VERSION} · cliente ${c.GOOGLE_ADS_CUSTOMER_ID}`);
if (c.GOOGLE_ADS_LOGIN_CUSTOMER_ID) {
  console.log(`gerenciadora ${c.GOOGLE_ADS_LOGIN_CUSTOMER_ID}`);
}

try {
  const conta = await contaGoogle();
  console.log(`\n✓ ${conta.nome} · ${conta.moeda} · fuso ${conta.fuso}`);

  if (conta.fuso !== 'America/Sao_Paulo') {
    console.log(
      `\n⚠️  A conta está em ${conta.fuso}, não em America/Sao_Paulo.\n` +
        '   O "dia" do Google não coincide com o nosso — o gasto sai deslocado.',
    );
  }

  const m = await midiaGoogleDoDia(dia);
  console.log(`\n--- ${dia} ---`);
  console.log(`gasto        ${dinheiro(m.valorPago)}  (sem imposto, por definição)`);
  console.log(`vendas       ${dinheiro(m.receita)}`);
  console.log(`ROAS         ${numero(m.roas, 2)}`);
  console.log(`conversões   ${numero(m.conversoes, 2)}`);
  console.log(
    `cliques      ${numero(m.cliques)} · CPC ${dinheiroExato(m.cpc)} · CPM ${dinheiroExato(m.cpm)}`,
  );
  console.log(`impressões   ${numero(m.impressoes)}`);

  // Sete dias seguidos zerados é o sintoma de conta errada.
  const base = new Date(`${dia}T12:00:00-03:00`);
  const semana = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(base);
    d.setDate(d.getDate() - i);
    return d.toISOString().slice(0, 10);
  });

  console.log('\n--- 7 dias ---');
  let gastoSemana = 0;
  for (const d of semana) {
    const x = await midiaGoogleDoDia(d);
    gastoSemana += x.valorPago;
    console.log(
      `${d}  ${dinheiro(x.valorPago).padStart(12)}  ${dinheiro(x.receita).padStart(12)}  ROAS ${numero(x.roas, 2)}`,
    );
  }

  if (gastoSemana === 0) {
    console.log(
      '\n⚠️  Nenhum gasto em 7 dias. Ou a conta está parada, ou autorizamos a conta errada.\n' +
        '   Confira o nome acima contra o que aparece no Google Ads.',
    );
  }
} catch (e) {
  console.error(`\n✗ ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}

console.log('\n');
