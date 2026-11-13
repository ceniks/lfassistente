/**
 * O texto que vai para o grupo do atendimento.
 *
 * Três regras de forma, e todas vêm do mesmo risco: cobrança automática que
 * vira ruído deixa de ser lida, e aí o sistema piora a operação em vez de
 * melhorá-la.
 *
 *  1. **Só pedido com nome e número.** Nada de "há divergências hoje" — quem
 *     lê precisa saber o que fazer sem abrir outro sistema.
 *  2. **O que falta, em uma linha.** "Sem cobrança e sem Pix" e "pago em
 *     parte" pedem ações diferentes de pessoas diferentes.
 *  3. **Tempo em aberto aparece.** É o que distingue cobrar de insistir, sem
 *     precisar escrever "de novo" ou subir o tom.
 */
import type { Movimento, Pendencia } from "./pendencias.js";
import { diasEntre } from "./pendencias.js";

const dinheiro = (v: number) =>
  `R$ ${v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const curto = (dia: string) => dia.split("-").reverse().slice(0, 2).join("/");

/** Quantos pedidos cabem antes de a mensagem virar parede de texto. */
const TETO = 15;

function linha(p: Pendencia, hoje: string): string {
  const dias = diasEntre(p.desde, hoje);
  const idade = dias === 0 ? "" : dias === 1 ? " · aberto desde ontem" : ` · aberto há ${dias} dias`;
  return `• ${p.pedido} — ${dinheiro(p.valor)} — ${p.motivo}${idade}`;
}

/**
 * Monta a cobrança. Devolve `null` quando não há o que cobrar — silêncio em
 * dia limpo é parte do desenho: se a mensagem vier todo dia, ninguém percebe
 * o dia em que ela importa.
 */
export function montarCobranca(dia: string, m: Movimento): string | null {
  const abertas = [...m.novas, ...m.antigas].sort((a, b) => b.valor - a.valor);
  if (!abertas.length && !m.resolvidas.length) return null;

  const partes: string[] = [];

  if (abertas.length) {
    const total = abertas.reduce((s, p) => s + p.valor, 0);
    partes.push(
      `*Conferência de ${curto(dia)}* — ${abertas.length} pedido(s) sem explicação, ${dinheiro(total)}`,
      "",
      ...abertas.slice(0, TETO).map((p) => linha(p, dia)),
    );
    if (abertas.length > TETO) {
      partes.push(`• …e mais ${abertas.length - TETO} pedido(s) no boletim.`);
    }
    partes.push(
      "",
      "Se o pagamento existe, anexem o comprovante no pedido — a conferência encontra sozinha e a cobrança para.",
    );
  }

  /*
   * O que fechou também é dito. Sem isso a lista só cresce aos olhos de quem
   * lê, e a sensação de que nada adianta é o que mata uma cobrança recorrente.
   */
  if (m.resolvidas.length) {
    const total = m.resolvidas.reduce((s, p) => s + p.valor, 0);
    partes.push(
      "",
      `✅ Resolvidos: ${m.resolvidas.length} pedido(s), ${dinheiro(total)} — ${m.resolvidas
        .slice(0, 8)
        .map((p) => p.pedido)
        .join(", ")}`,
    );
  }

  return partes.join("\n");
}
