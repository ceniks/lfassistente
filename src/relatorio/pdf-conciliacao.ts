/**
 * A conferência de estorno em PDF.
 *
 * Existe porque a lista de divergências de um mês não cabe numa mensagem de
 * WhatsApp e não se resolve em pé: cada linha é um pedido para alguém abrir nos
 * dois sistemas e decidir o que fazer. Reaproveita as primitivas do boletim
 * para o documento não parecer de outra casa.
 */
import PDFDocument from 'pdfkit';
import type { Conciliacao } from '../data/conciliacao.js';
import { dinheiroExato, numero, dataPorExtenso } from '../digest/format.js';
import {
  LARGURA,
  MARGEM,
  RUIM,
  BOM,
  TINTA,
  TINTA2,
  TINTA3,
  LINHA,
  FUNDO,
  linha,
  paragrafo,
  rodape,
  tabela,
  titulo,
  type Doc,
} from './pdf.js';

function cabecalho(doc: Doc, c: Conciliacao) {
  doc.font('Helvetica-Bold').fontSize(20).fillColor(TINTA).text('L&F', MARGEM, MARGEM);
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor(TINTA2)
    .text('Conferência de estorno · Shopify contra Troquecommerce', MARGEM, doc.y + 2);

  const periodo =
    c.de === c.ate ? dataPorExtenso(c.de) : `${dataPorExtenso(c.de)} a ${dataPorExtenso(c.ate)}`;
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor(TINTA3)
    .text(periodo, MARGEM, MARGEM, { width: LARGURA, align: 'right' })
    .text(`gerado em ${new Date().toLocaleString('pt-BR')}`, { width: LARGURA, align: 'right' });

  doc.y = MARGEM + 54;
}

function cartoes(doc: Doc, c: Conciliacao) {
  const divergentes = c.soShopify.length + c.soTroque.length + c.valorDiferente.length;
  const itens: Array<[string, string, string, string]> = [
    ['SAIU DA SHOPIFY', dinheiroExato(c.shopify.valor), `${numero(c.shopify.quantidade)} reembolsos`, TINTA],
    ['FINALIZADO NO TROQUE', dinheiroExato(c.troque.valor), `${numero(c.troque.quantidade)} reversas`, TINTA],
    ['PEDIDOS DIVERGENTES', numero(divergentes), `${numero(c.batem)} batem`, divergentes ? RUIM : BOM],
  ];

  const largura = (LARGURA - 16) / 3;
  const y = doc.y;
  itens.forEach(([rotulo, valor, nota, cor], i) => {
    const x = MARGEM + i * (largura + 8);
    doc.roundedRect(x, y, largura, 58, 3).fill(FUNDO);
    doc.font('Helvetica').fontSize(7.5).fillColor(TINTA3)
      .text(rotulo, x + 12, y + 11, { width: largura - 24, characterSpacing: 0.6 });
    doc.font('Helvetica-Bold').fontSize(15).fillColor(cor)
      .text(valor, x + 12, y + 24, { width: largura - 24, lineBreak: false });
    doc.font('Helvetica').fontSize(7.5).fillColor(TINTA3)
      .text(nota, x + 12, y + 44, { width: largura - 24 });
  });
  doc.y = y + 72;
}

export function gerarPdfConciliacao(c: Conciliacao): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: MARGEM, bufferPages: true });
  const pedacos: Buffer[] = [];
  doc.on('data', (d: Buffer) => pedacos.push(d));
  const pronto = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(pedacos))));

  cabecalho(doc, c);
  cartoes(doc, c);

  titulo(doc, 'Resumo do período');
  linha(
    doc,
    'Reembolsado na Shopify',
    dinheiroExato(c.shopify.valor),
    c.shopify.pendente > 0
      ? `mais ${dinheiroExato(c.shopify.pendente)} emitido e pendente no adquirente`
      : `${numero(c.shopify.quantidade)} reembolso(s)`,
  );
  linha(
    doc,
    'Finalizado no Troquecommerce',
    dinheiroExato(c.troque.valor),
    `${numero(c.troque.quantidade)} reversa(s) com estorno`,
  );
  linha(
    doc,
    'Aprovado e ainda não pago',
    dinheiroExato(c.aguardandoPagamento.valor),
    `${numero(c.aguardandoPagamento.quantidade)} reversa(s) em "Aguardando Pagamento"`,
    c.aguardandoPagamento.valor > 0 ? RUIM : TINTA,
  );
  paragrafo(
    doc,
    '"Aguardando Pagamento" não é divergência entre os sistemas: é estorno aprovado cujo pagamento ' +
      'ainda não saiu. Entra aqui porque é dinheiro devido, e some de qualquer painel que só compare totais.',
    TINTA3,
  );

  if (c.soShopify.length) {
    titulo(doc, `Saiu da Shopify sem reversa finalizada — ${numero(c.soShopify.length)} pedidos`);
    tabela(
      doc,
      ['Pedido', 'Situação no Troquecommerce', 'Valor'],
      c.soShopify.map((x) => [x.pedido, x.situacao, dinheiroExato(x.valor)]),
      [80, LARGURA - 180, 100],
      ['left', 'left', 'right'],
    );
    paragrafo(
      doc,
      'Os que dizem "nenhuma reversa" são reembolsos feitos direto no painel da Shopify, fora do ' +
        'processo de troca. Os que têm reversa em outro status são dinheiro devolvido antes de a ' +
        'reversa fechar — pode ser adiantamento deliberado, pode ser descontrole.',
      TINTA3,
    );
  }

  if (c.soTroque.length) {
    titulo(doc, `Finalizado no Troquecommerce sem saída na Shopify — ${numero(c.soTroque.length)} pedidos`);
    tabela(
      doc,
      ['Pedido', 'Situação', 'Valor'],
      c.soTroque.map((x) => [x.pedido, 'estorno finalizado, sem reembolso na Shopify', dinheiroExato(x.valor)]),
      [80, LARGURA - 180, 100],
      ['left', 'left', 'right'],
    );
    paragrafo(
      doc,
      'A reversa foi encerrada como estornada e o dinheiro não saiu por aqui. Ou saiu por fora ' +
        '(PIX, transferência) e a Shopify não sabe, ou não saiu — e a cliente está esperando.',
      TINTA3,
    );
  }

  if (c.valorDiferente.length) {
    titulo(doc, `Valor diferente entre os dois sistemas — ${numero(c.valorDiferente.length)} pedidos`);
    tabela(
      doc,
      ['Pedido', 'Shopify', 'Troquecommerce', 'Diferença'],
      c.valorDiferente.map((x) => [
        x.pedido,
        dinheiroExato(x.shopify),
        dinheiroExato(x.troque),
        dinheiroExato(x.diferenca),
      ]),
      [LARGURA - 330, 110, 110, 110],
      ['left', 'right', 'right', 'right'],
    );
    paragrafo(
      doc,
      'Diferença positiva significa que a Shopify devolveu mais do que a reversa registrou. ' +
        'Várias destas batem exatamente com o preço de uma peça, o que aponta para estorno ' +
        'ajustado na mão sem o mesmo ajuste do outro lado.',
      TINTA3,
    );
  }

  if (!c.soShopify.length && !c.soTroque.length && !c.valorDiferente.length) {
    titulo(doc, 'Nenhuma divergência');
    paragrafo(
      doc,
      `Os ${numero(c.batem)} pedidos conferidos batem nos dois sistemas.`,
      TINTA,
    );
  }

  titulo(doc, 'Como esta conferência é feita');
  paragrafo(
    doc,
    'Só reversa FINALIZADA cobra saída na Shopify. O valor de estorno existe no Troquecommerce desde ' +
      'a abertura da reversa: é o previsto, não o pago. Reversa em trânsito não deveria ter pago nada.',
    TINTA2,
  );
  paragrafo(
    doc,
    'Reembolso feito em outro dia não vira divergência. Antes de apontar um pedido, a conferência ' +
      'procura o par pelo número do pedido nos dois lados, fora do período.',
    TINTA2,
  );
  paragrafo(
    doc,
    'Reembolso com transação pendente no adquirente conta como reembolso. A Shopify só soma o que ' +
      'foi liquidado, então um estorno emitido e não compensado aparece como zero na API e como ' +
      '"reembolsado" no painel.',
    TINTA2,
  );
  paragrafo(doc, 'Diferença abaixo de R$ 1,00 é arredondamento entre sistemas e não é apontada.', TINTA2);

  rodape(doc, 'conferência de estorno');
  doc.end();
  return pronto;
}
