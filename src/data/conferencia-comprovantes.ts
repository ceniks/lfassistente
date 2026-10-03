/**
 * Confere pedido pago à mão pelo comprovante que a atendente anexou.
 *
 * O conferidor por valor erra em dois casos que se repetem toda semana:
 *
 *  - **pagamento da véspera** — link pago às 22h de ontem, pedido criado hoje.
 *    A busca no dia do pedido não alcança. (#140812, R$ 1.289,09)
 *  - **pagamento dividido** — a cliente paga em duas transferências, às vezes
 *    em trilhos diferentes. Nenhum lançamento tem o valor cheio, e o pedido
 *    aparece como sem contrapartida mesmo com o dinheiro todo na conta.
 *    (#140825, R$ 425,74 no Mercado Pago + R$ 339,55 direto na conta)
 *
 * Os dois se resolvem lendo o documento: ele diz o valor de cada parte, a hora
 * e para qual instituição o dinheiro foi. Aí cada parte é procurada no trilho
 * e no dia que ela mesma declara.
 *
 * A regra que mantém isso honesto: **o comprovante nunca confirma nada**. Ele
 * é um PDF que chegou por WhatsApp. O que ele faz é dizer onde procurar; quem
 * confirma é o gateway ou o extrato, e um lançamento já reivindicado por outro
 * pedido não pode ser reivindicado de novo.
 */
import { anexosDePedidos } from "./shopify.js";
import { lerAnexo, type Comprovante } from "./comprovantes.js";
import { entradasPix, temOpenFinance } from "./openfinance.js";
import { pagamentosDoDia } from "./mercadopago.js";
import { temPagBank, transacoesDoDia } from "./pagbank.js";
import { pedidosDoDia, temPagarme } from "./pagarme.js";
import type { ConferenciaManual, PedidoManual } from "./conferencia-manual.js";

const TOLERANCIA = 0.01;

export interface ComprovanteConferido extends Comprovante {
  /** Encontrado no trilho que o próprio comprovante declara. */
  casou: boolean;
  /** Identificador do lançamento que o confirmou. */
  lancamento: string | null;
  /** Quando não casou, o que foi procurado e não estava lá. */
  nota?: string;
}

export interface PedidoComComprovante {
  pedido: string;
  valor: number;
  comprovantes: ComprovanteConferido[];
  /** Soma das partes efetivamente localizadas. */
  confirmado: number;
  /** O confirmado cobre o valor do pedido. */
  fecha: boolean;
  /**
   * Os outros pedidos que dividem o mesmo pagamento.
   *
   * A cliente monta dois pedidos e paga os dois num Pix só, anexando o mesmo
   * comprovante nos dois — foi o caso do #141585 e do #141586, R$ 801,74 e
   * R$ 559,80 num Pix de R$ 1.361,54. Sem isto, o primeiro fechava, o segundo
   * saía como "não há lançamento desse valor" e o valor do comprovante não
   * batia com nenhum dos dois.
   */
  junto: string[];
}

export interface ConferenciaComprovantes {
  dia: string;
  pedidos: PedidoComComprovante[];
  /** Pedidos pendentes que não têm comprovante anexado. */
  semComprovante: string[];
  confirmado: number;
}

const perto = (a: number, b: number) => Math.abs(a - b) <= TOLERANCIA;

/** O dia do comprovante, e o de antes e o de depois — fuso e virada de dia. */
const emVolta = (dia: string) => {
  const d = (n: number) => {
    const x = new Date(`${dia}T12:00:00-03:00`);
    x.setDate(x.getDate() + n);
    return x.toISOString().slice(0, 10);
  };
  return [d(-1), dia, d(1)];
};

/**
 * Procura uma parte no trilho que ela declara.
 *
 * `usados` atravessa todas as buscas do dia: o mesmo Pix não pode fechar dois
 * pedidos, que é como uma conferência por valor produz falso positivo. A
 * exceção é o pagamento compartilhado, tratado em `conferirComprovantes`: lá o
 * lançamento é procurado **uma vez** para o grupo inteiro.
 */
async function procurar(
  c: Comprovante,
  usados: Set<string>,
): Promise<{ casou: boolean; lancamento: string | null; nota?: string }> {
  const naoAchou = (onde: string) => ({
    casou: false,
    lancamento: null,
    nota: `o comprovante diz ${onde}, e não há lançamento desse valor lá`,
  });

  if (c.trilho === "mercadopago") {
    for (const dia of emVolta(c.dia)) {
      const achado = (await pagamentosDoDia(dia).catch(() => []))
        .filter((t) => t.valeComoVenda && perto(t.bruto, c.valor))
        .find((t) => !usados.has(t.codigo));
      if (achado) {
        usados.add(achado.codigo);
        return { casou: true, lancamento: achado.codigo };
      }
    }
    return naoAchou("Mercado Pago");
  }

  if (c.trilho === "pagbank") {
    /*
     * Dois destinos possíveis com o mesmo nome no comprovante: a maquininha e
     * os links caem nas transações do PagBank; o Pix cai na conta e só aparece
     * no extrato. Procuramos nos dois, começando pelo código da transação
     * quando o comprovante traz um — é a única prova direta que existe aqui.
     */
    if (temPagBank()) {
      for (const dia of emVolta(c.dia)) {
        const doDia = await transacoesDoDia(dia).catch(() => []);
        const porCodigo = c.codigo
          ? doDia.find((t) => t.codigo?.toUpperCase() === c.codigo?.toUpperCase())
          : undefined;
        const achado =
          porCodigo ??
          doDia.filter((t) => t.valeComoVenda && perto(t.bruto, c.valor)).find((t) => !usados.has(t.codigo));
        if (achado) {
          usados.add(achado.codigo);
          return { casou: true, lancamento: achado.codigo };
        }
      }
    }
    if (temOpenFinance()) {
      const [de, , ate] = emVolta(c.dia);
      const achado = (await entradasPix(de, ate).catch(() => []))
        .filter((e) => perto(e.valor, c.valor))
        .find((e) => !usados.has(e.id));
      if (achado) {
        usados.add(achado.id);
        return { casou: true, lancamento: achado.id };
      }
    }
    return naoAchou("PagBank/PagSeguro");
  }

  /*
   * Link de pagamento: o recibo não diz o adquirente, mas traz o código da
   * transação. Procuramos esse código nos dois, e só ele — valor igual em
   * adquirente que o comprovante não nomeia não é prova de nada.
   */
  if (c.trilho === "link" && c.codigo) {
    const alvo = c.codigo.toUpperCase();
    for (const dia of emVolta(c.dia)) {
      if (temPagBank()) {
        const achado = (await transacoesDoDia(dia).catch(() => [])).find(
          (t) => t.codigo?.toUpperCase() === alvo,
        );
        if (achado && !usados.has(achado.codigo)) {
          usados.add(achado.codigo);
          return { casou: true, lancamento: achado.codigo };
        }
      }
      if (temPagarme()) {
        const achado = (await pedidosDoDia(dia).catch(() => [])).find(
          (p) => p.pago && p.codigo?.toUpperCase() === alvo,
        );
        if (achado && !usados.has(achado.id)) {
          usados.add(achado.id);
          return { casou: true, lancamento: achado.id };
        }
      }
    }
    return {
      casou: false,
      lancamento: null,
      nota: `nenhum adquirente tem a transação ${c.codigo.slice(0, 8)}…`,
    };
  }

  if (c.trilho === "pagarme" && temPagarme()) {
    for (const dia of emVolta(c.dia)) {
      const achado = (await pedidosDoDia(dia).catch(() => []))
        .filter((p) => p.pago && perto(p.valor, c.valor))
        .find((p) => !usados.has(p.id));
      if (achado) {
        usados.add(achado.id);
        return { casou: true, lancamento: achado.id };
      }
    }
    return naoAchou("Pagar.me");
  }

  return {
    casou: false,
    lancamento: null,
    nota: "o comprovante não diz para qual instituição o dinheiro foi",
  };
}

/** Quem ainda deve explicação depois das conferências de gateway. */
const pendente = (v: PedidoManual) =>
  v.categoria === "venda" && (v.semRastro > TOLERANCIA || v.situacao === "pix-direto");

const devidoDe = (v: PedidoManual) =>
  v.situacao === "pix-direto" ? v.valor : v.semRastro;

/** O que identifica um pagamento, para saber que dois pedidos dividem o mesmo. */
export const chaveDoComprovante = (c: Comprovante) =>
  `${c.trilho}|${c.quando}|${c.valor.toFixed(2)}`;

export async function conferirComprovantes(
  dia: string,
  manual: ConferenciaManual | null,
): Promise<ConferenciaComprovantes | null> {
  if (!manual) return null;

  const pendentes = manual.vendas.filter(pendente);
  if (!pendentes.length) {
    return { dia, pedidos: [], semComprovante: [], confirmado: 0 };
  }

  const anexos = await anexosDePedidos(pendentes.map((v) => v.pedido));

  // Primeiro ler tudo, depois decidir: só com todos os comprovantes na mão dá
  // para ver que dois pedidos apontam para o mesmo pagamento.
  const lidosPorPedido = new Map<string, Comprovante[]>();
  const semComprovante: string[] = [];

  for (const v of pendentes) {
    const lidos: Comprovante[] = [];
    for (const a of anexos.get(v.pedido) ?? []) {
      const c = await lerAnexo(a.arquivo, a.url);
      if (c) lidos.push(c);
    }
    if (lidos.length) lidosPorPedido.set(v.pedido, lidos);
    else semComprovante.push(v.pedido);
  }

  /*
   * Quem divide pagamento com quem.
   *
   * Dois pedidos com o mesmo comprovante são um pagamento só, e o valor do
   * documento tem que bater com a **soma** deles — não com cada um. Procurar
   * duas vezes acharia o lançamento uma vez e acusaria o outro pedido de não
   * ter contrapartida.
   */
  const grupo = new Map<string, string[]>();
  for (const [pedido, lidos] of lidosPorPedido) {
    for (const c of lidos) {
      const k = chaveDoComprovante(c);
      grupo.set(k, [...(grupo.get(k) ?? []), pedido]);
    }
  }

  const usados = new Set<string>();
  const resultado = new Map<string, ComprovanteConferido[]>();

  // Busca uma vez por comprovante distinto, na ordem do maior valor — assim o
  // pagamento compartilhado reivindica o lançamento antes de uma busca
  // individual tropeçar nele.
  const distintos = [...grupo.entries()]
    .map(([k, pedidos]) => ({
      k,
      pedidos,
      c: lidosPorPedido.get(pedidos[0])!.find((x) => chaveDoComprovante(x) === k)!,
    }))
    .sort((a, b) => b.c.valor - a.c.valor);

  for (const { pedidos, c } of distintos) {
    const achado = await procurar(c, usados);
    const soma = pedidos.reduce(
      (s, nome) => s + devidoDe(pendentes.find((v) => v.pedido === nome)!),
      0,
    );

    /*
     * Pagamento compartilhado que não bate com a soma do grupo não vale para
     * ninguém: o comprovante prova um valor, e esse valor tem que ser o que os
     * pedidos juntos devem. Caso contrário sobra ou falta dinheiro, e dizer
     * qual dos dois está certo seria chute.
     */
    const confere =
      achado.casou && (pedidos.length === 1 || perto(c.valor, soma));
    const nota =
      achado.casou && !confere
        ? `o pagamento de ${c.valor.toFixed(2)} é de ${pedidos.length} pedidos, ` +
          `mas eles somam ${soma.toFixed(2)}`
        : achado.nota;

    for (const nome of pedidos) {
      resultado.set(nome, [
        ...(resultado.get(nome) ?? []),
        { ...c, casou: confere, lancamento: achado.lancamento, ...(nota ? { nota } : {}) },
      ]);
    }
  }

  const pedidos: PedidoComComprovante[] = [];
  for (const v of pendentes) {
    const lidos = resultado.get(v.pedido);
    if (!lidos?.length) continue;
    const devido = devidoDe(v);

    /*
     * No pagamento compartilhado, o pedido é coberto pela sua parte da soma —
     * não pelo valor cheio do comprovante, que pertence ao grupo.
     */
    const confirmado = lidos
      .filter((c) => c.casou)
      .reduce((s, c) => {
        const junto = grupo.get(chaveDoComprovante(c)) ?? [v.pedido];
        return s + (junto.length > 1 ? devido : c.valor);
      }, 0);

    pedidos.push({
      pedido: v.pedido,
      valor: devido,
      comprovantes: lidos,
      confirmado,
      fecha: confirmado + TOLERANCIA >= devido,
      junto: [
        ...new Set(
          lidos.flatMap((c) =>
            (grupo.get(chaveDoComprovante(c)) ?? []).filter((n) => n !== v.pedido),
          ),
        ),
      ],
    });
  }

  return {
    dia,
    pedidos,
    semComprovante,
    confirmado: pedidos.filter((p) => p.fecha).reduce((s, p) => s + p.valor, 0),
  };
}
