/**
 * Confronto entre o que saiu da Shopify e o que o Troquecommerce registrou.
 *
 * Os dois sistemas contam a mesma devolução de ângulos diferentes e quase nunca
 * no mesmo dia, então comparar totais não diz nada útil: uma diferença pode ser
 * descompasso de data, que não exige ação, ou dinheiro que nunca saiu, que
 * exige. Separar os dois casos só é possível casando pedido a pedido — e, para
 * quem ficar sozinho, procurando o par numa janela larga antes de chamar de
 * divergência.
 *
 * Três decisões moldam o resultado:
 *
 *  1. **Só reversa finalizada cobra saída na Shopify.** O `refund_value` existe
 *     desde a abertura da reversa: é o estorno previsto, não o pago. Comparar
 *     por ele sozinho enche o relatório de reversas "Em Trânsito" que não
 *     deveriam ter pago nada ainda.
 *  2. **"Aguardando Pagamento" tem balde próprio.** É estorno aprovado e não
 *     pago — fila de pagamento, não desencontro entre sistemas. Mas é dinheiro
 *     devido, então é contado à parte em vez de sumir.
 *  3. **Um real de tolerância.** Diferença de centavo é arredondamento entre os
 *     dois sistemas, e poluir a lista com ela custa a autoridade do relatório
 *     justamente onde ela importa.
 */
import { estornosEntre } from './shopify.js';
import { listar, type Reversa } from './troque.js';

export interface DivergenciaSimples {
  pedido: string;
  valor: number;
  /** O que se sabe do outro lado. */
  situacao: string;
}

export interface DivergenciaDeValor {
  pedido: string;
  shopify: number;
  troque: number;
  diferenca: number;
  /** Data da reversa no Troquecommerce, para achar o caso lá. */
  reversaEm: string;
}

export interface Conciliacao {
  de: string;
  ate: string;
  shopify: { quantidade: number; valor: number };
  troque: { quantidade: number; valor: number };
  aguardandoPagamento: { quantidade: number; valor: number };
  soShopify: DivergenciaSimples[];
  soTroque: DivergenciaSimples[];
  valorDiferente: DivergenciaDeValor[];
  batem: number;
}

/** Dias antes e depois para procurar o par de um reembolso órfão. */
const JANELA = 20;
const TOLERANCIA = 1;

const desloca = (dia: string, n: number) => {
  const d = new Date(`${dia}T12:00:00-03:00`);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Só os dígitos: "#130070" e "130070" são o mesmo pedido. */
const chave = (s?: string | null) => (s ?? '').replace(/\D/g, '');

const normalizar = (s: string) =>
  s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();

const comEstorno = (r: Reversa) => (r.refund_value ?? 0) > 0;
const finalizada = (r: Reversa) => normalizar(r.status) === 'finalizado';
const aguardandoPagamento = (r: Reversa) => normalizar(r.status) === 'aguardando pagamento';

export async function conferirEstorno(de: string, ate: string): Promise<Conciliacao> {
  const [noPeriodo, largoShopify, largoTroque] = await Promise.all([
    estornosEntre(de, ate),
    estornosEntre(desloca(de, -JANELA), desloca(ate, JANELA), 5),
    listar({ atualizadaDe: desloca(de, -JANELA), atualizadaAte: desloca(ate, JANELA) }),
  ]);

  const dentro = (r: Reversa) => {
    const d = (r.updated_at ?? r.created_at).slice(0, 10);
    return d >= de && d <= ate;
  };

  const troqueNoPeriodo = largoTroque.filter((r) => dentro(r) && comEstorno(r) && finalizada(r));
  const aguardando = largoTroque.filter((r) => dentro(r) && comEstorno(r) && aguardandoPagamento(r));

  const shopifyPorPedido = new Map<string, typeof largoShopify>();
  for (const e of largoShopify) {
    const k = chave(e.pedido);
    shopifyPorPedido.set(k, [...(shopifyPorPedido.get(k) ?? []), e]);
  }

  const finalizadasPorPedido = new Map<string, Reversa[]>();
  for (const r of largoTroque.filter((x) => comEstorno(x) && finalizada(x))) {
    const k = chave(r.ecommerce_number);
    finalizadasPorPedido.set(k, [...(finalizadasPorPedido.get(k) ?? []), r]);
  }

  // Todas as reversas, em qualquer status: saber que existe uma "Em Trânsito" é
  // a diferença entre "processo adiantado" e "reembolso sem reversa nenhuma".
  const qualquerPorPedido = new Map<string, Reversa[]>();
  for (const r of largoTroque) {
    const k = chave(r.ecommerce_number);
    qualquerPorPedido.set(k, [...(qualquerPorPedido.get(k) ?? []), r]);
  }

  const usados = new Set<string>();
  const soShopify: DivergenciaSimples[] = [];
  const soTroque: DivergenciaSimples[] = [];
  const valorDiferente: DivergenciaDeValor[] = [];
  let batem = 0;

  for (const e of noPeriodo) {
    const k = chave(e.pedido);
    const pares = finalizadasPorPedido.get(k) ?? [];

    if (!pares.length) {
      const outras = qualquerPorPedido.get(k) ?? [];
      soShopify.push({
        pedido: e.pedido,
        valor: e.valor,
        situacao: outras.length
          ? `reversa existe mas está "${outras[0].status}"`
          : 'nenhuma reversa no Troquecommerce',
      });
      continue;
    }

    usados.add(k);
    const soma = pares.reduce((s, r) => s + (r.refund_value ?? 0), 0);
    const dif = e.valor - soma;
    if (Math.abs(dif) < TOLERANCIA) {
      batem++;
    } else {
      valorDiferente.push({
        pedido: e.pedido,
        shopify: e.valor,
        troque: soma,
        diferenca: dif,
        reversaEm: (pares[0].updated_at ?? pares[0].created_at).slice(0, 10),
      });
    }
  }

  for (const r of troqueNoPeriodo) {
    const k = chave(r.ecommerce_number);
    if (usados.has(k)) continue;
    const pares = shopifyPorPedido.get(k) ?? [];
    const valor = r.refund_value ?? 0;
    if (pares.length) {
      batem++;
    } else {
      soTroque.push({
        pedido: `#${r.ecommerce_number ?? '?'}`,
        valor,
        situacao: `status "${r.status}" · nenhum reembolso na Shopify`,
      });
    }
  }

  const somar = <T>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);

  return {
    de,
    ate,
    shopify: { quantidade: noPeriodo.length, valor: somar(noPeriodo, (e) => e.valor) },
    troque: {
      quantidade: troqueNoPeriodo.length,
      valor: somar(troqueNoPeriodo, (r) => r.refund_value ?? 0),
    },
    aguardandoPagamento: {
      quantidade: aguardando.length,
      valor: somar(aguardando, (r) => r.refund_value ?? 0),
    },
    soShopify,
    soTroque,
    valorDiferente,
    batem,
  };
}
