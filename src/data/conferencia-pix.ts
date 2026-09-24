/**
 * O Pix que cai direto na conta, casado com o pedido.
 *
 * É a última fatia do faturamento sem contrapartida automática. O resto do dia
 * fecha sozinho — cartão no PagBank, Pix de gateway no Mercado Pago, link no
 * Pagar.me —, mas o Pix mandado direto para a conta da L&F só existia como
 * marcação de atendente na Shopify. Com o extrato do Open Finance ele vira
 * dinheiro localizável.
 *
 * Três decisões moldam o casamento:
 *
 * **A janela é de três dias.** Pix chega antes do pedido ser lançado e depois
 * também: no dia 22/09 o pagamento da Esther caiu 15h48 e o pedido foi
 * registrado no dia seguinte. Cobrar o mesmo dia perderia casos reais.
 *
 * **Valor igual não é prova.** R$ 399,80 aparece em dois pedidos diferentes na
 * mesma semana. Quando mais de um Pix serve para o mesmo pedido — ou o mesmo
 * Pix serve para dois pedidos — a linha vira "ambíguo" e espera olho humano,
 * em vez de casar por sorteio.
 *
 * **O nome confirma, não elimina.** O extrato traz quem pagou; o pedido traz o
 * e-mail da cliente. Quando os dois conversam, a linha sai como confirmada.
 * Quando não, continua casada pelo valor, mas marcada como provável — porque
 * marido paga a compra da esposa o tempo todo.
 */
import {
  entradasPix,
  sincronizarComTeto,
  temOpenFinance,
  type EntradaPix,
} from "./openfinance.js";
import { config } from "../config.js";
import type { ConferenciaManual, PedidoManual } from "./conferencia-manual.js";

const TOLERANCIA = 0.1;

export type SituacaoPix = "confirmado" | "provavel" | "ambiguo" | "sem-contrapartida";

export interface PedidoComPix {
  pedido: string;
  valor: number;
  metodo: string;
  email: string;
  situacao: SituacaoPix;
  pix?: { quando: string; valor: number; quem: string };
  /** Quantos Pix diferentes serviriam para este pedido. */
  candidatos: number;
}

export interface ConferenciaPix {
  dia: string;
  /**
   * O extrato não veio.
   *
   * Sem isto, banco fora do ar vira "nenhum pedido tem contrapartida" — e o
   * boletim acusa o financeiro de um problema que é da conexão.
   */
  semExtrato: boolean;
  /** O provedor foi chamado para atualizar o extrato antes desta leitura. */
  sincronizou: boolean;
  /**
   * Data e hora do lançamento mais recente que o extrato trouxe.
   *
   * O Open Finance atualiza em lote, e no dia seguinte o extrato ainda pode
   * estar na véspera. Sem este dado, um extrato atrasado viraria "pedido sem
   * contrapartida" — parece problema do financeiro e é atraso do banco.
   */
  atualizadoAte: string | null;
  /** Entradas por Pix na conta no dia. */
  entradas: { quantidade: number; valor: number };
  casados: PedidoComPix[];
  semContrapartida: PedidoComPix[];
  /** Quanto do faturamento do dia continua sem nenhuma contrapartida. */
  valorSemContrapartida: number;
  valorCasado: number;
  /** Pix que entrou e nenhum pedido reivindicou, dentro da faixa de um pedido. */
  entradasSemPedido: EntradaPix[];
}

const normalizar = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * O e-mail conversa com o nome de quem pagou?
 *
 * Sem nome da cliente no pedido, o e-mail é o que há. "marquesesther@..." e
 * "ESTHER SIQUEIRA MONTEIRO MARQUES" casam por dois pedaços; um pedaço só
 * ("silva") não vale, porque casaria com meio Brasil.
 */
export function emailBateComNome(email: string, quem: string): boolean {
  const usuario = normalizar(email.split("@")[0] ?? "").replace(/[0-9]/g, "");
  if (usuario.length < 4) return false;
  const partes = normalizar(quem).split(" ").filter((p) => p.length >= 4);
  const casam = partes.filter((p) => usuario.includes(p));
  return casam.length >= 2 || casam.some((p) => p.length >= 8);
}

const diasEmVolta = (dia: string, n: number) => {
  const d = new Date(`${dia}T12:00:00-03:00`);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * Faixa de valor que um pedido da loja pode ter.
 *
 * Serve só para a lista inversa — Pix que entrou e ninguém reivindicou. Sem
 * isso, aporte de sócio e transferência entre contas apareceriam como venda
 * misteriosa todo dia.
 */
const MINIMO_DE_PEDIDO = 50;
const MAXIMO_DE_PEDIDO = 5000;

export async function conferirPixDireto(
  dia: string,
  manual: ConferenciaManual | null,
): Promise<ConferenciaPix | null> {
  if (!temOpenFinance() || !manual) return null;

  // Pede ao provedor que visite o banco antes de ler — ver `sincronizarComTeto`.
  const sincronizou = config().OPENFINANCE_SINCRONIZAR
    ? await sincronizarComTeto()
    : false;

  const entradas = await entradasPix(diasEmVolta(dia, -1), diasEmVolta(dia, 1));
  const semExtrato = entradas.length === 0;
  const atualizadoAte =
    entradas.map((e) => e.quando).sort().at(-1) ?? null;

  /*
   * Quem ainda deve explicação: o que a Pagar.me não cobriu, mais o que a
   * atendente declarou como Pix. Estes últimos têm `semRastro` zero por
   * construção — não há gateway onde procurar —, e são justamente os que o
   * extrato existe para confirmar.
   */
  const pendentes = manual.vendas.filter(
    (v) => v.semRastro > TOLERANCIA || v.situacao === "pix-direto",
  );
  const devido = (v: PedidoManual) =>
    v.situacao === "pix-direto" ? v.valor : v.semRastro;

  const usados = new Map<string, string[]>();
  const resultado: PedidoComPix[] = [];

  for (const v of pendentes) {
    const candidatos = entradas.filter((e) => Math.abs(e.valor - devido(v)) <= TOLERANCIA);
    for (const c of candidatos) usados.set(c.id, [...(usados.get(c.id) ?? []), v.pedido]);
    resultado.push(montar(v, devido(v), candidatos));
  }

  // Um Pix que dois pedidos reivindicam não confirma nenhum dos dois.
  for (const linha of resultado) {
    if (linha.situacao === "sem-contrapartida" || !linha.pix) continue;
    const id = entradas.find((e) => e.quando === linha.pix!.quando && e.valor === linha.pix!.valor)?.id;
    if (id && (usados.get(id)?.length ?? 0) > 1) {
      linha.situacao = "ambiguo";
      linha.candidatos = Math.max(linha.candidatos, usados.get(id)!.length);
    }
  }

  const doDia = entradas.filter((e) => e.dia === dia);
  const casados = resultado.filter((l) => l.situacao === "confirmado" || l.situacao === "provavel");
  const semContrapartida = resultado.filter(
    (l) => l.situacao === "sem-contrapartida" || l.situacao === "ambiguo",
  );

  return {
    dia,
    semExtrato,
    sincronizou,
    atualizadoAte,
    entradas: {
      quantidade: doDia.length,
      valor: doDia.reduce((s, e) => s + e.valor, 0),
    },
    casados,
    semContrapartida,
    valorCasado: casados.reduce((s, l) => s + l.valor, 0),
    valorSemContrapartida: semContrapartida.reduce((s, l) => s + l.valor, 0),
    entradasSemPedido: doDia.filter(
      (e) =>
        !usados.has(e.id) && e.valor >= MINIMO_DE_PEDIDO && e.valor <= MAXIMO_DE_PEDIDO,
    ),
  };
}

function montar(v: PedidoManual, valor: number, candidatos: EntradaPix[]): PedidoComPix {
  const base = {
    pedido: v.pedido,
    valor,
    metodo: v.metodo,
    email: v.email,
    candidatos: candidatos.length,
  };

  if (!candidatos.length) return { ...base, situacao: "sem-contrapartida" };

  const porNome = candidatos.filter((c) => emailBateComNome(v.email, c.quem));
  if (porNome.length === 1) {
    const p = porNome[0];
    return { ...base, situacao: "confirmado", pix: { quando: p.quando, valor: p.valor, quem: p.quem } };
  }

  if (candidatos.length === 1) {
    const p = candidatos[0];
    return { ...base, situacao: "provavel", pix: { quando: p.quando, valor: p.valor, quem: p.quem } };
  }

  return { ...base, situacao: "ambiguo" };
}
