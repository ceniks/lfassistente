/**
 * Lê o comprovante que a atendente anexou no pedido.
 *
 * O problema que isto resolve: pedido pago à mão não tem identificador de
 * pagamento, então o conferidor procurava por coincidência de valor — e
 * errava nos dois casos que aparecem toda semana. O #140812 foi pago na
 * véspera por link, fora da janela do dia. O #140825 foi pago em dois Pix,
 * 425,74 no Mercado Pago e 339,55 direto na conta, e nenhum lançamento tinha
 * o valor cheio de 765,29.
 *
 * O comprovante resolve os dois porque diz as três coisas que faltavam: o
 * valor de cada parte, a hora exata e **para qual instituição** o dinheiro
 * foi. Com isso a busca deixa de ser adivinhação e vira verificação: procurar
 * 425,74 no Mercado Pago no dia 22, não procurar 765,29 em todo lugar.
 *
 * O que este módulo NÃO faz: confiar no comprovante. Ele é um documento que a
 * cliente mandou por WhatsApp — pode ser de outro pedido, pode ser montagem.
 * Aqui ele só diz onde procurar; quem confirma é sempre o gateway ou o
 * extrato.
 */

/** Para onde o comprovante diz que o dinheiro foi. */
export type Trilho =
  | "mercadopago"
  | "pagbank"
  | "pagarme"
  | "link"
  | "desconhecido";

export interface Comprovante {
  arquivo: string;
  valor: number;
  /** "2026-09-22 13:49:27", na hora que está impressa no documento. */
  quando: string;
  dia: string;
  trilho: Trilho;
  /** Instituição como está escrita no documento, para o relatório. */
  instituicao: string;
  /** Código da transação, quando o comprovante traz (links de pagamento). */
  codigo: string | null;
}

/**
 * O texto do PDF.
 *
 * Mesmo caminho dos holerites: o build `legacy` do pdfjs é o que roda em Node
 * sem DOM, e o import é dinâmico para não atrasar a subida do serviço.
 * Depender de `pdftotext` instalado no container não é opção — no Railway ele
 * não existe.
 */
export async function textoDePdf(pdf: Buffer): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(pdf),
    useSystemFonts: true,
  }).promise;

  const partes: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const pagina = await doc.getPage(i);
    const conteudo = await pagina.getTextContent();
    partes.push(
      conteudo.items
        .map((it) => ("str" in it ? it.str : ""))
        .join(" ")
        .replace(/\s+/g, " "),
    );
  }
  return partes.join("\n");
}

/** "1.289,09" -> 1289.09 */
function numeroBr(txt: string): number {
  return Number(txt.replace(/\./g, "").replace(",", "."));
}

/**
 * De onde é a conta que recebeu.
 *
 * O nome do banco no comprovante é o do **destino**, e é isso que distingue os
 * dois Pix do #140825: um foi para "MERCADO PAGO IP LTDA." e o outro para
 * "PAGSEGURO INTERNET IP S.A.". O primeiro é gateway e se confere na API do
 * Mercado Pago; o segundo caiu na conta da empresa e se confere no extrato.
 */
function trilhoDe(texto: string): { trilho: Trilho; instituicao: string } {
  const t = texto.toUpperCase();

  if (/MERCADO\s*PAGO/.test(t)) return { trilho: "mercadopago", instituicao: "Mercado Pago" };
  if (/PAGSEGURO|PAGBANK/.test(t)) return { trilho: "pagbank", instituicao: "PagBank" };
  if (/PAGAR\.?\s?ME/.test(t)) return { trilho: "pagarme", instituicao: "Pagar.me" };

  /*
   * Recibo de link de pagamento não nomeia o adquirente em lugar nenhum — o
   * do #140812 só diz "Link de Pagamento" e "Vendido por: L F FASHION". O que
   * ele tem é o código da transação, que é prova melhor que qualquer nome:
   * procura-se esse código nos adquirentes, sem depender de valor.
   */
  if (/LINK DE PAGAMENTO|C[ÓO]DIGO DA TRANSA[ÇC][ÃA]O/.test(t)) {
    return { trilho: "link", instituicao: "link de pagamento" };
  }

  return { trilho: "desconhecido", instituicao: "" };
}

/**
 * Extrai o que importa de um comprovante.
 *
 * Dois formatos reais, e um padrão para cada: o comprovante de Pix do banco
 * ("R$ 425,74 … 22/09/2026 às 13:49:27") e o recibo de link de pagamento
 * ("Valor do pagamento R$ 1.289,09 … Data do pagamento: 25/09/2026 às
 * 22:07:11 … Código da transação: <uuid>"). Documento que não caia em nenhum
 * dos dois devolve `null` — comprovante ilegível não deve virar casamento
 * inventado.
 */
export function lerComprovante(arquivo: string, texto: string): Comprovante | null {
  const valores = [...texto.matchAll(/R\$\s*([\d.]+,\d{2})/g)].map((m) => numeroBr(m[1]));
  const data = texto.match(/(\d{2})\/(\d{2})\/(\d{4})\s*(?:às|as)?\s*(\d{2}:\d{2}(?::\d{2})?)/);
  if (!valores.length || !data) return null;

  const [, dd, mm, aaaa, hora] = data;
  const dia = `${aaaa}-${mm}-${dd}`;
  const codigo =
    texto.match(/C[óo]digo da transa[çc][ãa]o:?\s*([A-Za-z0-9-]{8,})/)?.[1] ?? null;

  return {
    arquivo,
    // O maior valor do documento é o do pagamento: recibo de link repete o
    // valor no total e nos itens, e taxa nunca é o maior número da página.
    valor: Math.max(...valores),
    quando: `${dia} ${hora.length === 5 ? `${hora}:00` : hora}`,
    dia,
    codigo,
    ...trilhoDe(texto),
  };
}

/** Baixa e lê um anexo. Arquivo que não abre não derruba a conferência. */
export async function lerAnexo(
  arquivo: string,
  url: string,
): Promise<Comprovante | null> {
  if (!/\.pdf$/i.test(arquivo)) return null;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) return null;
    const texto = await textoDePdf(Buffer.from(await r.arrayBuffer()));
    return lerComprovante(arquivo, texto);
  } catch {
    return null;
  }
}
