/**
 * Divide o PDF de holerites em um arquivo por funcionária.
 *
 * O PDF da contabilidade vem com todo mundo junto, e a pergunta difícil não é
 * cortar páginas — é saber de quem é cada página. Duas decisões:
 *
 * **O nome sai do texto da página, não da ordem.** Confiar em "uma página por
 * pessoa" quebra no primeiro holerite de duas páginas, e o erro é silencioso:
 * manda o contracheque de alguém para outra pessoa. Como o nome vem escrito em
 * toda página, ele é a chave; páginas seguidas com o mesmo nome viram um
 * arquivo só.
 *
 * **Página sem nome reconhecido não é chutada.** Ela fica na lista de
 * pendências e ninguém recebe até alguém olhar. Holerite é documento com
 * salário dentro: errar o destinatário é pior do que não enviar.
 */
import { PDFDocument } from "pdf-lib";

export interface Holerite {
  nome: string;
  paginas: number[];
  pdf: Buffer;
}

export interface Divisao {
  holerites: Holerite[];
  /** Páginas cujo nome não foi reconhecido — ninguém recebe até serem vistas. */
  paginasSemNome: number[];
  /** Páginas idênticas a outras: via repetida, contada uma vez só. */
  paginasRepetidas: number[];
  totalDePaginas: number;
}

/**
 * Onde o nome costuma estar num holerite brasileiro.
 *
 * A ordem importa: a primeira que casar vence. Todas pegam o nome depois de um
 * rótulo, porque o nome solto no meio da página seria confundido com o da
 * empresa, que aparece no cabeçalho de toda folha.
 */
const PADROES = [
  /*
   * Folha em tabela, sem rótulo: a linha é "16 ADRIANA DAYANE DE PAULA VAZ
   * 763325 0 0 0 1" — código, nome em caixa alta e o CBO de seis dígitos. É o
   * formato da contabilidade da L&F (conferido no recibo de agosto/2026), e
   * vem primeiro porque nessa folha a palavra "Nome" é só cabeçalho de coluna:
   * casar por rótulo pegaria a linha errada.
   */
  /^\s*\d{1,6}\s+([A-ZÀ-Ú][A-ZÀ-Ú'.\- ]{4,}?)\s+\d{6}\b/m,
  /nome\s+do\s+funcion[aá]rio[:\s]+([^\n]+)/i,
  /nome\s+d[oa]\s+colaborador[ea]?[:\s]+([^\n]+)/i,
  /funcion[aá]ri[oa]\s*\(?a?\)?[:\s]+([^\n]+)/i,
  /colaborador[ea]?[:\s]+([^\n]+)/i,
  /\bnome[:\s]+([^\n]+)/i,
];

/** Lixo que costuma vir grudado no nome na mesma linha. */
const CORTES = [
  /\s{2,}(cbo|cpf|c[oó]digo|matr[ií]cula|fun[cç][aã]o|admiss[aã]o|cargo|setor)\b.*$/i,
  /\s+cpf[:\s].*$/i,
];

export function nomeDaPagina(texto: string): string | null {
  for (const padrao of PADROES) {
    const achado = texto.match(padrao);
    if (!achado) continue;
    let nome = achado[1] ?? "";
    for (const corte of CORTES) nome = nome.replace(corte, "");
    nome = nome.replace(/\s+/g, " ").trim();
    // Nome de gente tem pelo menos duas palavras e não é só número.
    if (nome.split(" ").length >= 2 && /\p{L}{2}/u.test(nome)) return nome;
  }
  return null;
}

/** O texto de cada página, na ordem. Índice 0 é a página 1. */
export async function textoPorPagina(pdf: Buffer): Promise<string[]> {
  // O build "legacy" é o que roda em Node sem DOM. O import é dinâmico porque
  // o pacote só existe em ESM e carregá-lo no topo atrasaria todo o serviço.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(pdf),
    useSystemFonts: true,
  }).promise;

  const paginas: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const pagina = await doc.getPage(i);
    const conteudo = await pagina.getTextContent();

    /*
     * Reconstruir a linha pelo Y, não apenas concatenar os pedaços. O extrator
     * devolve fragmentos soltos e, sem agrupar, "Nome" e o nome em si podem
     * cair separados por metade da página — e o rótulo deixa de casar.
     */
    const linhas = new Map<number, Array<{ x: number; txt: string }>>();
    for (const item of conteudo.items as Array<{
      str?: string;
      transform?: number[];
    }>) {
      if (!item.str?.trim()) continue;
      const y = Math.round((item.transform?.[5] ?? 0) / 2) * 2;
      const x = item.transform?.[4] ?? 0;
      linhas.set(y, [...(linhas.get(y) ?? []), { x, txt: item.str }]);
    }

    const texto = [...linhas.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([, pedacos]) =>
        pedacos
          .sort((a, b) => a.x - b.x)
          .map((p) => p.txt)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .join("\n");

    paginas.push(texto);
  }

  await doc.cleanup();
  return paginas;
}

export async function dividir(pdf: Buffer): Promise<Divisao> {
  const paginas = await textoPorPagina(pdf);
  const origem = await PDFDocument.load(pdf);

  const grupos: Array<{ nome: string; paginas: number[] }> = [];
  const paginasSemNome: number[] = [];
  const paginasRepetidas: number[] = [];
  const jaVistas = new Set<string>();

  paginas.forEach((texto, i) => {
    // Página idêntica a outra é via repetida, não holerite a mais. No recibo de
    // agosto/2026 a folha da Aline veio duplicada; sem isto ela receberia o
    // mesmo contracheque duas vezes no anexo.
    const assinatura = texto.replace(/\s+/g, " ").trim();
    if (assinatura && jaVistas.has(assinatura)) {
      paginasRepetidas.push(i + 1);
      return;
    }
    jaVistas.add(assinatura);

    const nome = nomeDaPagina(texto);
    if (!nome) {
      paginasSemNome.push(i + 1);
      return;
    }
    const ultimo = grupos.at(-1);
    // Páginas seguidas da mesma pessoa são o mesmo holerite (verso, segunda
    // via). Pessoa que reaparece mais adiante ganha grupo novo, e os dois são
    // juntados no fim — é o caso de folha e 13º no mesmo arquivo.
    if (ultimo && ultimo.nome === nome) ultimo.paginas.push(i);
    else grupos.push({ nome, paginas: [i] });
  });

  const porNome = new Map<string, number[]>();
  for (const g of grupos) {
    porNome.set(g.nome, [...(porNome.get(g.nome) ?? []), ...g.paginas]);
  }

  const holerites: Holerite[] = [];
  for (const [nome, indices] of porNome) {
    const destino = await PDFDocument.create();
    const copiadas = await destino.copyPages(origem, indices);
    for (const p of copiadas) destino.addPage(p);
    holerites.push({
      nome,
      paginas: indices.map((i) => i + 1),
      pdf: Buffer.from(await destino.save()),
    });
  }

  return {
    holerites,
    paginasSemNome,
    paginasRepetidas,
    totalDePaginas: paginas.length,
  };
}
