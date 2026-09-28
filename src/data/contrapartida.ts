/**
 * A pergunta que fecha o dia: todo dinheiro que a loja diz ter recebido
 * apareceu em algum lugar?
 *
 * Cada conferência responde por um pedaço — PagBank o cartão, Mercado Pago o
 * Pix de gateway, Pagar.me o link do atendimento, o extrato o Pix direto na
 * conta. Nenhuma delas responde pelo todo, e era possível o boletim ter quatro
 * blocos verdes com faturamento sem lastro no meio.
 *
 * Aqui os quatro viram uma conta só: receita do dia contra o que foi
 * efetivamente localizado, e o que sobra sai com número de pedido e motivo. É
 * a regra do Luis escrita em código — toda receita entrou num gateway ou numa
 * conta, e o que não entrou tem nome.
 */
import type { ConferenciaPagBank } from "./conferencia-pagbank.js";
import type { ConferenciaManual } from "./conferencia-manual.js";
import type { ConferenciaPix } from "./conferencia-pix.js";
import type { ResumoVendas } from "./shopify.js";

export interface Divergencia {
  pedido: string;
  valor: number;
  /** Onde deveria estar e não está. */
  motivo: string;
}

export interface Contrapartida {
  receita: number;
  /** Sem cobertura conhecida: nem gateway, nem extrato. */
  semContrapartida: number;
  divergencias: Divergencia[];
  /** Quanto do faturamento foi localizado em algum lugar. */
  localizado: number;
  cobertura: number;
  /** A parte do Pix não pode ser dada por conferida nesta leitura. */
  extratoIncompleto: boolean;
  /**
   * Por quê, em uma frase.
   *
   * Existe porque o aviso genérico culpava o banco por quatro causas
   * diferentes — inclusive as duas em que o extrato estava perfeito e quem
   * falhou foi a Pagar.me ou a própria leitura. Quem lê o boletim de manhã
   * precisa saber onde mexer.
   */
  motivoDoExtrato: string | null;
}

export function conferirContrapartida(
  vendas: ResumoVendas,
  pagbank: ConferenciaPagBank | null,
  mercadopago: ConferenciaPagBank | null,
  manual: ConferenciaManual | null,
  pix: ConferenciaPix | null,
): Contrapartida {
  const divergencias: Divergencia[] = [];

  // Pedido pago na Shopify que o gateway não tem. É o caso mais grave: a loja
  // registrou dinheiro que o adquirente não viu.
  for (const c of [pagbank, mercadopago]) {
    for (const d of c?.divergentes ?? []) {
      if (d.veredito !== "ausente") continue;
      divergencias.push({
        pedido: d.pedido,
        valor: d.valorShopify,
        motivo: `sem cobrança no ${c?.nome}`,
      });
    }
  }

  /*
   * O que foi marcado como pago à mão e não apareceu nem na Pagar.me nem no
   * extrato. Quando o extrato não veio, a linha ainda é dita, mas o relatório
   * avisa que a parte do Pix está incompleta — senão atraso do banco viraria
   * denúncia.
   */
  for (const l of pix?.semContrapartida ?? []) {
    divergencias.push({
      pedido: l.pedido,
      valor: l.valor,
      motivo:
        l.situacao === "ambiguo"
          ? `${l.candidatos} Pix do mesmo valor — sem como decidir`
          : `declarado ${l.metodo}, sem cobrança e sem Pix na conta`,
    });
  }

  // Sem o bloco do Pix, o que a Pagar.me não cobriu continua sendo dívida de
  // explicação — só que sem a segunda chance do extrato.
  if (!pix && manual) {
    for (const v of manual.vendas) {
      if (v.semRastro <= 0.01) continue;
      divergencias.push({
        pedido: v.pedido,
        valor: v.semRastro,
        motivo: `declarado ${v.metodo}, sem rastro na Pagar.me`,
      });
    }
  }

  const semContrapartida = divergencias.reduce((s, d) => s + d.valor, 0);
  const receita = vendas.receitaTotal;

  return {
    receita,
    semContrapartida,
    divergencias: divergencias.sort((a, b) => b.valor - a.valor),
    localizado: Math.max(0, receita - semContrapartida),
    cobertura: receita > 0 ? Math.max(0, receita - semContrapartida) / receita : 1,
    ...motivoDoExtrato(manual, pix),
  };
}

/** "2026-09-27T09:45:13Z" -> "27/09 06:45" (hora de Brasília). */
function quando(iso: string): string {
  const d = new Date(iso);
  const p = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
  return p.replace(",", "");
}

/**
 * As quatro maneiras de a conferência do Pix não fechar — e só uma delas é
 * culpa do banco.
 */
function motivoDoExtrato(
  manual: ConferenciaManual | null,
  pix: ConferenciaPix | null,
): { extratoIncompleto: boolean; motivoDoExtrato: string | null } {
  const incompleto = (motivo: string) => ({ extratoIncompleto: true, motivoDoExtrato: motivo });

  if (!manual) {
    return incompleto(
      "a conferência dos pedidos pagos à mão não rodou nesta leitura, então não houve o que " +
        "procurar no extrato — o problema é na Pagar.me, não no banco.",
    );
  }
  if (!pix) {
    return incompleto(
      "a leitura do extrato falhou nesta execução (Open Finance fora do ar ou sem chave), " +
        "então o Pix direto não foi conferido.",
    );
  }

  const ruins = pix.conexoes.filter((c) => c.status !== "UPDATED" || c.execucao !== "SUCCESS");
  if (ruins.length) {
    return incompleto(
      `a conexão do Open Finance com ${ruins.map((c) => c.banco).join(" e ")} não está em dia ` +
        `(${ruins.map((c) => c.execucao).join(", ")}) — pode ser preciso reconectar a conta.`,
    );
  }

  if (!pix.cobreODia && pix.coletadoAte) {
    return incompleto(
      `o provedor só coletou o extrato até ${quando(pix.coletadoAte)}, antes do fim do dia ` +
        "conferido — lançamentos do dia podem ainda não estar lá.",
    );
  }
  if (!pix.coletadoAte) {
    return incompleto(
      "não foi possível saber quando o extrato foi coletado pela última vez, então a parte do " +
        "Pix fica sem garantia de estar completa.",
    );
  }

  /*
   * Extrato coletado depois do fim do dia e conexões em dia: um dia sem
   * nenhum Pix é informação, não falha. Antes isto virava aviso vermelho todo
   * domingo.
   */
  return { extratoIncompleto: false, motivoDoExtrato: null };
}
