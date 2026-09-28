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
 * pedidos, que é como uma conferência por valor produz falso positivo.
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
  const usados = new Set<string>();
  const pedidos: PedidoComComprovante[] = [];
  const semComprovante: string[] = [];

  for (const v of pendentes) {
    const doPedido = anexos.get(v.pedido) ?? [];
    if (!doPedido.length) {
      semComprovante.push(v.pedido);
      continue;
    }

    const lidos: ComprovanteConferido[] = [];
    for (const a of doPedido) {
      const c = await lerAnexo(a.arquivo, a.url);
      if (!c) continue;
      lidos.push({ ...c, ...(await procurar(c, usados)) });
    }

    if (!lidos.length) {
      semComprovante.push(v.pedido);
      continue;
    }

    const confirmado = lidos.filter((c) => c.casou).reduce((s, c) => s + c.valor, 0);
    const devido = v.situacao === "pix-direto" ? v.valor : v.semRastro;
    pedidos.push({
      pedido: v.pedido,
      valor: devido,
      comprovantes: lidos,
      confirmado,
      fecha: confirmado + TOLERANCIA >= devido,
    });
  }

  return {
    dia,
    pedidos,
    semComprovante,
    confirmado: pedidos.filter((p) => p.fecha).reduce((s, p) => s + p.valor, 0),
  };
}
