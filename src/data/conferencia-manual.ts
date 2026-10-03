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

export type SituacaoManual =
  | "exato"
  | "parcial"
  | "sem-rastro"
  | "pix-direto"
  /**
   * Cobrança do valor exato na Pagar.me, mas no nome de outra pessoa.
   *
   * Acontece de verdade e com frequência: marido, filha ou a empresa paga o
   * pedido da cliente. O #141259 é o caso — pedido de maiaryduarte18@gmail.com,
   * link pago por Paulo Alexandre (pauloalexandrexx@gmail.com), R$ 2.084,20 em
   * ambos. Exigir o mesmo e-mail transformava isso em "dinheiro que não
   * existe". Fica como categoria própria porque a prova é mais fraca que a do
   * casamento por e-mail e quem lê precisa saber disso.
   */
  | "por-valor";

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

/**
 * Cobranças pagas, ainda livres, do valor exato do pedido.
 *
 * Separado para ser testável sem rede: é a regra que decide se "pago por
 * outra pessoa" vira conferência ou vira dúvida, e ela precisa de teste.
 */
/**
 * O conjunto de pedidos que soma exatamente o valor de uma cobrança.
 *
 * A cliente monta dois pedidos e paga os dois num link só — #141536 (R$ 712,22)
 * e #141537 (R$ 679,70) numa cobrança de R$ 1.391,92. Sem isto, o primeiro
 * pedido reivindicava a cobrança inteira e o segundo saía como dinheiro que
 * não existe.
 *
 * Devolve `null` quando nenhum conjunto soma o valor **ou** quando mais de um
 * soma: dois conjuntos diferentes com a mesma soma é empate, e escolher seria
 * chute.
 */
export function grupoQueSoma(
  pedidos: Array<{ pedido: string; valor: number }>,
  alvo: number,
): string[] | null {
  // Acima de 10 pedidos no mesmo e-mail e no mesmo dia isto deixa de ser
  // "cliente comprou duas vezes" e vira outra coisa; não vale varrer 2^n.
  if (pedidos.length < 2 || pedidos.length > 10) return null;

  const candidatos: string[][] = [];
  for (let mascara = 1; mascara < 1 << pedidos.length; mascara++) {
    const grupo = pedidos.filter((_, i) => mascara & (1 << i));
    if (grupo.length < 2) continue;
    const soma = grupo.reduce((s, p) => s + p.valor, 0);
    if (Math.abs(soma - alvo) <= TOLERANCIA) candidatos.push(grupo.map((p) => p.pedido));
  }

  if (candidatos.length !== 1) return null;
  return candidatos[0];
}

export function cobrancasDoMesmoValor(
  valor: number,
  pagos: PedidoPagarme[],
  usados: Set<string>,
): PedidoPagarme[] {
  return pagos.filter(
    (c) => !usados.has(c.id) && Math.abs(c.valor - valor) <= TOLERANCIA,
  );
}

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

  /**
   * Pedidos pagos juntos numa cobrança só, por e-mail.
   *
   * Resolvido antes do laço porque a ordem importa: se o primeiro pedido do
   * grupo rodasse sozinho, ele reivindicaria a cobrança cheia e o segundo
   * ficaria sem nada.
   */
  const compartilhado = new Map<
    string,
    { cobranca: PedidoPagarme; junto: string[] }
  >();

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

    /*
     * Pago junto com outro pedido: a conta já foi fechada no grupo. Cada
     * pedido responde pela sua parte, e a nota diz com quem ele foi pago —
     * senão "R$ 712,22 na Pagar.me" não se explica diante de uma cobrança de
     * R$ 1.391,92.
     */
    const emGrupo = compartilhado.get(p.name);
    if (emGrupo) {
      return {
        pedido: p.name,
        valor,
        categoria: categoria(p),
        email,
        metodo,
        situacao: "exato",
        encontrado: valor,
        semRastro: 0,
        codigo: emGrupo.cobranca.codigo,
        chargeId: emGrupo.cobranca.chargeId,
        nota: `pago junto com ${emGrupo.junto.join(", ")} numa cobrança de R$ ${emGrupo.cobranca.valor.toFixed(2).replace(".", ",")}`,
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

    /*
     * Ninguém no nome dela: tentar pelo valor, e só se não houver dúvida.
     *
     * Quem paga o pedido nem sempre é quem compra. A cobrança existe, está
     * paga e tem o valor exato — negar isso por causa do e-mail é inventar um
     * buraco de caixa. Mas o casamento por valor só vale quando há **uma**
     * cobrança livre daquele valor no dia: duas e a escolha seria sorteio, que
     * é como uma conferência produz falso positivo.
     */
    if (!achado) {
      const mesmoValor = cobrancasDoMesmoValor(valor, pagos, usados);
      if (mesmoValor.length === 1) {
        const c = mesmoValor[0];
        usados.add(c.id);
        return {
          pedido: p.name,
          valor,
          categoria: categoria(p),
          email,
          metodo,
          situacao: "por-valor",
          encontrado: c.valor,
          semRastro: 0,
          codigo: c.codigo,
          chargeId: c.chargeId,
          nota: `pago por ${c.nome || "outra pessoa"}${c.email ? ` (${c.email})` : ""}, e não pela cliente do pedido`,
        };
      }
      if (mesmoValor.length > 1) {
        return {
          pedido: p.name,
          valor,
          categoria: categoria(p),
          email,
          metodo,
          situacao: "sem-rastro",
          encontrado: 0,
          semRastro: valor,
          codigo: null,
          chargeId: null,
          nota: `${mesmoValor.length} cobranças pagas do mesmo valor no dia, nenhuma no nome da cliente — sem como decidir`,
        };
      }
    }

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

  /*
   * Um pagamento, vários pedidos: procurar por e-mail, antes de qualquer
   * casamento individual.
   */
  const porEmail = new Map<string, OrderNode[]>();
  for (const p of manuais) {
    const e = (p.email ?? "").toLowerCase();
    if (e) porEmail.set(e, [...(porEmail.get(e) ?? []), p]);
  }
  for (const [email, dela] of porEmail) {
    if (dela.length < 2) continue;
    const lista = dela.map((p) => ({ pedido: p.name, valor: valorManual(p) }));
    for (const c of pagos.filter((x) => x.email === email && !usados.has(x.id))) {
      const grupo = grupoQueSoma(lista, c.valor);
      if (!grupo) continue;
      usados.add(c.id);
      for (const nome of grupo) {
        compartilhado.set(nome, {
          cobranca: c,
          junto: grupo.filter((x) => x !== nome),
        });
      }
    }
  }

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
