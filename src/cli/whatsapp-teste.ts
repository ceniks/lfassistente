/**
 * Descobre a conta do WhatsApp certa e confere os envios das réguas contra o Meta.
 *
 *   npm run whatsapp-teste                       # últimos 7 dias
 *   npm run whatsapp-teste 2026-09-01 2026-09-13
 *
 * Por que existe: o AtendePro só gravou o ID de mensagem da Meta em uma fração
 * dos envios — 1.070 de 5.446 no flow RECENTES. O que ele mostra como
 * "entregue" é, portanto, a contagem de uma amostra, não do total. O Meta tem
 * todos. Aqui ele é a fonte, e o AtendePro vira a cópia a ser conferida.
 *
 * A descoberta da conta também não é luxo: há sete WABAs no portfólio e quase
 * todas se chamam "LF Fashion". Escolher pelo nome é chute. A conta certa é a
 * que hospeda os templates das réguas, e isso o script resolve sozinho.
 */
import { contasDeWhatsapp, templatesDaConta, fluxosDoDia } from '../data/meta.js';
import { config } from '../config.js';
import { numero, pct } from '../digest/format.js';

/** Os templates das cinco réguas, como aparecem no AtendePro. */
const TEMPLATES_DAS_REGUAS = [
  'RECOMP1',
  'RECOMP2',
  'recomp60dv1',
  'recomp60dv2',
  'recomp60dv3',
  'recompd90dv1',
  'recomp90dv2',
  'reativ180dv1',
  'reativ180dv2',
  'compraram365dv1',
];

const norm = (s: string) => s.toLowerCase().trim();
const alvo = new Set(TEMPLATES_DAS_REGUAS.map(norm));

function ultimosDias(n: number): string[] {
  const hoje = new Date();
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(hoje);
    d.setDate(d.getDate() - (i + 1));
    return d.toISOString().slice(0, 10);
  }).reverse();
}

const [argIni, argFim] = process.argv.slice(2);
const dias =
  argIni && argFim
    ? (() => {
        const saida: string[] = [];
        for (let d = new Date(`${argIni}T12:00:00Z`); d <= new Date(`${argFim}T12:00:00Z`); ) {
          saida.push(d.toISOString().slice(0, 10));
          d.setDate(d.getDate() + 1);
        }
        return saida;
      })()
    : ultimosDias(7);

const c = config();

if (!c.META_WHATSAPP_TOKEN && !c.META_SYSTEM_TOKEN) {
  console.error('\nFalta META_WHATSAPP_TOKEN no .env.\n');
  process.exit(1);
}

console.log(
  `\nToken: ${c.META_WHATSAPP_TOKEN ? 'META_WHATSAPP_TOKEN' : 'META_SYSTEM_TOKEN (fallback)'}`,
);

/* --- 1. Qual conta hospeda as réguas --- */

let waba = c.WABA_ID;

if (waba) {
  console.log(`WABA_ID do .env: ${waba}`);
} else {
  console.log('\nWABA_ID vazio — procurando a conta que hospeda os templates das réguas…\n');

  let contas: Array<{ id: string; nome: string }>;
  try {
    contas = await contasDeWhatsapp();
  } catch (e) {
    console.error(`✗ ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }

  console.log(`${contas.length} conta(s) visíveis para este token:`);

  for (const conta of contas) {
    let achados = 0;
    try {
      const ts = await templatesDaConta(conta.id);
      achados = ts.filter((t) => alvo.has(norm(t.nome))).length;
      console.log(
        `  ${conta.id}  ${conta.nome.padEnd(34)} ${ts.length} templates · ${achados} das réguas`,
      );
    } catch {
      console.log(`  ${conta.id}  ${conta.nome.padEnd(34)} não consegui ler os templates`);
    }
    // A conta certa é a que tem a maioria dos dez. Uma que tenha um ou dois
    // provavelmente compartilha nome com outra régua antiga.
    if (achados >= 5) waba = conta.id;
  }

  if (!waba) {
    console.error(
      '\n✗ Nenhuma conta hospeda os templates das réguas.\n' +
        '  Ou o token não enxerga a conta certa, ou os nomes dos templates mudaram.\n',
    );
    process.exit(1);
  }

  console.log(`\n→ Conta identificada: ${waba}`);
  console.log(`  Coloque no .env: WABA_ID=${waba}\n`);
}

/* --- 2. Os templates e seus ids --- */

const templates = await templatesDaConta(waba);
const daRegua = templates.filter((t) => alvo.has(norm(t.nome)));

console.log(`\n--- templates das réguas (${daRegua.length} de ${TEMPLATES_DAS_REGUAS.length}) ---`);
for (const t of daRegua) {
  console.log(`  ${t.nome.padEnd(18)} ${t.id}  ${t.status}  ${t.categoria}`);
}

const faltando = TEMPLATES_DAS_REGUAS.filter(
  (n) => !daRegua.some((t) => norm(t.nome) === norm(n)),
);
if (faltando.length) {
  console.log(`\n  não encontrados nesta conta: ${faltando.join(', ')}`);
}

const reprovados = daRegua.filter((t) => t.status !== 'APPROVED');
if (reprovados.length) {
  console.log(
    `\n  ⚠️  ${reprovados.length} template(s) não aprovado(s) — disparo com eles falha sempre:`,
  );
  for (const t of reprovados) console.log(`     ${t.nome}: ${t.status}`);
}

/* --- 3. O que o Meta diz que saiu --- */

console.log(`\n--- envios pelo Meta, ${dias[0]} a ${dias[dias.length - 1]} ---`);

const porTemplate = new Map<string, { enviadas: number; entregues: number; lidas: number }>();
const ids = daRegua.map((t) => t.id);
const nomePorId = new Map(daRegua.map((t) => [t.id, t.nome]));

for (const dia of dias) {
  let linhas;
  try {
    linhas = await fluxosDoDia(dia, ids);
  } catch (e) {
    console.log(`  ${dia}: falhou — ${e instanceof Error ? e.message : String(e)}`);
    continue;
  }
  for (const l of linhas) {
    const atual = porTemplate.get(l.template) ?? { enviadas: 0, entregues: 0, lidas: 0 };
    atual.enviadas += l.enviadas;
    atual.entregues += l.entregues;
    atual.lidas += l.lidas;
    porTemplate.set(l.template, atual);
  }
}

if (!porTemplate.size) {
  console.log(
    '  Nenhum dado. Ou não houve envio no período, ou o template_analytics precisa ser\n' +
      '  habilitado na conta (Gerenciador do WhatsApp → Análises).',
  );
} else {
  let te = 0;
  let td = 0;
  let tl = 0;
  for (const [id, v] of [...porTemplate].sort((a, b) => b[1].enviadas - a[1].enviadas)) {
    te += v.enviadas;
    td += v.entregues;
    tl += v.lidas;
    console.log(
      `  ${(nomePorId.get(id) ?? id).padEnd(18)} ${numero(v.enviadas).padStart(7)} enviadas · ` +
        `${numero(v.entregues).padStart(7)} entregues (${pct(v.enviadas ? v.entregues / v.enviadas : 0, 0)}) · ` +
        `${numero(v.lidas).padStart(7)} lidas (${pct(v.entregues ? v.lidas / v.entregues : 0, 0)} das entregues)`,
    );
  }
  console.log(
    `\n  TOTAL              ${numero(te).padStart(7)} enviadas · ${numero(td).padStart(7)} entregues · ${numero(tl).padStart(7)} lidas`,
  );
  console.log(
    '\n  Compare com o que o AtendePro reporta no mesmo período. Divergência grande em\n' +
      '  "enviadas" significa envio que o AtendePro não registrou (ou o contrário);\n' +
      '  divergência em "entregues" é esperada, porque ele só tem o ID da Meta de parte deles.',
  );
}

console.log('\n');
process.exit(0);
