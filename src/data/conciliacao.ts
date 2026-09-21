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
import { estornosEntre, reembolsosDePedidos, type Estorno } from './shopify.js';
import { detalhe, finalizadaEm, listar, valorPago, type Reversa } from './troque.js';

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

/**
 * Par que bate no valor mas com os dois lados em dias diferentes.
 *
 * Não é divergência — o dinheiro saiu e a reversa fechou — mas também não pode
 * sumir dentro de "os dois lados batem". Em 20/09 o Troquecommerce finalizou
 * R$ 1.105 e a Shopify não reembolsou nada no dia; o relatório disse "batem"
 * sem explicar, e quem olha os totais vê uma diferença de R$ 1.105 sem motivo.
 * Um dos dois pedidos (#132261) tinha sido reembolsado na Shopify em 18/08: a
 * reversa ficou 33 dias aberta depois do dinheiro sair. Isso é informação de
 * processo, e precisa aparecer.
 */
export interface ForaDoDia {
  pedido: string;
  valor: number;
  shopifyEm: string;
  troqueEm: string;
  /** Troque menos Shopify, em dias. Positivo: a reversa fechou depois do reembolso. */
  dias: number;
}

export interface Conciliacao {
  de: string;
  ate: string;
  shopify: { quantidade: number; valor: number; pendente: number };
  troque: { quantidade: number; valor: number };
  aguardandoPagamento: { quantidade: number; valor: number };
  soShopify: DivergenciaSimples[];
  soTroque: DivergenciaSimples[];
  valorDiferente: DivergenciaDeValor[];
  batem: number;
  /** Os que batem com os lados em dias diferentes — explica a diferença dos totais. */
  emOutroDia: ForaDoDia[];
}

/** Dias antes e depois para procurar a reversa de um reembolso órfão. */
const JANELA = 20;
const TOLERANCIA = 1;

const desloca = (dia: string, n: number) => {
  const d = new Date(`${dia}T12:00:00-03:00`);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Só os dígitos: "#130070" e "130070" são o mesmo pedido. */
const chave = (s?: string | null) => (s ?? '').replace(/\D/g, '');

const diaDe = (iso: string) =>
  new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

const diasEntre = (de: string, ate: string) =>
  Math.round((Date.parse(`${ate}T12:00:00Z`) - Date.parse(`${de}T12:00:00Z`)) / 86_400_000);

const normalizar = (s: string) =>
  s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();

const comEstorno = (r: Reversa) => (r.refund_value ?? 0) > 0;

/**
 * O valor que a conferência compara com a Shopify.
 *
 * Tem de ser o PAGO, não o solicitado. O Troquecommerce mostra os dois no
 * painel e o `refund_value` da API é o primeiro: o que a cliente pediu na
 * abertura da reversa. Comparar por ele inventa divergência sempre que o
 * estorno sai por valor diferente do pedido — foi o caso do #134507, que
 * apareceu como "-R$ 129,90" quando os dois lados pagaram R$ 240,00.
 *
 * Reversa finalizada sem pagamento registrado cai no solicitado, porque zerar
 * esconderia o caso; a linha aparece como divergência, que é o certo.
 */
const valorParaConferir = (r: Reversa) => valorPago(r) ?? r.refund_value ?? 0;
const finalizada = (r: Reversa) => normalizar(r.status) === 'finalizado';
const aguardandoPagamento = (r: Reversa) => normalizar(r.status) === 'aguardando pagamento';

export async function conferirEstorno(de: string, ate: string): Promise<Conciliacao> {
  // Só duas buscas largas: os reembolsos do período na Shopify e as reversas do
  // Troquecommerce numa janela folgada. O lado caro — procurar na Shopify o
  // reembolso de uma reversa que caiu fora do período — vira consulta por nome
  // de pedido mais adiante, em vez de varredura.
  const [noPeriodo, largoTroque] = await Promise.all([
    estornosEntre(de, ate),
    listar({ atualizadaDe: desloca(de, -JANELA), atualizadaAte: desloca(ate, JANELA) }),
  ]);

  // O dia em São Paulo, não em UTC: o Troquecommerce grava em UTC, e uma
  // reversa finalizada às 22h22 de 19/09 aparecia como 20/09 (foi o #132261).
  const dentro = (r: Reversa) => {
    const d = diaDe(r.updated_at ?? r.created_at);
    return d >= de && d <= ate;
  };

  // Finalizada sem pagamento registrado não traz a data do fim na listagem: só
  // o histórico do detalhe diz. São poucas — busca uma a uma.
  const finalizadasComEstorno = largoTroque.filter((r) => comEstorno(r) && finalizada(r));
  await Promise.all(
    finalizadasComEstorno
      .filter((r) => !r.reverse_payment?.created_at)
      .map(async (r) => {
        try {
          r.history = (await detalhe(r.id)).history ?? null;
        } catch {
          /* sem histórico, cai no updated_at abaixo */
        }
      }),
  );
  const fimDe = (r: Reversa) => diaDe(finalizadaEm(r) ?? r.updated_at ?? r.created_at);

  const troqueNoPeriodo = finalizadasComEstorno.filter((r) => {
    const d = fimDe(r);
    return d >= de && d <= ate;
  });
  const aguardando = largoTroque.filter((r) => dentro(r) && comEstorno(r) && aguardandoPagamento(r));

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

  // Pergunta dirigida: destas reversas finalizadas, quais têm reembolso na
  // Shopify? Cobre o caso do reembolso feito em outro dia, sem varrer nada.
  const shopifyPorPedido: Map<string, Estorno[]> = await reembolsosDePedidos(
    troqueNoPeriodo.map((r) => r.ecommerce_number ?? ''),
  );

  const usados = new Set<string>();
  const soShopify: DivergenciaSimples[] = [];
  const soTroque: DivergenciaSimples[] = [];
  const valorDiferente: DivergenciaDeValor[] = [];
  const emOutroDia: ForaDoDia[] = [];
  let batem = 0;

  for (const e of noPeriodo) {
    const k = chave(e.pedido);
    const pares = finalizadasPorPedido.get(k) ?? [];

    if (!pares.length) {
      const outras = qualquerPorPedido.get(k) ?? [];
      soShopify.push({
        pedido: e.pedido,
        valor: e.valor + e.pendente,
        situacao: outras.length
          ? `reversa existe mas está "${outras[0].status}"`
          : 'nenhuma reversa no Troquecommerce',
      });
      continue;
    }

    usados.add(k);
    const soma = pares.reduce((s, r) => s + valorParaConferir(r), 0);
    // Para o confronto, reembolso emitido conta mesmo se o adquirente ainda não
    // liquidou: a decisão já foi tomada do lado da loja.
    const dif = e.valor + e.pendente - soma;
    if (Math.abs(dif) < TOLERANCIA) {
      batem++;
      const shopifyEm = diaDe(e.em);
      const troqueEm = fimDe(pares[0]);
      if (shopifyEm !== troqueEm) {
        emOutroDia.push({
          pedido: e.pedido,
          valor: e.valor + e.pendente,
          shopifyEm,
          troqueEm,
          dias: diasEntre(shopifyEm, troqueEm),
        });
      }
    } else {
      valorDiferente.push({
        pedido: e.pedido,
        shopify: e.valor + e.pendente,
        troque: soma,
        diferenca: dif,
        reversaEm: fimDe(pares[0]),
      });
    }
  }

  for (const r of troqueNoPeriodo) {
    const k = chave(r.ecommerce_number);
    if (usados.has(k)) continue;
    const pares = shopifyPorPedido.get(k) ?? [];
    const valor = valorParaConferir(r);
    if (pares.length) {
      // Antes bastava existir reembolso no pedido para contar como "batem", sem
      // olhar valor. Um reembolso parcial antigo cobria um estorno maior.
      const naShopify = pares.reduce((s, e) => s + e.valor + e.pendente, 0);
      const dif = naShopify - valor;
      const troqueEm = fimDe(r);
      if (Math.abs(dif) < TOLERANCIA) {
        batem++;
        const shopifyEm = diaDe(
          pares.map((e) => e.em).sort().at(-1) ?? r.updated_at ?? r.created_at,
        );
        if (shopifyEm !== troqueEm) emOutroDia.push({
          pedido: `#${chave(r.ecommerce_number)}`,
          valor,
          shopifyEm,
          troqueEm,
          dias: diasEntre(shopifyEm, troqueEm),
        });
      } else {
        valorDiferente.push({
          pedido: `#${chave(r.ecommerce_number)}`,
          shopify: naShopify,
          troque: valor,
          diferenca: dif,
          reversaEm: troqueEm,
        });
      }
    } else {
      soTroque.push({
        pedido: `#${r.ecommerce_number ?? '?'}`,
        valor,
        situacao:
          valorPago(r) === null
            ? 'finalizado sem pagamento registrado no Troquecommerce nem na Shopify'
            : `pago no Troquecommerce, sem reembolso na Shopify`,
      });
    }
  }

  const somar = <T>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);

  return {
    de,
    ate,
    shopify: {
      quantidade: noPeriodo.length,
      valor: somar(noPeriodo, (e) => e.valor),
      pendente: somar(noPeriodo, (e) => e.pendente),
    },
    troque: {
      quantidade: troqueNoPeriodo.length,
      valor: somar(troqueNoPeriodo, valorParaConferir),
    },
    // Aqui o solicitado é o número certo: é o que a L&F ainda deve, e por
    // definição não existe pagamento registrado nessas reversas.
    aguardandoPagamento: {
      quantidade: aguardando.length,
      valor: somar(aguardando, (r) => r.refund_value ?? 0),
    },
    soShopify,
    soTroque,
    valorDiferente,
    batem,
    emOutroDia: emOutroDia.sort((a, b) => b.dias - a.dias),
  };
}
