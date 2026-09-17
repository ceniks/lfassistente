/**
 * Confere os pedidos que a Shopify registra como pagos "à mão".
 *
 * São os rascunhos que as atendentes montam e marcam como pagos depois que a
 * cliente paga por fora — quase sempre por um link da Pagar.me. Para a Shopify
 * tudo isso é o gateway `manual`, então até aqui era a única fatia do
 * faturamento sem nenhuma contrapartida: R$ 6.572 em 16/09.
 *
 * A amarração é por valor e e-mail, porque pedido manual não tem identificador
 * de pagamento. Isso admite três respostas, e as três importam:
 *
 *  - **exato**: mesma cliente, mesmo valor. É o caso normal.
 *  - **parcial**: mesma cliente, valor menor na Pagar.me. Não é erro — é
 *    pagamento dividido, tipicamente parte no link e parte em Pix. O que fica
 *    de fora é justamente o que não tem rastro, e é esse número que interessa.
 *  - **sem rastro**: nada da cliente na Pagar.me no dia. Dinheiro que só
 *    existe porque alguém marcou como pago.
 *
 * Reenvio e troca entram como categoria à parte: eles já saem do faturamento
 * pela classificação e valem poucos reais de frete, então cobrá-los de rastro
 * encheria o relatório de linha vermelha sem consequência.
 */
import { categoria } from "./classify.js";
import {
  comentariosDePedidos,
  pedidosPagosEm,
  type OrderNode,
} from "./shopify.js";
import {
  transacoesDoDia,
  temPagBank,
  type TransacaoPagBank,
} from "./pagbank.js";
import {
  pedidosDoDia,
  taxaDasCobrancas,
  temPagarme,
  type PedidoPagarme,
  type TaxaPagarme,
} from "./pagarme.js";

const TOLERANCIA = 0.01;

/**
 * Gateways que significam "alguém marcou como pago", não "o dinheiro passou
 * por aqui".
 *
 * `manual` é o genérico da Shopify, usado até 17/09/2026. A partir dali
 * existem métodos manuais nomeados — `pagar.me` e `pix` — e é isso que muda
 * tudo: a forma de pagamento deixa de ser comentário livre e vira dado, então
 * dá para cobrar rastro só de quem tem onde ser rastreado. A lista é explícita
 * de propósito: gateway novo e desconhecido não deve ser silenciosamente
 * tratado como manual.
 */
export const MANUAIS = new Set([
  "manual",
  "pagar.me",
  "pagarme",
  "pix",
  "dinheiro",
  "transferencia",
]);

export const normalizarGateway = (g: string) =>
  g
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

/** Pix cai direto na conta e não passa por gateway: não há o que consultar. */
const ehPixDireto = (g: string) => normalizarGateway(g) === "pix";

export type SituacaoManual = "exato" | "parcial" | "sem-rastro" | "pix-direto";

export interface PedidoManual {
  pedido: string;
  valor: number;
  categoria: string;
  email: string;
  /** Como a atendente declarou o pagamento: "pagar.me", "pix", ou "manual". */
  metodo: string;
  situacao: SituacaoManual;
  /** Quanto foi encontrado na Pagar.me. */
  encontrado: number;
  /** Valor sem contrapartida — em parcial, a diferença; em sem-rastro, tudo. */
  semRastro: number;
  codigo: string | null;
  /** Ponte para os recebíveis, de onde sai a taxa. */
  chargeId: string | null;
  /** Observação quando o rastro existe mas não confirma o pagamento. */
  nota?: string;
}

export interface ConferenciaManual {
  /** Só as vendas — reenvio e troca ficam fora da conta principal. */
  vendas: PedidoManual[];
  valorDasVendas: number;
  rastreado: number;
  semRastro: number;
  /** Reenvio e troca pagos à mão, agregados: frete, não faturamento. */
  outros: { quantidade: number; valor: number };
  /** Tentativas recusadas na Pagar.me no dia — atrito de checkout, não erro. */
  recusadas: { quantidade: number; valor: number };
  /** Pedido pago na Pagar.me que nenhum pedido manual da Shopify reivindicou. */
  orfaos: PedidoPagarme[];
  /** Pix declarado: cai direto na conta e só o extrato do PagBank confirma. */
  pixDireto: { quantidade: number; valor: number };
  /**
   * Taxa que a Pagar.me descontou nas cobranças casadas.
   *
   * Vem dos recebíveis, não da transação: o `cost` da transação são R$ 0,15 de
   * gateway e não o desconto. Cobre só o que foi rastreado — o que ficou sem
   * rastro não tem taxa somada, o que subestima a conta em poucos reais.
   */
  taxa: TaxaPagarme | null;
}

const capturasManuais = (p: OrderNode) =>
  p.transactions.filter(
    (t) =>
      t.status === "SUCCESS" &&
      (t.kind === "SALE" || t.kind === "CAPTURE") &&
      MANUAIS.has(normalizarGateway(t.gateway ?? "")),
  );

const ehManual = (p: OrderNode) => capturasManuais(p).length > 0;

const valorManual = (p: OrderNode) =>
  capturasManuais(p).reduce(
    (s, t) => s + Number(t.amountSet?.shopMoney?.amount ?? 0),
    0,
  );

/**
 * O que a atendente declarou por escrito, quando não teve onde escolher.
 *
 * Transação capturada não muda de gateway na Shopify, então o pedido criado
 * antes dos métodos nomeados fica como `manual` para sempre. O que sobra é o
 * comentário: "pagbank", "pagar.me", "pix", "pix e pagar.me". Reconhecemos só
 * essas formas e nada mais — texto livre que não casa com nenhuma vira
 * `null`, e o pedido segue sem método declarado em vez de ganhar um inventado.
 */
export function metodoNoComentario(comentarios: string[]): string | null {
  const achados = new Set<string>();
  for (const c of comentarios) {
    const n = normalizarGateway(c);
    if (/pagar\.?\s?me/.test(n)) achados.add("pagar.me");
    if (/pagbank|pagseguro/.test(n)) achados.add("pagbank");
    if (/\bpix\b/.test(n)) achados.add("pix");
  }
  return achados.size ? [...achados].join(" + ") : null;
}

/** O método que a atendente escolheu, quando ela teve onde escolher. */
const metodoDeclarado = (p: OrderNode) => {
  const gs = [
    ...new Set(capturasManuais(p).map((t) => (t.gateway ?? "").trim())),
  ];
  return gs.length === 1 ? gs[0] : gs.join(" + ");
};

export async function conferirPagosAMao(
  dia: string,
): Promise<ConferenciaManual | null> {
  if (!temPagarme()) return null;

  const [pedidos, naPagarme] = await Promise.all([
    pedidosPagosEm(dia),
    pedidosDoDia(dia),
  ]);

  const manuais = pedidos.filter(ehManual);

  /*
   * Para os que ficaram no `manual` genérico, o método só existe escrito na
   * linha do tempo. Uma busca só, e apenas para esses poucos pedidos.
   */
  const semMetodo = manuais.filter(
    (p) => normalizarGateway(metodoDeclarado(p)) === "manual",
  );
  const [comentarios, noPagBank] = await Promise.all([
    comentariosDePedidos(semMetodo.map((p) => p.name)),
    temPagBank()
      ? transacoesDoDia(dia)
      : Promise.resolve([] as TransacaoPagBank[]),
  ]);
  const pagos = naPagarme.filter((p) => p.pago);
  const usados = new Set<string>();

  const conferir = (p: OrderNode): PedidoManual => {
    const valor = valorManual(p);
    const email = (p.email ?? "").toLowerCase();
    const escolhido = metodoDeclarado(p);
    const metodo =
      normalizarGateway(escolhido) === "manual"
        ? (metodoNoComentario(comentarios.get(p.name) ?? []) ?? escolhido)
        : escolhido;

    /*
     * Pix declarado cai direto na conta do PagBank, fora de qualquer gateway —
     * confirmado: as transações do PagBank entre 10 e 16/09 são 100% cartão.
     * Não existe API que confirme esse dinheiro, então marcá-lo como "sem
     * rastro" confundiria "não verificado" com "suspeito" e encheria o
     * relatório de vermelho que ninguém pode resolver. Ele tem situação
     * própria e fica separado até existir acesso ao extrato da conta.
     */
    /*
     * Método declarado como PagBank: o dinheiro teria que estar na conta que a
     * conferência do gateway já lê. Se houver uma transação do mesmo valor mas
     * cancelada, isso não é rastro — é o contrário, é o link que não foi pago,
     * e precisa ser dito assim. O caso real: #139235, link de R$ 399,80 criado
     * às 07:29 e cancelado, com o pedido marcado como pago às 10:51.
     */
    if (/pagbank/.test(normalizarGateway(metodo))) {
      const mesmoValor = noPagBank.filter(
        (t) => Math.abs(t.bruto - valor) <= TOLERANCIA,
      );
      const paga = mesmoValor.find((t) => t.valeComoVenda);
      const cancelada = mesmoValor.find((t) => !t.valeComoVenda);
      return {
        pedido: p.name,
        valor,
        categoria: categoria(p),
        email,
        metodo,
        situacao: paga ? "exato" : "sem-rastro",
        encontrado: paga?.bruto ?? 0,
        semRastro: paga ? 0 : valor,
        codigo: paga?.codigo ?? cancelada?.codigo ?? null,
        chargeId: null,
        nota: paga
          ? undefined
          : cancelada
            ? "há uma cobrança do mesmo valor no PagBank, mas cancelada"
            : "nada desse valor na conta PagBank do site — pode ter sido na maquininha",
      };
    }

    if (ehPixDireto(metodo)) {
      return {
        pedido: p.name,
        valor,
        categoria: categoria(p),
        email,
        metodo,
        situacao: "pix-direto",
        encontrado: 0,
        semRastro: 0,
        codigo: null,
        chargeId: null,
      };
    }

    // Mesma cliente, ainda não reivindicado. O maior primeiro, para que um
    // pagamento cheio não seja preterido por um parcial do mesmo dia.
    const dela = pagos
      .filter((c) => c.email && c.email === email && !usados.has(c.id))
      .sort((a, b) => b.valor - a.valor);

    const exato = dela.find((c) => Math.abs(c.valor - valor) <= TOLERANCIA);
    const achado = exato ?? dela[0];
    if (achado) usados.add(achado.id);

    const encontrado = achado?.valor ?? 0;
    const situacao: SituacaoManual = !achado
      ? "sem-rastro"
      : Math.abs(encontrado - valor) <= TOLERANCIA
        ? "exato"
        : "parcial";

    return {
      pedido: p.name,
      valor,
      categoria: categoria(p),
      email,
      metodo,
      situacao,
      encontrado,
      semRastro: Math.max(0, valor - encontrado),
      codigo: achado?.codigo ?? null,
      chargeId: achado?.chargeId ?? null,
    };
  };

  const todos = manuais.map(conferir).sort((a, b) => b.valor - a.valor);
  const vendas = todos.filter((x) => x.categoria === "venda");
  const outros = todos.filter((x) => x.categoria !== "venda");
  const recusadas = naPagarme.filter((p) => !p.pago);

  return {
    vendas,
    valorDasVendas: vendas.reduce((s, x) => s + x.valor, 0),
    rastreado: vendas.reduce((s, x) => s + x.encontrado, 0),
    semRastro: vendas.reduce((s, x) => s + x.semRastro, 0),
    outros: {
      quantidade: outros.length,
      valor: outros.reduce((s, x) => s + x.valor, 0),
    },
    recusadas: {
      quantidade: recusadas.length,
      valor: recusadas.reduce((s, p) => s + p.valor, 0),
    },
    orfaos: pagos.filter((c) => !usados.has(c.id)),
    taxa: await taxaDasCobrancas(
      vendas.filter((v) => v.chargeId).map((v) => v.chargeId as string),
    ),
    pixDireto: {
      quantidade: vendas.filter((v) => v.situacao === "pix-direto").length,
      valor: vendas
        .filter((v) => v.situacao === "pix-direto")
        .reduce((s, v) => s + v.valor, 0),
    },
  };
}
