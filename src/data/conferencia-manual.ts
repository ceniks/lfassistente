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
import { pedidosPagosEm, type OrderNode } from "./shopify.js";
import { pedidosDoDia, temPagarme, type PedidoPagarme } from "./pagarme.js";

const TOLERANCIA = 0.01;

export type SituacaoManual = "exato" | "parcial" | "sem-rastro";

export interface PedidoManual {
  pedido: string;
  valor: number;
  categoria: string;
  email: string;
  situacao: SituacaoManual;
  /** Quanto foi encontrado na Pagar.me. */
  encontrado: number;
  /** Valor sem contrapartida — em parcial, a diferença; em sem-rastro, tudo. */
  semRastro: number;
  codigo: string | null;
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
}

const ehManual = (p: OrderNode) =>
  p.transactions.some(
    (t) =>
      t.status === "SUCCESS" &&
      (t.kind === "SALE" || t.kind === "CAPTURE") &&
      (t.gateway ?? "").trim() === "manual",
  );

const valorManual = (p: OrderNode) =>
  p.transactions
    .filter(
      (t) =>
        t.status === "SUCCESS" &&
        (t.kind === "SALE" || t.kind === "CAPTURE") &&
        (t.gateway ?? "").trim() === "manual",
    )
    .reduce((s, t) => s + Number(t.amountSet?.shopMoney?.amount ?? 0), 0);

export async function conferirPagosAMao(
  dia: string,
): Promise<ConferenciaManual | null> {
  if (!temPagarme()) return null;

  const [pedidos, naPagarme] = await Promise.all([
    pedidosPagosEm(dia),
    pedidosDoDia(dia),
  ]);

  const manuais = pedidos.filter(ehManual);
  const pagos = naPagarme.filter((p) => p.pago);
  const usados = new Set<string>();

  const conferir = (p: OrderNode): PedidoManual => {
    const valor = valorManual(p);
    const email = (p.email ?? "").toLowerCase();

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
      situacao,
      encontrado,
      semRastro: Math.max(0, valor - encontrado),
      codigo: achado?.codigo ?? null,
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
  };
}
