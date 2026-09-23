import { describe, expect, it } from 'vitest';
import { nomeDaPagina } from '../src/rh/divisor.js';
import { acharFuncionaria, type Funcionaria } from '../src/rh/cadastro.js';
import { mesDeReferencia } from '../src/rh/fluxo.js';

describe('nome na página do holerite', () => {
  it('lê o nome depois do rótulo', () => {
    expect(nomeDaPagina('L&F CONFECCOES LTDA\nNome do Funcionário: Maria Aparecida Silva\nCBO 7632')).toBe(
      'Maria Aparecida Silva',
    );
  });

  it('corta o que vem grudado na mesma linha', () => {
    expect(nomeDaPagina('Funcionário: Ana Paula Souza   CPF: 123.456.789-00')).toBe('Ana Paula Souza');
  });

  it('não confunde o nome da empresa com o da funcionária', () => {
    expect(nomeDaPagina('L&F CONFECCOES LTDA\nCNPJ 00.000.000/0001-00\nRecibo de pagamento')).toBeNull();
  });

  it('recusa uma palavra só, que não é nome de gente', () => {
    expect(nomeDaPagina('Nome: 00123')).toBeNull();
  });
});

describe('casamento com o cadastro', () => {
  const lista: Funcionaria[] = [
    { nome: 'Maria Aparecida Silva', email: 'maria@lf.com' },
    { nome: 'Ana Paula Souza', email: 'ana@lf.com', apelido: 'Aninha Souza' },
    { nome: 'Maria Aparecida Costa', email: 'costa@lf.com' },
  ];

  it('casa ignorando acento e caixa', () => {
    expect(acharFuncionaria('MARIA APARECIDA SILVA', lista)?.email).toBe('maria@lf.com');
  });

  it('casa pelo apelido', () => {
    expect(acharFuncionaria('Aninha Souza', lista)?.email).toBe('ana@lf.com');
  });

  it('casa nome do meio abreviado pelas pontas', () => {
    expect(acharFuncionaria('Maria A. Silva', lista)?.email).toBe('maria@lf.com');
  });

  it('não escolhe entre duas xarás: prefere não enviar', () => {
    const duas: Funcionaria[] = [
      { nome: 'Maria Silva', email: 'a@lf.com' },
      { nome: 'Maria Silva', email: 'b@lf.com' },
    ];
    expect(acharFuncionaria('Maria da Silva', duas)).toBeNull();
  });

  it('não casa por primeiro nome', () => {
    expect(acharFuncionaria('Maria', lista)).toBeNull();
  });
});

describe('mês de referência', () => {
  it('lê do nome do arquivo em número', () => {
    expect(mesDeReferencia('holerites-09-2026.pdf')).toBe('setembro de 2026');
  });

  it('lê do nome do arquivo por extenso', () => {
    expect(mesDeReferencia('folha setembro 2026.pdf')).toBe('setembro de 2026');
  });

  it('sem pista, usa o mês anterior ao de hoje', () => {
    expect(mesDeReferencia('arquivo.pdf', new Date('2026-10-05T12:00:00-03:00'))).toBe('setembro de 2026');
  });
});

describe('histórico de envio', () => {
  it('reconhece o mesmo mês escrito de formas diferentes', async () => {
    const { chaveDeNome } = await import('../src/rh/historico.js');
    expect(chaveDeNome('  Célia   Aparecida ')).toBe('celia aparecida');
  });
});

describe('corpo do e-mail', () => {
  it('troca os marcadores', async () => {
    const { corpoDoEmail } = await import('../src/rh/fluxo.js');
    const texto = corpoDoEmail('Ronierik Paulino Dias', 'Agosto/2026', '{tratamento} {primeiro}, mês {mes}, nome {nome}.');
    expect(texto).toBe('Prezado Ronierik, mês Agosto/2026, nome Ronierik Paulino Dias.');
  });

  it('respeita o tratamento escolhido à mão', async () => {
    const { corpoDoEmail } = await import('../src/rh/fluxo.js');
    expect(corpoDoEmail('Aline Bueno', 'Agosto/2026', '{tratamento}', 'Prezado')).toBe('Prezado');
  });
});

describe('tratamento', () => {
  it('acerta nomes femininos terminados em e', async () => {
    const { tratamentoDe } = await import('../src/rh/fluxo.js');
    for (const n of ['Aline Bueno', 'Daiane Michele', 'Marilene Pires', 'Rosinete Dos Santos']) {
      expect(tratamentoDe(n)).toBe('Prezada');
    }
  });

  it('acerta os masculinos da folha', async () => {
    const { tratamentoDe } = await import('../src/rh/fluxo.js');
    for (const n of ['Ronierik Paulino', 'José Antonio', 'Silvio Cesar', 'Bruno Santos']) {
      expect(tratamentoDe(n)).toBe('Prezado');
    }
  });
});

describe('conferência do Pix direto', () => {
  it('casa o e-mail com o nome de quem pagou', async () => {
    const { emailBateComNome } = await import('../src/data/conferencia-pix.js');
    expect(emailBateComNome('marquesesther@yahoo.com.br', 'ESTHER SIQUEIRA MONTEIRO MARQUES')).toBe(true);
    expect(emailBateComNome('lorenanunes@gmail.com', 'LORENA NUNES DO AMARAL PADIM')).toBe(true);
  });

  it('não casa por um sobrenome comum sozinho', async () => {
    const { emailBateComNome } = await import('../src/data/conferencia-pix.js');
    expect(emailBateComNome('silva123@gmail.com', 'JOAO DA SILVA')).toBe(false);
  });

  it('não casa e-mail genérico com qualquer pagador', async () => {
    const { emailBateComNome } = await import('../src/data/conferencia-pix.js');
    expect(emailBateComNome('contato@empresa.com', 'MARIA APARECIDA SOUZA')).toBe(false);
  });
});
