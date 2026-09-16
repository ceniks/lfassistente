import PDFDocument from 'pdfkit';
import type { DadosRelatorio } from './dados.js';
import { dinheiro, dinheiroExato, pct, numero, variacao, dataPorExtenso } from '../digest/format.js';
import { reposicao } from '../data/cobertura.js';
import { config } from '../config.js';

/**
 * O boletim completo em PDF.
 *
 * Desenhado com PDFKit, sem navegador headless de propósito: no Railway, um
 * Chromium acrescenta uns 300 MB à imagem e segundos de cold start para gerar
 * um documento que sai de meia dúzia de retângulos e texto. O preço é desenhar
 * as tabelas na mão; o ganho é um serviço que sobe em segundos.
 *
 * As fontes embutidas do PDFKit (Helvetica) usam WinAnsi, que cobre acentuação
 * do português. Não é preciso embarcar fonte.
 */

/* ------------------------------------------------------------------ *
 * Paleta e medidas
 * ------------------------------------------------------------------ */

export const TINTA = '#1a1a1a';
export const TINTA2 = '#595959';
export const TINTA3 = '#8c8c8c';
export const LINHA = '#d9d9d9';
export const FUNDO = '#f5f5f5';
export const DESTAQUE = '#8c6d2f';
export const BOM = '#2f6b45';
export const RUIM = '#a33a3a';

export const MARGEM = 44;
export const LARGURA = 595.28 - MARGEM * 2; // A4 retrato

export type Doc = InstanceType<typeof PDFDocument>;

/* ------------------------------------------------------------------ *
 * Primitivas de desenho
 * ------------------------------------------------------------------ */

export function titulo(doc: Doc, texto: string) {
  garantirEspaco(doc, 60);
  doc.moveDown(0.9);
  const y = doc.y;
  doc.font('Helvetica-Bold').fontSize(11).fillColor(TINTA).text(texto.toUpperCase(), MARGEM, y, {
    characterSpacing: 1.1,
  });
  doc
    .moveTo(MARGEM, doc.y + 3)
    .lineTo(MARGEM + LARGURA, doc.y + 3)
    .lineWidth(0.8)
    .strokeColor(TINTA)
    .stroke();
  doc.moveDown(0.7);
}

export function paragrafo(doc: Doc, texto: string, cor = TINTA2) {
  doc.font('Helvetica').fontSize(9).fillColor(cor).text(texto, MARGEM, doc.y, {
    width: LARGURA,
    lineGap: 2,
  });
}

/** Quebra a página quando o que vem não cabe, para não cortar bloco no meio. */
export function garantirEspaco(doc: Doc, altura: number) {
  if (doc.y + altura > doc.page.height - MARGEM - 24) doc.addPage();
}

/**
 * Linha de rótulo e valor, com o valor alinhado à direita.
 *
 * Números em coluna só se comparam se terminarem no mesmo lugar; alinhados à
 * esquerda, o olho tem que reler cada um.
 */
export function linha(doc: Doc, rotulo: string, valor: string, nota?: string, corValor = TINTA) {
  garantirEspaco(doc, 16);
  const y = doc.y;
  doc.font('Helvetica').fontSize(9).fillColor(TINTA2).text(rotulo, MARGEM, y, { width: 200 });
  doc
    .font('Helvetica-Bold')
    .fontSize(9)
    .fillColor(corValor)
    .text(valor, MARGEM + 200, y, { width: 110, align: 'right' });
  let alturaNota = 0;
  if (nota) {
    doc.font('Helvetica').fontSize(8.5).fillColor(TINTA3);
    // Medir antes de escrever: nota comprida quebra em duas linhas, e avançar
    // sempre 14pt fazia a segunda linha cair por cima do que vem depois. O
    // sintoma só aparece em nota longa, então passava despercebido até aparecer
    // no meio de um bloco importante.
    alturaNota = doc.heightOfString(nota, { width: LARGURA - 320 });
    doc.text(nota, MARGEM + 320, y + 0.5, { width: LARGURA - 320 });
  }
  doc.y = y + Math.max(14, alturaNota + 4);
}

/** Cor de uma variação: verde sobe, vermelho desce, cinza quando não há base. */
function corDaVariacao(v: string): string {
  if (!v) return TINTA3;
  return v.startsWith('-') ? RUIM : BOM;
}

/**
 * Corta o texto na largura da coluna, com reticencias.
 *
 * O `ellipsis` do PDFKit nao resolve sozinho quando a celula tem altura fixa: o
 * nome longo quebra em duas linhas e invade a linha de baixo. Aqui o corte
 * acontece antes de desenhar, medindo a string de verdade — nome de campanha da
 * L&F chega a oitenta caracteres com colchetes.
 */
export function cortar(doc: Doc, texto: string, largura: number, fonte: string, tamanho: number): string {
  doc.font(fonte).fontSize(tamanho);
  if (doc.widthOfString(texto) <= largura) return texto;

  let corte = texto;
  while (corte.length > 4 && doc.widthOfString(corte + '...') > largura) {
    corte = corte.slice(0, -1);
  }
  return corte.trimEnd() + '...';
}

export function tabela(
  doc: Doc,
  cabecalho: string[],
  linhas: string[][],
  larguras: number[],
  alinhamentos: Array<'left' | 'right'> = [],
) {
  const alturaLinha = 15;
  garantirEspaco(doc, alturaLinha * (linhas.length + 1) + 10);

  // Coluna alinhada à direita encosta na próxima, porque o texto preenche até a
  // borda da célula. Um respiro de 8pt resolve — e não se aplica à última
  // coluna, que tem a margem da página como folga.
  const util = (i: number) =>
    (alinhamentos[i] ?? 'left') === 'right' && i < larguras.length - 1
      ? larguras[i] - 8
      : larguras[i];

  let y = doc.y;
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(TINTA3);
  let x = MARGEM;
  cabecalho.forEach((c, i) => {
    doc.text(c.toUpperCase(), x, y, {
      width: util(i),
      align: alinhamentos[i] ?? 'left',
      characterSpacing: 0.6,
    });
    x += larguras[i];
  });

  y += 12;
  doc.moveTo(MARGEM, y).lineTo(MARGEM + LARGURA, y).lineWidth(0.5).strokeColor(LINHA).stroke();
  y += 4;

  for (const l of linhas) {
    if (y + alturaLinha > doc.page.height - MARGEM - 24) {
      doc.addPage();
      y = doc.y;
    }
    x = MARGEM;
    l.forEach((celula, i) => {
      doc
        .font(i === 0 ? 'Helvetica' : 'Helvetica-Bold')
        .fontSize(8.5)
        .fillColor(i === 0 ? TINTA : TINTA2)
        .text(
          cortar(doc, celula, util(i) - 6, i === 0 ? 'Helvetica' : 'Helvetica-Bold', 8.5),
          x,
          y,
          {
          width: util(i),
          align: alinhamentos[i] ?? 'left',
          lineBreak: false,
        });
      x += larguras[i];
    });
    y += alturaLinha;
  }

  doc.y = y + 4;
}

/* ------------------------------------------------------------------ *
 * Cabeçalho e indicadores
 * ------------------------------------------------------------------ */

function cabecalho(doc: Doc, d: DadosRelatorio) {
  doc.font('Helvetica-Bold').fontSize(20).fillColor(TINTA).text('L&F', MARGEM, MARGEM);
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor(TINTA3)
    .text('Boletim completo da operação', MARGEM, MARGEM + 24);

  const carimbo = d.geradoEm.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  doc
    .font('Helvetica')
    .fontSize(8.5)
    .fillColor(TINTA3)
    .text(dataPorExtenso(d.dia), MARGEM, MARGEM + 2, { width: LARGURA, align: 'right' })
    .text(`gerado em ${carimbo}`, MARGEM, MARGEM + 14, { width: LARGURA, align: 'right' });

  doc
    .moveTo(MARGEM, MARGEM + 44)
    .lineTo(MARGEM + LARGURA, MARGEM + 44)
    .lineWidth(1.2)
    .strokeColor(TINTA)
    .stroke();

  doc.y = MARGEM + 58;
}

/** Os quatro números que respondem "como foi o dia" antes de qualquer detalhe. */
function indicadores(doc: Doc, d: DadosRelatorio) {
  const v = d.vendas;
  const gastoTotal = (d.midia?.valorPago ?? 0) + (d.google?.valorPago ?? 0);

  const caixas = [
    {
      rotulo: 'Faturamento',
      valor: dinheiro(v.receita),
      nota: d.meta ? `${pct(d.meta > 0 ? v.receita / d.meta : 0, 0)} da meta` : 'sem meta no sistema',
    },
    { rotulo: 'Pedidos pagos', valor: numero(v.pedidos), nota: `${numero(v.pecas)} peças` },
    {
      rotulo: 'Ticket médio',
      valor: dinheiro(v.ticketMedio),
      nota: `7d ${dinheiro(d.media7d.ticketMedio)}`,
    },
    {
      rotulo: 'Mídia sobre receita',
      valor: v.receita > 0 && gastoTotal > 0 ? pct(gastoTotal / v.receita) : '—',
      nota: gastoTotal > 0 ? `MER ${numero(v.receita / gastoTotal, 2)}` : 'sem gasto',
    },
  ];

  const largura = (LARGURA - 3 * 8) / 4;
  const y = doc.y;

  caixas.forEach((c, i) => {
    const x = MARGEM + i * (largura + 8);
    doc.rect(x, y, largura, 52).fillColor(FUNDO).fill();
    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor(TINTA3)
      .text(c.rotulo.toUpperCase(), x + 8, y + 8, { width: largura - 16, characterSpacing: 0.5 });
    doc
      .font('Helvetica-Bold')
      .fontSize(14)
      .fillColor(TINTA)
      .text(c.valor, x + 8, y + 20, { width: largura - 16 });
    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor(TINTA3)
      .text(c.nota, x + 8, y + 38, { width: largura - 16 });
  });

  doc.y = y + 62;
}

/* ------------------------------------------------------------------ *
 * Gráfico da série
 * ------------------------------------------------------------------ */

/**
 * Barras de receita por dia.
 *
 * A escala começa em zero. Cortar o eixo faz uma variação de 5% parecer um
 * despencar, e um relatório que exagera sozinho deixa de ser útil para decidir.
 */
function grafico(doc: Doc, d: DadosRelatorio) {
  const altura = 96;
  garantirEspaco(doc, altura + 40);

  const pontos = d.serie;
  const maior = Math.max(...pontos.map((p) => p.receita), 1);
  const larguraBarra = (LARGURA - (pontos.length - 1) * 4) / pontos.length;
  const base = doc.y + altura;

  // Linha da média de 7 dias: dá a régua contra a qual o dia se lê.
  const yMedia = base - (d.media7d.receita / maior) * altura;
  doc
    .moveTo(MARGEM, yMedia)
    .lineTo(MARGEM + LARGURA, yMedia)
    .lineWidth(0.6)
    .dash(2, { space: 2 })
    .strokeColor(DESTAQUE)
    .stroke()
    .undash();

  pontos.forEach((p, i) => {
    const x = MARGEM + i * (larguraBarra + 4);
    const h = Math.max(1, (p.receita / maior) * altura);
    const ehODia = p.dia === d.dia;
    doc
      .rect(x, base - h, larguraBarra, h)
      .fillColor(ehODia ? TINTA : LINHA)
      .fill();

    if (i % 2 === 0 || ehODia) {
      doc
        .font(ehODia ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(6)
        .fillColor(ehODia ? TINTA : TINTA3)
        .text(p.dia.slice(8, 10) + '/' + p.dia.slice(5, 7), x - 3, base + 4, {
          width: larguraBarra + 6,
          align: 'center',
        });
    }
  });

  doc
    .font('Helvetica')
    .fontSize(7)
    .fillColor(DESTAQUE)
    .text(`- - -  media 7d ${dinheiro(d.media7d.receita)}`, MARGEM, base + 14, {
      width: LARGURA,
      align: 'right',
    });

  doc.y = base + 26;
}

/* ------------------------------------------------------------------ *
 * Seções
 * ------------------------------------------------------------------ */

function secaoVendas(doc: Doc, d: DadosRelatorio) {
  const v = d.vendas;
  titulo(doc, 'Vendas');

  const varReceita = variacao(v.receita, d.media7d.receita);
  linha(doc, 'Receita', dinheiro(v.receita), `vs média 7d ${varReceita}`, corDaVariacao(varReceita));
  const varPedidos = variacao(v.pedidos, d.media7d.pedidos);
  linha(doc, 'Pedidos pagos', numero(v.pedidos), `vs média 7d ${varPedidos}`, corDaVariacao(varPedidos));
  linha(doc, 'Ticket médio', dinheiro(v.ticketMedio), `média 7d ${dinheiro(d.media7d.ticketMedio)}`);
  linha(doc, 'Peças por pedido', numero(v.pecasPorPedido, 2), `${numero(v.pecas)} peças no total`);

  if (d.semanaPassada) {
    const s = d.semanaPassada;
    const varSemana = variacao(v.receita, s.receita);
    linha(
      doc,
      'Mesmo dia da semana passada',
      dinheiro(s.receita),
      `${varSemana} · ${numero(s.pedidos)} pedidos`,
      corDaVariacao(varSemana),
    );
  }

  if (d.meta !== null) {
    const falta = d.meta - v.receita;
    linha(
      doc,
      'Meta do dia',
      dinheiro(d.meta),
      falta > 0 ? `faltou ${dinheiro(falta)}` : `superou em ${dinheiro(-falta)}`,
      falta > 0 ? RUIM : BOM,
    );
  }

  if (v.excluidos.trocas || v.excluidos.influencers || v.excluidos.reenvios) {
    const fora = [
      v.excluidos.trocas ? `${v.excluidos.trocas} troca(s)` : '',
      v.excluidos.influencers ? `${v.excluidos.influencers} de influencer` : '',
      v.excluidos.reenvios ? `${v.excluidos.reenvios} reenvio(s)` : '',
    ].filter(Boolean);

    paragrafo(
      doc,
      `Fora da conta: ${fora.join(', ')}. Nenhum é venda nova: troca e seeding entram nos seus ` +
        'próprios blocos, e reenvio é peça mandada de novo sem cobrança. O seeding é reconhecido ' +
        'pelo cupom FRETEINFLUENCERS, não pela tag — a tag varia (Influencer, MS, MS OUTUBRO) e ' +
        'deixava metade dos pedidos passando como venda.',
      TINTA3,
    );
  }
}

function secaoClientes(doc: Doc, d: DadosRelatorio) {
  const c = d.clientes;
  if (!c) return;
  const comCliente = c.pedidosNovos + c.pedidosRecorrentes;
  if (!comCliente) return;

  const receita = c.receitaNovos + c.receitaRecorrentes;
  linha(
    doc,
    'Clientes novos',
    `${pct(c.pedidosNovos / comCliente)}`,
    `${numero(c.pedidosNovos)} pedidos · ${dinheiro(c.receitaNovos)}`,
  );
  linha(
    doc,
    'Recompra',
    `${pct(c.pedidosRecorrentes / comCliente)}`,
    `${numero(c.pedidosRecorrentes)} pedidos · ${dinheiro(c.receitaRecorrentes)}` +
      (receita > 0 ? ` · ${pct(c.receitaRecorrentes / receita)} da receita` : ''),
  );
  if (c.semCliente > 0) {
    paragrafo(
      doc,
      `${numero(c.semCliente)} pedido(s) sem cliente identificado ficaram fora dessa divisão.`,
      TINTA3,
    );
  }
}

/**
 * O check-in geral: quanta roupa a operação tem, e onde ela está.
 *
 * Três lugares, três significados. No site é o que pode virar receita hoje. Na
 * oficina é dinheiro já comprometido que ainda não chegou. No galpão sem subir
 * é o pior dos três: peça pronta, paga, e invisível para quem compra.
 */
function secaoPatrimonio(doc: Doc, d: DadosRelatorio) {
  const p = d.patrimonio;
  if (!p) return;

  titulo(doc, 'Check-in geral do estoque');

  linha(
    doc,
    'No site',
    numero(p.loja.pecas),
    `${dinheiro(p.loja.valorDeVenda)} a preço de etiqueta` +
      (p.loja.valorDeCusto !== null ? ` · ${dinheiro(p.loja.valorDeCusto)} de custo` : ''),
  );
  if (p.loja.valorDeCusto !== null && p.loja.valorDeCusto > 0) {
    const markup = p.loja.valorDeVendaComCusto / p.loja.valorDeCusto;
    linha(
      doc,
      '  markup implícito',
      `${numero(markup, 2)}x`,
      'etiqueta ÷ custo, só das peças que têm custo no Corte Pro',
    );
  }
  linha(
    doc,
    'Em produção',
    numero(p.emProducao.pecas),
    `${numero(p.emProducao.cortes)} cortes na oficina e no caseado`,
  );
  linha(
    doc,
    'Pronto e fora do site',
    numero(p.semSubirNoSite.pecas),
    p.semSubirNoSite.cortes
      ? `${numero(p.semSubirNoSite.cortes)} corte(s): ${p.semSubirNoSite.lista
          .map((c) => `${c.produto} (${numero(c.pecas)})`)
          .join(', ')}`
      : 'nenhum corte esperando entrada',
    p.semSubirNoSite.pecas > 0 ? RUIM : BOM,
  );

  // Custo que não fecha com o preço é registro errado, não margem boa. A
  // Camisa Layla passou meses a R$ 21,83 contra R$ 47,58 do painel, e só
  // apareceu porque o total do estoque pareceu baixo.
  if (p.custoSuspeito.length) {
    linha(
      doc,
      'Custo suspeito no Corte Pro',
      numero(p.custoSuspeito.reduce((t, c) => t + c.pecas, 0)),
      p.custoSuspeito
        .slice(0, 4)
        .map(
          (c) =>
            `${c.titulo}: ${dinheiro(c.custoPorPeca)} para ${dinheiro(c.precoMedio)} (${numero(c.markup, 1)}x)`,
        )
        .join(', '),
      RUIM,
    );
  }

  if (p.semCusto.pecas > 0) {
    paragrafo(
      doc,
      `O custo vem do Corte Pro, do corte mais recente de cada peça. ${numero(p.semCusto.pecas)} ` +
        `peças em ${numero(p.semCusto.produtos)} produtos ficaram sem custo: são modelos que não ` +
        'têm corte registrado lá (produto antigo ou comprado pronto), então o valor de custo ' +
        'acima cobre o resto e é um piso, não o total. "Em produção" soma oficina e caseado — em ' +
        'corte ainda é tecido. O que está fora do site conta cortes que chegaram ao galpão a ' +
        `partir de ${p.semSubirNoSite.desde.split('-').reverse().join('/')}, quando o campo ` +
        '"subiu no site" passou a ser preenchido.',
      TINTA3,
    );
  }
}

function secaoEstoque(doc: Doc, d: DadosRelatorio) {
  const cob = d.cobertura;
  if (!cob?.length) return;
  titulo(doc, 'Estoque dos campeões');

  tabela(
    doc,
    ['Peça', 'Vendidas', 'Saída/dia', 'Estoque', 'Cobertura', 'No ritmo 7d', 'Reposição'],
    cob.map((c) => [
      c.titulo,
      numero(c.vendidasNoDia),
      numero(c.mediaDiaria, 1),
      c.estoque === null ? '—' : numero(c.estoque),
      c.diasDeCobertura === null ? '—' : `${numero(c.diasDeCobertura, 1)} d`,
      c.diasDeCobertura7d === null ? '—' : `${numero(c.diasDeCobertura7d, 1)} d`,
      reposicao(c) > 0 ? numero(reposicao(c)) : '—',
    ]),
    [LARGURA - 415, 60, 65, 65, 65, 75, 70],
    ['left', 'right', 'right', 'right', 'right', 'right', 'right'],
  );

  // O alerta olha a pior das duas leituras: peça acelerando tem cobertura longa
  // confortável e cobertura recente curta, e é a curta que vai acontecer.
  const pior = (c: (typeof cob)[number]) => {
    const vs = [c.diasDeCobertura, c.diasDeCobertura7d].filter((x): x is number => x !== null);
    return vs.length ? Math.min(...vs) : null;
  };
  const criticos = cob.filter((c) => {
    const p = pior(c);
    return p !== null && p <= 14;
  });
  const semReposicao = criticos.filter((c) => reposicao(c) === 0);

  if (criticos.length) {
    linha(
      doc,
      'Abaixo de 14 dias de cobertura',
      numero(criticos.length),
      semReposicao.length
        ? `${numero(semReposicao.length)} sem nenhuma reposição: ${semReposicao.map((c) => c.titulo).join(', ')}`
        : 'todos com reposição a caminho',
      RUIM,
    );
  }

  // Peça pronta no galpão sem entrada no site é venda parada por digitação,
  // não por falta de produção. Merece linha própria: é a correção mais barata
  // do relatório inteiro.
  const paradas = cob.filter((c) => c.prontasNoGalpao > 0);
  if (paradas.length) {
    linha(
      doc,
      'Prontas no galpão sem subir no site',
      numero(paradas.reduce((t, c) => t + c.prontasNoGalpao, 0)),
      paradas.map((c) => `${c.titulo} (${numero(c.prontasNoGalpao)})`).join(', '),
      RUIM,
    );
  }

  paragrafo(
    doc,
    'Cobertura é só o estoque da Shopify dividido pela saída média diária dos últimos 15 dias — ' +
      'peça que ainda não está no site não vende hoje. A saída conta todo pedido criado no ' +
      'período, não só o pago: troca, seeding e Pix ainda não compensado tiram peça da prateleira ' +
      'igual. Só o cancelado fica de fora, porque a peça volta. Por isso esta conta não bate com ' +
      'o faturamento, e não deve bater. '+
      '"No ritmo 7d" repete a conta só com a última semana: quando ele é bem menor que a cobertura, ' +
      'a peça acelerou e a média de 15 dias ainda não percebeu. "Reposição" é o que ainda vai virar ' +
      'estoque: corte, oficina e caseado mais os cortes no galpão, a partir de 30/03/2026, sem ' +
      '"subiu no site" no Corte Pro. Campeão com pouca cobertura e sem reposição é ruptura marcada.',
    TINTA3,
  );
}

/**
 * O dia hora a hora, contra o ritmo normal.
 *
 * Um acumulado sozinho não diz nada — "R$ 18 mil ao meio-dia" é bom ou ruim
 * conforme o que costuma haver ao meio-dia. Por isso cada corte vem ao lado da
 * média dos sete dias anteriores na MESMA hora, e o que interessa é a
 * diferença: se às 12h já estamos 20% abaixo, ainda dá tarde para reagir; se
 * descobrir isso só no boletim da manhã seguinte, não dá mais.
 */
/**
 * O que sobrou do dia.
 *
 * Fica logo depois de vendas porque é a pergunta que vendas levanta. A ordem
 * das linhas é a da conta, de cima para baixo, para ser conferível a olho: o
 * leitor consegue refazer a subtração sem calculadora.
 */
function secaoMargem(doc: Doc, d: DadosRelatorio) {
  const m = d.margem;
  if (!m || m.receita <= 0) return;

  titulo(doc, 'Margem do dia');

  const daReceita = (v: number) => pct(v / m.receita);

  linha(doc, 'Receita', dinheiro(m.receita));
  linha(
    doc,
    '(-) Custo das peças',
    dinheiro(m.cmv),
    `${daReceita(m.cmv)} da receita · ${numero(m.pecasComCusto)} peças` +
      (m.pecasSemCusto > 0 ? ` · ${numero(m.pecasSemCusto)} sem custo conhecido` : ''),
  );
  linha(doc, '(=) Margem bruta', dinheiro(m.margemBruta), daReceita(m.margemBruta), BOM);

  linha(doc, '(-) Mídia', dinheiro(m.midia), `${daReceita(m.midia)} da receita`);
  linha(
    doc,
    '(-) Taxa de pagamento',
    dinheiro(m.taxaDePagamento),
    `${daReceita(m.taxaDePagamento)} da receita` +
      (m.parcelasUsadas ? ` · cartão calculado em ${numero(m.parcelasUsadas)}x` : ''),
  );
  linha(
    doc,
    '(-) Taxa da plataforma',
    dinheiro(m.taxaDaPlataforma),
    `${numero(config().TAXA_PLATAFORMA_PCT, 2)}% da Shopify por usar gateway externo`,
  );
  linha(
    doc,
    '(-) Frete',
    m.custoDeFrete > 0 ? dinheiro(m.custoDeFrete) : 'não configurado',
    `cobrado da cliente: ${dinheiro(m.freteCobrado)}`,
    m.custoDeFrete > 0 ? TINTA : RUIM,
  );
  if (m.pecasDeSeeding > 0) {
    linha(
      doc,
      '(-) Peças de seeding',
      dinheiro(m.custoDoSeeding),
      `${numero(m.pecasDeSeeding)} peças a custo — saiu do estoque, não da verba de mídia`,
    );
  }

  linha(
    doc,
    '(=) Margem de contribuição',
    dinheiro(m.margemDeContribuicao),
    daReceita(m.margemDeContribuicao),
    m.margemDeContribuicao > 0 ? BOM : RUIM,
  );

  paragrafo(
    doc,
    'Contribuição, não lucro: falta o custo fixo — salários, aluguel, sistemas — que não é ' +
      'diário. O custo das peças vem do Corte Pro, do corte mais recente de cada modelo. ' +
      (m.parametrosFaltando.length
        ? `Ainda falta configurar ${m.parametrosFaltando.join(' e ')}, então a margem acima está ` +
          'otimista nesses pontos — o número real é menor.'
        : 'A taxa do cartão depende do parcelamento e a Shopify não informa em quantas parcelas ' +
          'a cliente pagou — só bandeira e final do cartão. Por isso o cálculo usa um número ' +
          'médio de parcelas, e ele é parâmetro, não medição.'),
    TINTA3,
  );
}

function secaoRitmo(doc: Doc, d: DadosRelatorio) {
  const horas = d.vendas.porHora;
  if (!horas?.length) return;

  titulo(doc, 'Ritmo do dia');

  const total = d.vendas.receita;
  const mediaDe = (h: number) => d.media7dPorHora.find((x) => x.hora === h);

  tabela(
    doc,
    ['Até as', 'Faturado', '% do dia', '% normal', 'Média 7d', 'Diferença'],
    horas.map((h) => {
      const m = mediaDe(h.hora);
      return [
        `${String(h.hora).padStart(2, '0')}h`,
        dinheiro(h.receita),
        total > 0 ? pct(h.receita / total) : '—',
        m && m.fracaoDoDia > 0 ? pct(m.fracaoDoDia) : '—',
        m && m.receita > 0 ? dinheiro(m.receita) : '—',
        m && m.receita > 0 ? variacao(h.receita, m.receita) : '—',
      ];
    }),
    [LARGURA - 390, 85, 60, 60, 85, 70],
    ['left', 'right', 'right', 'right', 'right', 'right'],
  );

  const meioDia = horas.find((h) => h.hora === 12);
  const m12 = mediaDe(12);
  if (meioDia && m12 && m12.receita > 0) {
    const dif = meioDia.receita / m12.receita - 1;
    linha(
      doc,
      'Leitura do meio-dia',
      variacao(meioDia.receita, m12.receita),
      dif < -0.15
        ? 'abaixo do ritmo — é a hora de mexer em mídia ou oferta'
        : dif > 0.15
          ? 'acima do ritmo'
          : 'dentro do normal',
      dif < -0.15 ? RUIM : dif > 0.15 ? BOM : TINTA,
    );

    // Adiantado não é o mesmo que forte: o dia pode estar na frente em reais e
    // ainda assim ter carregado tudo cedo, o que muda o que esperar da tarde.
    const fracaoHoje = total > 0 ? meioDia.receita / total : 0;
    if (m12.fracaoDoDia > 0 && fracaoHoje > 0) {
      const gap = fracaoHoje - m12.fracaoDoDia;
      if (Math.abs(gap) >= 0.05) {
        linha(
          doc,
          '  forma do dia',
          `${pct(fracaoHoje)} contra ${pct(m12.fracaoDoDia)}`,
          gap > 0
            ? 'o dia carregou cedo — a tarde tende a pesar menos que o normal'
            : 'o dia está atrasado — sobra mais para a tarde e a noite',
          TINTA,
        );
      }
    }
  }

  paragrafo(
    doc,
    'Acumulado até a hora cheia, pela data do pagamento: "até as 12h" é tudo que foi pago até ' +
      '11:59. Mesma régua do faturamento do dia — só pedido pago, sem troca, sem seeding, sem ' +
      'reenvio. "% normal" é a média das frações de cada um dos 7 dias anteriores na mesma hora, ' +
      'não a fração da média: assim dia fraco e dia forte pesam igual na forma da curva.',
    TINTA3,
  );
}

function secaoDesconto(doc: Doc, d: DadosRelatorio) {
  const v = d.vendas;
  const bruto = v.receita + v.desconto.total;
  titulo(doc, 'Desconto');

  const p = bruto > 0 ? v.desconto.total / bruto : 0;
  linha(doc, 'Desconto total', dinheiro(v.desconto.total), `${pct(p)} do bruto · 7d ${pct(d.media7d.descontoPct)}`);
  linha(doc, 'Promoção do site', dinheiro(v.desconto.promocaoAutomatica));
  linha(doc, 'Cupom de venda', dinheiro(v.desconto.cupom));
  linha(
    doc,
    'Seeding de influencer',
    dinheiro(v.desconto.seedingInfluencer),
    v.excluidos.influencers ? `${v.excluidos.influencers} pedido(s)` : 'nenhum no dia',
  );
  paragrafo(
    doc,
    'O seeding aparece separado porque é custo de mídia, não concessão de preço. ' +
      'Somado aos outros dois, faz a política comercial parecer pior do que é.',
    TINTA3,
  );

  if (v.cuponsMaisUsados.length) {
    tabela(
      doc,
      ['Cupom mais usado', 'Pedidos', 'Valor'],
      v.cuponsMaisUsados.map((c) => [c.codigo, numero(c.pedidos), dinheiro(c.valor)]),
      [LARGURA - 160, 80, 80],
      ['left', 'right', 'right'],
    );
  }

  const tro = v.trocasDoDia;
  titulo(doc, 'Trocas pagas no dia');
  linha(doc, 'Pedidos de troca', numero(tro.total), 'fora do faturamento, por definição');
  linha(
    doc,
    'Por cupom de troca',
    numero(tro.porCupom.pedidos),
    `${dinheiro(tro.porCupom.valor)} abatidos em cupom`,
  );
  linha(
    doc,
    'Troca direta',
    numero(tro.direta.pedidos),
    `${numero(tro.direta.pecas)} peças · ${dinheiro(tro.direta.valorAPrecoDeSite)} a preço de site`,
  );
  paragrafo(
    doc,
    'A troca direta chega do Troquecommerce com a peça a R$ 0,01, então o valor cobrado não diz nada. ' +
      'O que aparece aqui é quanto aquelas peças custariam na loja — a medida do que saiu do estoque. ' +
      'Só entram pedidos com pagamento confirmado no dia.',
    TINTA3,
  );
}

function secaoProdutos(doc: Doc, d: DadosRelatorio) {
  if (!d.vendas.topProdutos.length) return;
  titulo(doc, 'Produtos mais vendidos');
  tabela(
    doc,
    ['Peça', 'Peças', 'Receita', 'Ticket'],
    d.vendas.topProdutos.map((p) => [
      p.titulo,
      numero(p.pecas),
      dinheiro(p.receita),
      dinheiro(p.pecas > 0 ? p.receita / p.pecas : 0),
    ]),
    [LARGURA - 240, 80, 80, 80],
    ['left', 'right', 'right', 'right'],
  );
}

function secaoCategorias(doc: Doc, d: DadosRelatorio) {
  const cats = d.vendas.categorias;
  if (!cats.length) return;
  titulo(doc, 'Vendas por categoria');
  tabela(
    doc,
    ['Categoria', 'Peças', '% das peças', 'Receita'],
    cats.map((c) => [c.categoria, numero(c.pecas), pct(c.participacao), dinheiro(c.receita)]),
    [LARGURA - 260, 80, 90, 90],
    ['left', 'right', 'right', 'right'],
  );
  paragrafo(
    doc,
    'A categoria sai da primeira palavra do nome da peça. O productType está vazio na loja e a ' +
      'taxonomia da Shopify se contradiz: "Blazer Filadélfia" é Sport Jackets e "Blazer Alemanha" é Blazers.',
    TINTA3,
  );
}

function secaoTrafego(doc: Doc, d: DadosRelatorio) {
  const t = d.trafego;
  titulo(doc, 'Tráfego e funil');

  const varSessoes = variacao(t.sessoes, d.trafego7d.sessoes);
  linha(doc, 'Sessões', numero(t.sessoes), `vs média 7d ${varSessoes}`, corDaVariacao(varSessoes));
  linha(
    doc,
    'Adicionaram ao carrinho',
    numero(t.adicoesAoCarrinho),
    `${pct(t.taxaAdicao, 2)} das sessões · 7d ${pct(d.trafego7d.taxaAdicao, 2)}`,
  );
  linha(
    doc,
    'Iniciaram checkout',
    numero(t.checkoutsIniciados),
    t.adicoesAoCarrinho > 0
      ? `${pct(t.checkoutsIniciados / t.adicoesAoCarrinho)} de quem adicionou`
      : '',
  );
  linha(
    doc,
    'Concluíram checkout',
    numero(t.checkoutsConcluidos),
    t.checkoutsIniciados > 0
      ? `${pct(t.checkoutsConcluidos / t.checkoutsIniciados)} de quem iniciou`
      : '',
  );
  const varConv = variacao(t.conversao, d.trafego7d.conversao);
  linha(doc, 'Conversão', pct(t.conversao, 2), `vs média 7d ${varConv}`, corDaVariacao(varConv));

  const perda = t.checkoutsIniciados - t.checkoutsConcluidos;
  if (perda > 0) {
    paragrafo(
      doc,
      `${numero(perda)} checkouts iniciados e não concluídos. É onde o carrinho abandonado atua — ` +
        'compare com o número de disparos no bloco de atendimento.',
      TINTA3,
    );
  }
}

function secaoMidia(doc: Doc, d: DadosRelatorio) {
  if (!d.midia && !d.google) return;
  const m = d.midia;
  titulo(doc, 'Mídia');

  if (m) {
    linha(doc, 'Meta — valor pago', dinheiro(m.valorPago), `líquido ${dinheiro(m.gastoLiquido)} + imposto`);
    linha(doc, 'Meta — ROAS sobre o pago', numero(m.roas, 2), `como o Meta reporta: ${numero(m.roasMeta, 2)}`);
    linha(doc, 'Meta — compras atribuídas', numero(m.compras), `CPA ${dinheiro(m.cpa)} (líquido)`);
    linha(doc, 'Meta — leilão', `${dinheiroExato(m.cpm)} CPM`, `CPC ${dinheiroExato(m.cpc)} · só campanhas de venda`);
  }

  if (d.google) {
    linha(doc, 'Google — gasto', dinheiro(d.google.valorPago), 'sem imposto, por definição');
    linha(doc, 'Google — vendas e ROAS', dinheiro(d.google.receita), `ROAS ${numero(d.google.roas, 2)}`);
  } else {
    linha(doc, 'Google', 'não conectado');
  }

  const gastoTotal = (m?.valorPago ?? 0) + (d.google?.valorPago ?? 0);
  if (gastoTotal > 0) {
    linha(doc, 'Total investido no dia', dinheiro(gastoTotal), 'Meta com imposto + Google');
  }
  if (gastoTotal > 0 && d.vendas.receita > 0) {
    linha(
      doc,
      'ROAS total',
      numero(d.vendas.receita / gastoTotal, 2),
      `mídia = ${pct(gastoTotal / d.vendas.receita)} da receita`,
    );
  }

  if (d.google) {
    paragrafo(
      doc,
      'A receita do Google é atribuição dele, contada no dia do clique e não no dia do pagamento. ' +
        'Não bate com o faturamento do Shopify, e não deveria.',
      TINTA3,
    );
  }
}

function secaoCampanhas(doc: Doc, d: DadosRelatorio) {
  if (!d.campanhas.length) return;
  titulo(doc, 'Campanhas do Meta');

  const comGasto = d.campanhas.filter((c) => c.gastoLiquido > 0).slice(0, 10);
  tabela(
    doc,
    ['Campanha', 'Pago', 'Compras', 'ROAS', 'CPA'],
    comGasto.map((c) => [
      c.nome,
      dinheiro(c.valorPago),
      numero(c.compras),
      numero(c.roas, 2),
      c.compras > 0 ? dinheiro(c.cpa) : '—',
    ]),
    [LARGURA - 250, 70, 55, 55, 70],
    ['left', 'right', 'right', 'right', 'right'],
  );

  const semCompra = d.campanhas.filter((c) => c.compras === 0 && c.gastoLiquido > 0);
  if (semCompra.length) {
    const gasto = semCompra.reduce((s, c) => s + c.valorPago, 0);
    paragrafo(
      doc,
      `${semCompra.length} campanha(s) gastaram ${dinheiro(gasto)} sem nenhuma compra atribuída no dia.`,
      RUIM,
    );
  }
  paragrafo(
    doc,
    'Num único dia a maioria das campanhas tem uma ou duas compras, e um CPA sobre uma compra não ' +
      'significa nada. Olhe o gasto junto antes de coroar a de melhor CPA.',
    TINTA3,
  );
}

function secaoTrocas(doc: Doc, d: DadosRelatorio) {
  const t = d.reversas;
  if (!t) return;
  titulo(doc, 'Trocas e devoluções');

  linha(
    doc,
    'Abertas no dia',
    numero(t.abertas),
    `${t.aberturasPorTipo.troca} troca · ${t.aberturasPorTipo.estorno} estorno` +
      (t.aberturasPorTipo.sem_reembolso ? ` · ${t.aberturasPorTipo.sem_reembolso} sem reembolso` : ''),
  );
  linha(doc, 'Concluídas no dia', numero(t.concluidas), `${numero(t.canceladas)} canceladas`);
  linha(doc, 'Diferença recebida', dinheiro(t.valorTroca), 'o que a cliente pagou a mais na troca');
  linha(doc, 'Estornado', dinheiro(t.valorEstorno), `retido em crédito ${dinheiro(t.valorRetido)}`);
  linha(
    doc,
    'Abertas há mais de 30 dias',
    numero(t.envelhecidas),
    t.gargalo ? `maior fila: ${t.gargalo.status} (${numero(t.gargalo.total)})` : '',
    t.envelhecidas > 0 ? RUIM : TINTA,
  );
  linha(doc, 'Esperando a cliente postar há +7 dias', numero(t.travadas));

  if (d.estornos) {
    const c = d.estornos;
    titulo(doc, 'Conferência de estorno');
    linha(
      doc,
      'Reembolsado na Shopify',
      dinheiro(c.shopify.valor),
      c.shopify.pendente > 0
        ? `${numero(c.shopify.quantidade)} reembolso(s) · ${dinheiro(c.shopify.pendente)} emitido e pendente no adquirente`
        : `${numero(c.shopify.quantidade)} reembolso(s) processados no dia`,
    );
    linha(
      doc,
      'Finalizado no Troquecommerce',
      dinheiro(c.troque.valor),
      `${numero(c.troque.quantidade)} reversa(s)`,
    );
    if (c.aguardandoPagamento.quantidade > 0) {
      linha(
        doc,
        'Aprovado e não pago',
        dinheiro(c.aguardandoPagamento.valor),
        `${numero(c.aguardandoPagamento.quantidade)} reversa(s) em "Aguardando Pagamento" — fila, não divergência`,
      );
    }

    const divergentes = c.soShopify.length + c.soTroque.length + c.valorDiferente.length;
    linha(
      doc,
      'Pedidos divergentes',
      numero(divergentes),
      divergentes === 0
        ? `os dois lados batem nos ${numero(c.batem)} pedidos conferidos`
        : `${numero(c.batem)} conferidos batem`,
      divergentes > 0 ? RUIM : TINTA,
    );

    if (divergentes > 0) {
      const linhas: string[][] = [];
      for (const x of c.soShopify) {
        linhas.push([x.pedido, 'Só na Shopify', x.situacao, dinheiro(x.valor)]);
      }
      for (const x of c.soTroque) {
        linhas.push([x.pedido, 'Só no Troquecommerce', 'finalizado sem saída na Shopify', dinheiro(x.valor)]);
      }
      for (const x of c.valorDiferente) {
        linhas.push([
          x.pedido,
          'Valor diferente',
          `Shopify ${dinheiro(x.shopify)} contra Troque ${dinheiro(x.troque)}`,
          dinheiro(x.diferenca),
        ]);
      }
      tabela(
        doc,
        ['Pedido', 'Divergência', 'Situação', 'Valor'],
        linhas,
        [70, 120, LARGURA - 280, 90],
        ['left', 'left', 'left', 'right'],
      );
    }

    paragrafo(
      doc,
      'Reversa finalizada no Troquecommerce não quer dizer que o dinheiro saiu, e reembolso na ' +
        'Shopify não quer dizer que a reversa foi fechada. A conferência é pedido a pedido: ' +
        'reembolso feito em outro dia é procurado pelo número do pedido antes de virar divergência.',
      TINTA3,
    );
  }

  if (t.motivos.length) {
    const total = t.motivos.reduce((s, m) => s + m.total, 0);
    tabela(
      doc,
      ['Motivo declarado', 'Itens', 'Peso'],
      t.motivos
        .slice(0, 8)
        .map((m) => [m.motivo, numero(m.total), pct(total > 0 ? m.total / total : 0, 0)]),
      [LARGURA - 140, 70, 70],
      ['left', 'right', 'right'],
    );
  }

  if (t.pares.length) {
    paragrafo(doc, 'O que voltou e o que saiu no lugar:', TINTA2);
    for (const p of t.pares.slice(0, 8)) {
      garantirEspaco(doc, 22);
      doc
        .font('Helvetica')
        .fontSize(8.5)
        .fillColor(TINTA)
        .text(`${p.devolveu}  ->  ${p.levou}${p.motivo ? `   (${p.motivo})` : ''}`, MARGEM, doc.y, {
          width: LARGURA,
        });
      if (p.comentario) {
        doc
          .font('Helvetica-Oblique')
          .fontSize(8)
          .fillColor(TINTA3)
          .text(`“${p.comentario.trim()}”`, MARGEM + 12, doc.y + 1, { width: LARGURA - 12 });
      }
      doc.moveDown(0.35);
    }
  }
}

function secaoOperacao(doc: Doc, d: DadosRelatorio) {
  if (!d.atendimento && !d.producao) return;
  titulo(doc, 'Operação');

  if (d.atendimento) {
    const a = d.atendimento;
    linha(
      doc,
      'Conversas aguardando',
      numero(a.aguardando),
      a.porCanal.map((c) => `${c.total} ${c.canal}`).join(' · '),
    );
    for (const x of a.porAtendente) linha(doc, `  ${x.nome}`, numero(x.total));
    if (a.semAtendente > 0) {
      linha(doc, '  sem atendente atribuído', numero(a.semAtendente), '', RUIM);
    }
    if (a.carrinhos) {
      const c = a.carrinhos;
      linha(
        doc,
        'Abandonados na loja',
        numero(c.naLoja.total),
        `${numero(c.naLoja.comTelefone)} com telefone · ${dinheiro(c.naLoja.valor)} em carrinho`,
      );
      linha(
        doc,
        'Chegaram na régua',
        numero(c.noAtendimento.total),
        `${numero(c.noAtendimento.disparados)} disparados pela automação`,
      );
      linha(
        doc,
        '  não chegou no WhatsApp',
        numero(c.noAtendimento.naoChegaram),
        c.noAtendimento.disparados
          ? `${pct(c.noAtendimento.naoChegaram / c.noAtendimento.disparados, 0)} dos disparos · número inválido, bloqueado ou fora do WhatsApp`
          : '',
        c.noAtendimento.naoChegaram > 0 ? RUIM : BOM,
      );
      if (c.noAtendimento.naFila > 0) {
        linha(doc, '  ainda na fila', numero(c.noAtendimento.naFila));
      }
      linha(
        doc,
        '  compraram depois do disparo',
        numero(c.noAtendimento.compraramDepois),
        c.noAtendimento.responderam > 0 ? `${numero(c.noAtendimento.responderam)} responderam` : '',
        BOM,
      );
      linha(
        doc,
        'Ficaram fora da régua',
        numero(c.semCarrinho.length),
        c.semCarrinho.length
          ? `com telefone, ainda abandonados, sem carrinho no atendimento · ${dinheiro(c.semCarrinho.reduce((t, x) => t + x.valor, 0))}`
          : 'todo abandonado com telefone virou carrinho',
        c.semCarrinho.length > 0 ? RUIM : BOM,
      );
      paragrafo(
        doc,
        'A conferência é checkout a checkout, pelo token da URL de recuperação — contar total ' +
          'contra total não fecha nunca: a Shopify tira da lista o checkout que virou pedido, e o ' +
          'AtendePro filtra por data UTC, o que jogava três horas do dia anterior para dentro da ' +
          'conta. "Ficaram fora da régua" é a única pergunta sem ambiguidade: a cliente abandonou, ' +
          'tinha telefone, não comprou, e mesmo assim não existe carrinho no atendimento. Só o ' +
          'disparo automático entra aqui; mensagem que a atendente manda na mão vive na conversa.',
        TINTA3,
      );
    }
    if (a.npsSeteDias !== null) {
      linha(doc, 'NPS 7 dias', numero(a.npsSeteDias), `${numero(a.npsRespostas)} respostas`);
    }

    if (a.reguas.length) {
      garantirEspaco(doc, 120);
      tabela(
        doc,
        ['Régua de WhatsApp', 'Enviadas', 'Falhas', 'Compras', 'Receita'],
        a.reguas.map((r) => [
          r.nome,
          numero(r.enviadas),
          `${numero(r.falhas)}${r.recusasNoEnvio > 0 ? ` (${numero(r.recusasNoEnvio)} recusadas)` : ''}`,
          numero(r.conversoes),
          r.receita > 0 ? dinheiro(r.receita) : '—',
        ]),
        [LARGURA - 300, 70, 95, 65, 70],
        ['left', 'right', 'right', 'right', 'right'],
      );

      const enviadas = a.reguas.reduce((t, r) => t + r.enviadas, 0);
      const falhas = a.reguas.reduce((t, r) => t + r.falhas, 0);
      const recusas = a.reguas.reduce((t, r) => t + r.recusasNoEnvio, 0);
      const receita = a.reguas.reduce((t, r) => t + r.receita, 0);

      linha(
        doc,
        'Total das réguas',
        numero(enviadas),
        `${pct(falhas / Math.max(1, enviadas + falhas), 0)} de falha · ${dinheiro(receita)} atribuídos`,
        falhas / Math.max(1, enviadas + falhas) > 0.15 ? RUIM : TINTA,
      );

      paragrafo(
        doc,
        'A receita é atribuição do AtendePro, não venda nova medida: conta o pedido pago no dia ' +
          'por uma cliente que recebeu mensagem daquela régua nos 30 dias anteriores, creditado à ' +
          'última etapa enviada antes da compra. A mensagem não precisa ser do dia. Pedido de ' +
          'troca fica de fora. Como não existe grupo de controle — ninguém na base deixa de ' +
          'receber — não dá para saber quanto dessa venda aconteceria de qualquer jeito, e a ' +
          'mesma compra provavelmente também está atribuída ao Meta. Trate como indício de que a ' +
          'régua está viva, não como receita incremental.',
        TINTA3,
      );

      paragrafo(
        doc,
        'Falha aqui é quase sempre entrega: a Meta aceitou a mensagem e ela não chegou — número ' +
          'inválido, bloqueado ou sem WhatsApp. É atrito de base, não defeito de configuração. ' +
          (recusas > 0
            ? `${numero(recusas)} foram recusadas no envio, e essas sim são problema de template, variável ou conta.`
            : 'Nenhuma foi recusada no envio, então template e conta estão de pé.'),
        TINTA3,
      );
    }
  }

  if (d.producao) {
    const p = d.producao;
    // Ou o bloco de producao cabe inteiro, ou vai junto para a proxima pagina.
    garantirEspaco(doc, 60);
    linha(doc, 'Cortes na oficina', numero(p.naOficina), `${numero(p.pecasNaOficina)} peças`);
    linha(doc, 'Cortes atrasados', numero(p.atrasados), '', p.atrasados > 0 ? RUIM : TINTA);
    if (p.maisCritico) {
      linha(
        doc,
        '  mais crítico',
        p.maisCritico,
        p.diasDeAtrasoDoMaisCritico ? `${numero(p.diasDeAtrasoDoMaisCritico)} dias` : '',
        RUIM,
      );
    }
  }
}

function secaoLeitura(doc: Doc, d: DadosRelatorio) {
  if (!d.leitura) return;
  titulo(doc, 'Leitura do dia');
  doc.font('Helvetica').fontSize(9.5).fillColor(TINTA).text(d.leitura.trim(), MARGEM, doc.y, {
    width: LARGURA,
    lineGap: 3,
    align: 'justify',
  });
}

export function rodape(doc: Doc, rotulo = 'boletim completo') {
  const total = doc.bufferedPageRange().count;
  for (let i = 0; i < total; i++) {
    doc.switchToPage(i);
    // Escrever abaixo da margem inferior faz o PDFKit criar pagina nova e o
    // rodape sumir. Zerar a margem enquanto desenha ocupa a faixa de baixo sem
    // disparar a quebra.
    doc.page.margins.bottom = 0;
    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor(TINTA3)
      .text(
        `L&F · ${rotulo} · página ${i + 1} de ${total}`,
        MARGEM,
        doc.page.height - MARGEM + 6,
        { width: LARGURA, align: 'center' },
      );
    doc.page.margins.bottom = MARGEM;
  }
}

/* ------------------------------------------------------------------ *
 * Montagem
 * ------------------------------------------------------------------ */

export function gerarPdf(d: DadosRelatorio): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // `bufferPages` é o que permite escrever "página 2 de 5": sem ele, o total
    // só se sabe quando o documento já foi fechado.
    const doc = new PDFDocument({ size: 'A4', margin: MARGEM, bufferPages: true });

    const pedacos: Buffer[] = [];
    doc.on('data', (c: Buffer) => pedacos.push(c));
    doc.on('end', () => resolve(Buffer.concat(pedacos)));
    doc.on('error', reject);

    cabecalho(doc, d);
    indicadores(doc, d);
    grafico(doc, d);
    secaoVendas(doc, d);
    secaoClientes(doc, d);
    secaoDesconto(doc, d);
    secaoProdutos(doc, d);
    secaoMargem(doc, d);
    secaoRitmo(doc, d);
    secaoPatrimonio(doc, d);
    secaoEstoque(doc, d);
    secaoCategorias(doc, d);
    secaoTrafego(doc, d);
    secaoMidia(doc, d);
    secaoCampanhas(doc, d);
    secaoTrocas(doc, d);
    secaoOperacao(doc, d);
    secaoLeitura(doc, d);
    rodape(doc);

    doc.end();
  });
}

export function nomeDoArquivo(dia: string): string {
  return `lf-boletim-${dia}.pdf`;
}
