/**
 * A taxa de retorno por safra: de cada peça vendida num período, quantas
 * voltaram.
 *
 * A primeira versão media uma janela rolante — o que voltou nos últimos 30
 * dias sobre o que foi vendido nos últimos 30 — e mentia exatamente quando
 * importava. A peça devolvida hoje foi vendida semanas atrás, então numerador e
 * denominador eram safras diferentes: em mês de venda forte o denominador
 * cresce antes do numerador e a taxa cai sozinha. Foi o que aconteceu em
 * setembro: a rolante caiu de 17,5% para 13,0%, e as safras fechadas estavam
 * paradas (16,3% e 16,4%). O Luis desconfiou pelo prazo de troca.
 *
 * Agora cada reversa volta para o pedido de origem pelo `ecommerce_number`, e a
 * taxa é da safra de venda:
 *
 * **Safra fechada** — pedidos de 30 a 59 dias atrás, com tudo o que voltou
 * deles até hoje. É o número para decidir. Por que essa idade: medido em 878
 * reversas, 95,9% abrem até 30 dias depois do pedido e 98,5% até 40. Aos 30
 * dias a safra está praticamente completa; esperar mais só envelhece o número.
 * Ao lado, a safra dos 60 a 89 dias, para comparar.
 *
 * **Safra em aberto** — pedidos dos últimos 30 dias, com o que já voltou. Sozinha
 * não diz nada, porque ainda vai subir. Por isso ela é comparada com a safra
 * fechada *vista com a mesma idade*: o que tinha voltado dela 30 dias atrás.
 * Um lote com defeito aparece aqui em dias, sem esperar o mês fechar.
 *
 * Duas regras de contagem, as mesmas do resto do boletim:
 *
 *  - Peça **postada**, não reversa aberta — ver `foiPostada`. A que abriu e não
 *    postou é mostrada à parte.
 *  - Peça, não reversa: cada reversa traz duas em média, e troca e estorno só
 *    se separam no item — ver `itensDasReversas`.
 */
import { pedidosComPecas, type PedidoDaSafra } from "./shopify.js";
import { itensDasReversas, type ItemContado } from "./itens-de-reversa.js";
import { foiPostada, listar, temTroque, type Loja, type Reversa } from "./troque.js";

/** Idade em que a safra é considerada fechada. */
export const IDADE_DE_FECHAMENTO = 30;

/** ~2 minutos de busca: cabe no boletim das 8h mesmo depois de um deploy. */
const LIMITE_NO_BOLETIM = 500;

export interface Safra {
  /** Primeiro e último dia de venda da safra. */
  de: string;
  ate: string;
  pedidos: number;
  vendidas: number;
  /** Peças que a cliente efetivamente postou de volta. */
  postadas: number;
  trocas: number;
  estornos: number;
  /** Peças de reversa aberta que não foram postadas (ainda, ou nunca). */
  naoPostadas: number;
  taxa: number;
  taxaDeTroca: number;
  taxaDeEstorno: number;
}

export interface Retorno {
  /** Vendas de 30 a 59 dias atrás — o número para decidir. */
  fechada: Safra;
  /** Vendas de 60 a 89 dias atrás, para comparar. */
  anterior: Safra;
  /** Vendas dos últimos 30 dias, com o que já voltou. */
  aberta: Safra;
  /** A safra fechada como estava 30 dias atrás — mesma idade da aberta. */
  fechadaNaMesmaIdade: Safra;
  /** Reversas cujo detalhe não veio: ficam fora da conta, não contam zero. */
  semDetalhe: number;
}

const diasAntes = (dia: string, n: number) => {
  const d = new Date(`${dia}T12:00:00-03:00`);
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

const diaDe = (iso: string) =>
  new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });

/**
 * O dia em que a peça foi postada, ou `null` se não foi.
 *
 * A data vem do rastreio. 7% das postadas não têm (processadas à mão, recebidas
 * sem objeto dos Correios); para essas vale o dia da abertura, que erra para
 * cedo — a mediana entre abrir e postar é de 2,7 dias. Só a comparação "na
 * mesma idade" usa a data; as outras contam o status de hoje.
 */
function postadaEm(r: Reversa): string | null {
  if (!foiPostada(r)) return null;
  return diaDe(r.tracking?.posted_date ?? r.created_at);
}

function contar(
  pedidos: PedidoDaSafra[],
  porPedido: Map<string, Reversa[]>,
  itens: Map<string, ItemContado[]>,
  de: string,
  ate: string,
  /** Vê a safra como estava neste dia. Sem ele, como está hoje. */
  vistaEm?: string,
): Safra & { semDetalhe: number } {
  let n = 0;
  let vendidas = 0;
  let postadas = 0;
  let trocas = 0;
  let estornos = 0;
  let naoPostadas = 0;
  let semDetalhe = 0;

  for (const p of pedidos) {
    if (p.dia < de || p.dia > ate) continue;
    n += 1;
    vendidas += p.pecas;

    for (const r of porPedido.get(p.numero) ?? []) {
      if (vistaEm && diaDe(r.created_at) > vistaEm) continue;
      const lista = itens.get(r.id);
      if (!lista) {
        semDetalhe += 1;
        continue;
      }
      const quando = postadaEm(r);
      const valeComoPostada = quando !== null && (!vistaEm || quando <= vistaEm);
      for (const it of lista) {
        if (!valeComoPostada) {
          naoPostadas += it.q;
          continue;
        }
        postadas += it.q;
        if (it.troca) trocas += it.q;
        else estornos += it.q;
      }
    }
  }

  const sobre = (x: number) => (vendidas > 0 ? x / vendidas : 0);
  return {
    de,
    ate,
    pedidos: n,
    vendidas,
    postadas,
    trocas,
    estornos,
    naoPostadas,
    taxa: sobre(postadas),
    taxaDeTroca: sobre(trocas),
    taxaDeEstorno: sobre(estornos),
    semDetalhe,
  };
}

export async function retornoPorSafra(
  dia: string,
  loja: Loja = "atual",
): Promise<Retorno | null> {
  if (!temTroque(loja)) return null;

  const F = IDADE_DE_FECHAMENTO;
  const inicio = diasAntes(dia, F * 3 - 1);

  // Toda reversa de um pedido desses foi criada depois dele, então listar a
  // partir do primeiro dia da safra mais velha pega todas.
  const [pedidos, reversas] = await Promise.all([
    pedidosComPecas(inicio, dia),
    listar({ criadaDe: inicio, criadaAte: dia }, loja),
  ]);
  const itens = await itensDasReversas(reversas, loja, LIMITE_NO_BOLETIM);

  const porPedido = new Map<string, Reversa[]>();
  for (const r of reversas) {
    const k = (r.ecommerce_number ?? "").replace(/\D/g, "");
    if (!k) continue;
    porPedido.set(k, [...(porPedido.get(k) ?? []), r]);
  }

  const safra = (de: string, ate: string, vistaEm?: string) =>
    contar(pedidos, porPedido, itens, de, ate, vistaEm);

  const aberta = safra(diasAntes(dia, F - 1), dia);
  const fechada = safra(diasAntes(dia, F * 2 - 1), diasAntes(dia, F));
  const anterior = safra(inicio, diasAntes(dia, F * 2));
  const fechadaNaMesmaIdade = safra(fechada.de, fechada.ate, diasAntes(dia, F));

  return {
    aberta,
    fechada,
    anterior,
    fechadaNaMesmaIdade,
    semDetalhe: aberta.semDetalhe + fechada.semDetalhe + anterior.semDetalhe,
  };
}

/**
 * Enche o cache de itens ao subir o serviço.
 *
 * Deploy novo começa com o disco vazio, e sem isso o primeiro boletim gastaria
 * vários minutos só nas reversas. Rodando no boot, em segundo plano, às 8h o
 * cache já está cheio.
 */
export async function aquecerCacheDeReversas(loja: Loja = "atual"): Promise<void> {
  if (!temTroque(loja)) return;
  const hoje = diaDe(new Date().toISOString());
  const reversas = await listar(
    { criadaDe: diasAntes(hoje, IDADE_DE_FECHAMENTO * 3 + 1), criadaAte: hoje },
    loja,
  );
  await itensDasReversas(reversas, loja);
}
