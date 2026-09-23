/**
 * Envia os holerites já separados de uma pasta.
 *
 *   npm run holerite-enviar -- <pasta>            # mostra o que faria
 *   npm run holerite-enviar -- <pasta> --enviar   # manda de verdade
 *   npm run holerite-enviar -- <pasta> --enviar --so "Ronierik"
 *
 * A pasta precisa de um `_plano.json` com uma entrada por pessoa: nome,
 * primeiro, tratamento, email, arquivo. Quem já foi fica registrado em
 * `_enviados.txt` e não é reenviado — rodar duas vezes por engano não manda
 * holerite dobrado para ninguém.
 */
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { autorizacaoValida, enviarPeloGmail, temGmail } from '../rh/gmail.js';

interface Linha {
  nome: string;
  primeiro: string;
  tratamento: string;
  email: string;
  arquivo: string;
  liquido?: string;
}

const pasta = process.argv[2];
const enviarDeVerdade = process.argv.includes('--enviar');
const filtro = process.argv.includes('--so')
  ? process.argv[process.argv.indexOf('--so') + 1].toLowerCase()
  : null;
const mes = process.argv.includes('--mes')
  ? process.argv[process.argv.indexOf('--mes') + 1]
  : 'Agosto/2026';

if (!pasta) {
  console.error('uso: npm run holerite-enviar -- <pasta> [--enviar] [--so nome] [--mes Agosto/2026]');
  process.exit(1);
}
if (!temGmail()) {
  console.error('Falta GMAIL_REFRESH_TOKEN no .env (autorize com o escopo gmail.send).');
  process.exit(1);
}

const plano: Linha[] = JSON.parse(await readFile(join(pasta, '_plano.json'), 'utf8'));
const registro = join(pasta, '_enviados.txt');
const jaForam = new Set(
  existsSync(registro)
    ? (await readFile(registro, 'utf8')).split('\n').map((l) => l.split('\t')[1]).filter(Boolean)
    : [],
);

if (!(await autorizacaoValida())) {
  console.error('A autorização do Gmail não vale mais. Refaça o consentimento.');
  process.exit(1);
}
console.log(`${plano.length} holerite(s) em ${pasta} · mês ${mes}\n`);

const corpo = (l: Linha) =>
  `${l.tratamento} ${l.primeiro},\n\n` +
  `Segue em anexo seu holerite referente ao mês de ${mes}.\n\n` +
  'Agradecemos o seu empenho e dedicação!\n\n' +
  'Atenciosamente,\nL E FASHION EIRELI\n';

let enviados = 0;
let pulados = 0;
const falhas: string[] = [];

for (const l of plano) {
  if (filtro && !l.nome.toLowerCase().includes(filtro)) continue;
  if (jaForam.has(l.email)) {
    console.log(`  ⏭  ${l.nome} — já enviado antes`);
    pulados++;
    continue;
  }

  const assunto = config().HOLERITE_ASSUNTO.replace('{mes}', mes).replace('{nome}', l.nome);

  if (!enviarDeVerdade) {
    console.log(`  ▫️  ${l.email}\n      ${assunto}\n      anexo: ${l.arquivo}`);
    continue;
  }

  try {
    const anexo = await readFile(join(pasta, l.arquivo));
    const id = await enviarPeloGmail({
      para: l.email,
      assunto,
      corpo: corpo(l),
      anexo: { nome: l.arquivo, conteudo: anexo },
    });
    await appendFile(registro, `${new Date().toISOString()}\t${l.email}\t${l.nome}\t${id}\n`);
    console.log(`  ✓  ${l.nome} → ${l.email}`);
    enviados++;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  ✗  ${l.nome} → ${l.email}: ${msg.slice(0, 160)}`);
    falhas.push(`${l.nome}: ${msg.slice(0, 160)}`);
  }
}

console.log(
  enviarDeVerdade
    ? `\nenviados ${enviados} · pulados ${pulados} · falhas ${falhas.length}`
    : '\n(simulação — nada foi enviado; use --enviar)',
);
if (falhas.length) process.exitCode = 1;
