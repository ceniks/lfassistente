/**
 * Testa a divisão dos holerites sem mandar e-mail nenhum.
 *
 *   npm run holerite -- ~/Downloads/holerites-09-2026.pdf
 *   npm run holerite -- arquivo.pdf --salvar pasta/
 *
 * Serve para calibrar: mostra o nome que ele leu em cada página, o que casou
 * com o cadastro e o que ficou de fora. Nada é enviado.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { dividir, nomeDaPagina, textoPorPagina } from '../rh/divisor.js';
import { acharFuncionaria, carregarCadastro, temCadastro } from '../rh/cadastro.js';
import { mesDeReferencia } from '../rh/fluxo.js';

const caminho = process.argv[2];
if (!caminho) {
  console.error('uso: npm run holerite -- <arquivo.pdf> [--salvar <pasta>]');
  process.exit(1);
}

const salvarEm = process.argv.includes('--salvar')
  ? process.argv[process.argv.indexOf('--salvar') + 1]
  : null;

const pdf = await readFile(caminho);
const paginas = await textoPorPagina(pdf);

console.log(`${basename(caminho)} · ${paginas.length} página(s) · mês ${mesDeReferencia(caminho)}\n`);
paginas.forEach((t, i) => {
  const nome = nomeDaPagina(t);
  console.log(`  pág ${String(i + 1).padStart(3)}  ${nome ?? '‼️  nome não reconhecido'}`);
});

const divisao = await dividir(pdf);
const cadastro = temCadastro() ? await carregarCadastro() : [];
console.log(`\n${divisao.holerites.length} holerite(s) · cadastro com ${cadastro.length} funcionária(s)\n`);

for (const h of divisao.holerites) {
  const f = cadastro.length ? acharFuncionaria(h.nome, cadastro) : null;
  console.log(`  ${h.nome.padEnd(40)} pág ${h.paginas.join(',').padEnd(10)} ${f?.email ?? (cadastro.length ? '‼️  sem e-mail no cadastro' : '(cadastro não configurado)')}`);
  if (salvarEm) {
    await mkdir(salvarEm, { recursive: true });
    const arquivo = join(salvarEm, `${h.nome.replace(/\s+/g, '-').toLowerCase()}.pdf`);
    await writeFile(arquivo, h.pdf);
  }
}

if (divisao.paginasSemNome.length) {
  console.log(`\n‼️  páginas sem nome: ${divisao.paginasSemNome.join(', ')}`);
}
if (salvarEm) console.log(`\narquivos salvos em ${salvarEm}`);
