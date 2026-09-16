import type { NovosVsRecorrentes, ResumoVendas, Trafego } from "../data/shopify.js";
import { reposicao, type Cobertura } from "../data/cobertura.js";
import type { Patrimonio } from "../data/patrimonio.js";
import type { Conciliacao } from "../data/conciliacao.js";
import type { MidiaMeta, FluxoTemplate } from "../data/meta.js";
import type { Producao } from "../data/producao.js";
import type { Atendimento } from "../data/atendimento.js";
import type { Reversas } from "../data/troque.js";

/* ------------------------------------------------------------------ *
 * Formatadores
 * ------------------------------------------------------------------ */

const brl = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  maximumFractionDigits: 0,
});

const brlCentavos = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  minimumFractionDigits: 2,
});

export const dinheiro = (v: number) => brl.format(v);
export const dinheiroExato = (v: number) => brlCentavos.format(v);

export const pct = (v: number, casas = 1) =>
  `${(v * 100).toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas })}%`;

export const numero = (v: number, casas = 0) =>
  v.toLocaleString("pt-BR", {
    minimumFractionDigits: casas,
    maximumFractionDigits: casas,
  });

/** Variação relativa, com sinal. Devolve string vazia se a base for zero. */
export function variacao(atual: number, base: number): string {
  if (!base) return "";
  const d = (atual - base) / base;
  const sinal = d >= 0 ? "+" : "";
  return `${sinal}${(d * 100).toLocaleString("pt-BR", { maximumFractionDigits: 0 })}%`;
}

const DIAS = [
  "domingo",
  "segunda",
  "terça",
  "quarta",
  "quinta",
  "sexta",
  "sábado",
];
const MESES = [
  "jan",
  "fev",
  "mar",
  "abr",
  "mai",
  "jun",
  "jul",
  "ago",
  "set",
  "out",
  "nov",
  "dez",
];

export function dataPorExtenso(dia: string): string {
  const [a, m, d] = dia.split("-").map(Number);
  const date = new Date(Date.UTC(a, m - 1, d));
  return `${DIAS[date.getUTCDay()]}, ${String(d).padStart(2, "0")}/${MESES[m - 1]}`;
}

/* ------------------------------------------------------------------ *
 * O resumo
 * ------------------------------------------------------------------ */

export interface DadosResumo {
  dia: string;
  vendas: ResumoVendas;
  vendasMedia7d: Pick<ResumoVendas, "receita" | "pedidos" | "ticketMedio"> & {
    descontoPct: number;
  };
  trafego: Trafego;
  trafegoMedia7d: Pick<Trafego, "sessoes" | "taxaAdicao" | "conversao">;
  meta: number | null;
  midia?: MidiaMeta | null;
  google?: { valorPago: number; receita: number; roas: number } | null;
  fluxos: FluxoTemplate[];
  producao?: Producao | null;
  atendimento?: Atendimento | null;
  reversas?: Reversas | null;
  estornos?: Conciliacao | null;
  clientes?: NovosVsRecorrentes | null;
  cobertura?: Cobertura[] | null;
  media7dPorHora?: Array<{ hora: number; receita: number }>;
  patrimonio?: Patrimonio | null;
  /** Uma ou duas frases escritas pelo agente lendo os números acima. */
  leitura?: string;
}

export function montarResumo(d: DadosResumo): string {
  const b: string[] = [];

  b.push(`☀️ L&F · ${dataPorExtenso(d.dia)}`);

  // --- Faturamento ---
  const v = d.vendas;
  const linhas = [
    "",
    "💰 FATURAMENTO",
    `${dinheiro(v.receita)} · ${numero(v.pedidos)} pedidos pagos`,
  ];

  if (d.meta !== null) {
    const atingido = d.meta > 0 ? v.receita / d.meta : 0;
    const falta = d.meta - v.receita;
    linhas.push(
      falta > 0
        ? `Meta ${dinheiro(d.meta)} · ${pct(atingido, 0)} · faltou ${dinheiro(falta)}`
        : `Meta ${dinheiro(d.meta)} · ${pct(atingido, 0)} ✅ bateu`,
    );
  }

  const varReceita = variacao(v.receita, d.vendasMedia7d.receita);
  const varPedidos = variacao(v.pedidos, d.vendasMedia7d.pedidos);
  if (varReceita)
    linhas.push(`vs média 7d: ${varReceita} receita, ${varPedidos} pedidos`);
  linhas.push(
    `Ticket ${dinheiro(v.ticketMedio)} (7d: ${dinheiro(d.vendasMedia7d.ticketMedio)})`,
  );

  if (d.clientes) {
    const c = d.clientes;
    const comCliente = c.pedidosNovos + c.pedidosRecorrentes;
    if (comCliente > 0) {
      const receita = c.receitaNovos + c.receitaRecorrentes;
      linhas.push(
        `Novos ${pct(c.pedidosNovos / comCliente)} · recompra ${pct(c.pedidosRecorrentes / comCliente)} ` +
          `(receita: ${pct(receita > 0 ? c.receitaRecorrentes / receita : 0)} de recompra)`,
      );
    }
  }

  if (v.excluidos.trocas || v.excluidos.influencers || v.excluidos.reenvios) {
    const fora: string[] = [];
    if (v.excluidos.trocas) fora.push(`${v.excluidos.trocas} troca(s)`);
    if (v.excluidos.influencers)
      fora.push(`${v.excluidos.influencers} influencer`);
    if (v.excluidos.reenvios) fora.push(`${v.excluidos.reenvios} reenvio(s)`);
    linhas.push(`Fora da conta: ${fora.join(" · ")}`);
  }
  b.push(linhas.join("\n"));

  // --- Desconto ---
  const bruto = v.receita + v.desconto.total;
  const desc = ["", "🏷️ DESCONTO"];
  desc.push(
    `${pct(bruto > 0 ? v.desconto.total / bruto : 0)} do bruto (7d: ${pct(d.vendasMedia7d.descontoPct)})`,
  );
  desc.push(`Promoção do site ${dinheiro(v.desconto.promocaoAutomatica)}`);
  desc.push(`Cupom de venda ${dinheiro(v.desconto.cupom)}`);
  desc.push(
    v.desconto.seedingInfluencer > 0
      ? `Seeding influencer ${dinheiro(v.desconto.seedingInfluencer)} · ${v.excluidos.influencers} pedidos`
      : "Seeding influencer: nenhum no dia",
  );

  if (v.cuponsMaisUsados.length) {
    desc.push(
      "Cupons mais usados: " +
        v.cuponsMaisUsados
          .map((c) => `${c.codigo} ${numero(c.pedidos)}x (${dinheiro(c.valor)})`)
          .join(" · "),
    );
  }

  // Trocas entram aqui, e não no faturamento, porque não são venda nova. Mas o
  // valor que elas carregam é dinheiro que saiu da loja e precisa ser visto.
  const tro = v.trocasDoDia;
  if (tro.total > 0) {
    desc.push(`Trocas pagas no dia: ${numero(tro.total)} pedidos`);
    if (tro.porCupom.pedidos > 0) {
      desc.push(
        `  por cupom ${numero(tro.porCupom.pedidos)} · ${dinheiro(tro.porCupom.valor)} em cupom`,
      );
    }
    if (tro.direta.pedidos > 0) {
      desc.push(
        `  troca direta ${numero(tro.direta.pedidos)} · ${numero(tro.direta.pecas)} peças · ` +
          `${dinheiro(tro.direta.valorAPrecoDeSite)} a preço de site`,
      );
    }
  } else {
    desc.push("Trocas pagas no dia: nenhuma");
  }
  b.push(desc.join("\n"));

  // --- Top 10 ---
  if (v.topProdutos.length) {
    const top = ["", "🏆 TOP 10 · peças vendidas"];
    v.topProdutos.forEach((p, i) => {
      top.push(
        `${i + 1} ${p.titulo} — ${numero(p.pecas)} · ${dinheiro(p.receita)}`,
      );
    });
    top.push(
      `${numero(v.pecas)} peças / ${numero(v.pedidos)} pedidos = ${numero(v.pecasPorPedido, 2)} por pedido`,
    );
    b.push(top.join("\n"));
  }

  // --- Categorias ---
  if (v.categorias.length) {
    const cat = ["", "👗 POR CATEGORIA"];
    for (const c of v.categorias) {
      cat.push(
        `${c.categoria} ${numero(c.pecas)} peças · ${pct(c.participacao)} · ${dinheiro(c.receita)}`,
      );
    }
    b.push(cat.join("\n"));
  }

  // --- Ritmo do dia ---
  // Quatro marcos e a diferença contra o normal da mesma hora. Sem a
  // comparação o número não orienta ação nenhuma.
  if (d.vendas.porHora?.length && d.media7dPorHora?.length) {
    const r = ["", "⏱️ RITMO DO DIA"];
    for (const h of d.vendas.porHora) {
      const m = d.media7dPorHora.find((x) => x.hora === h.hora)?.receita ?? 0;
      r.push(
        `${String(h.hora).padStart(2, "0")}h: ${dinheiro(h.receita)}` +
          (m > 0 ? ` · ${variacao(h.receita, m)} vs média 7d` : ""),
      );
    }
    b.push(r.join("\n"));
  }

  // --- Check-in do estoque ---
  // Três números e nada mais: o resumo do WhatsApp é para ler no semáforo. O
  // detalhe por corte fica no PDF.
  if (d.patrimonio) {
    const p = d.patrimonio;
    const est = ["", "🧵 ESTOQUE HOJE"];
    est.push(
      `No site: ${numero(p.loja.pecas)} peças · ${dinheiro(p.loja.valorDeVenda)} de venda` +
        (p.loja.valorDeCusto !== null ? ` · ${dinheiro(p.loja.valorDeCusto)} de custo` : ""),
    );
    est.push(`Em produção: ${numero(p.emProducao.pecas)} peças`);
    est.push(
      p.semSubirNoSite.pecas > 0
        ? `⚠️ Pronto e fora do site: ${numero(p.semSubirNoSite.pecas)} peças em ${numero(p.semSubirNoSite.cortes)} corte(s)`
        : "Nada pronto esperando entrada no site",
    );
    b.push(est.join("\n"));
  }

  // --- Estoque dos campeões ---
  // Só os apertados entram no resumo do WhatsApp. Listar os dez com cobertura
  // confortável ocuparia meia tela para dizer "está tudo bem" — no PDF cabem
  // todos, aqui cabe o que exige ação.
  if (d.cobertura?.length) {
    // A pior das duas leituras manda: a de 15 dias dá a base, a de 7 pega quem
    // acelerou nesta semana e ainda aparece confortável na média longa.
    const pior = (c: Cobertura) => {
      const vs = [c.diasDeCobertura, c.diasDeCobertura7d].filter((x): x is number => x !== null);
      return vs.length ? Math.min(...vs) : null;
    };

    const apertados = d.cobertura
      .filter((c) => (pior(c) ?? Infinity) <= 14)
      .sort((a, b) => (pior(a) ?? 0) - (pior(b) ?? 0));

    const est = ["", "📦 ESTOQUE DOS CAMPEÕES"];
    if (apertados.length) {
      for (const c of apertados) {
        const dias = numero(pior(c) ?? 0, 1);
        est.push(
          `⚠️ ${c.titulo} — ${numero(c.estoque ?? 0)} peças, ${dias} dias` +
            (reposicao(c) > 0
              ? ` · ${numero(reposicao(c))} de reposição` +
                (c.prontasNoGalpao > 0
                  ? ` (${numero(c.prontasNoGalpao)} prontas no galpão, sem subir no site)`
                  : "")
              : " · nada de reposição"),
        );
      }
    } else {
      est.push("Nenhum campeão abaixo de 14 dias de cobertura");
    }
    b.push(est.join("\n"));
  }

  // --- Tráfego ---
  const t = d.trafego;
  b.push(
    [
      "",
      "📊 TRÁFEGO",
      `${numero(t.sessoes)} sessões (7d: ${numero(d.trafegoMedia7d.sessoes)}) ${variacao(t.sessoes, d.trafegoMedia7d.sessoes)}`,
      `Adição ao carrinho ${pct(t.taxaAdicao, 2)} (7d: ${pct(d.trafegoMedia7d.taxaAdicao, 2)})`,
      `${numero(t.checkoutsIniciados)} checkouts · ${numero(t.checkoutsConcluidos)} concluídos`,
      `Conversão ${pct(t.conversao, 2)} (7d: ${pct(d.trafegoMedia7d.conversao, 2)}) ${variacao(t.conversao, d.trafegoMedia7d.conversao)}`,
    ].join("\n"),
  );

  // --- Mídia ---
  const m = d.midia;
  if (m) {
    const mid = ["", "📣 MÍDIA"];
    mid.push(
      `Meta pago ${dinheiro(m.valorPago)} (líq. ${dinheiro(m.gastoLiquido)} + imposto)`,
    );
    mid.push(`ROAS ${numero(m.roas, 2)} · ${numero(m.compras)} compras`);
    mid.push(
      `CPA ${dinheiro(m.cpa)} · CPM ${dinheiroExato(m.cpm)} · CPC ${dinheiroExato(m.cpc)} (líquidos)`,
    );

    if (d.google) {
      // Sem imposto, por definição: o valor da API do Google já é o cobrado.
      mid.push(
        `Google pago ${dinheiro(d.google.valorPago)} · ${dinheiro(d.google.receita)} em vendas · ROAS ${numero(d.google.roas, 2)}`,
      );
    } else {
      mid.push("Google: não conectado");
    }

    const gastoTotal = m.valorPago + (d.google?.valorPago ?? 0);
    if (gastoTotal > 0) {
      // O total investido é a linha que responde "quanto saiu do caixa hoje".
      // Meta com imposto, Google sem — porque o valor da API do Google já é o
      // cobrado. Somar os dois sem esse cuidado subestimaria o Meta em 13,8%.
      mid.push(`Total investido ${dinheiro(gastoTotal)}`);
      mid.push(
        `ROAS total ${numero(v.receita / gastoTotal, 2)} · mídia = ${pct(gastoTotal / v.receita)} da receita`,
      );
    }
    b.push(mid.join("\n"));
  }

  // --- Produção ---
  if (d.producao) {
    const pr = d.producao;
    const p = ["", "✂️ PRODUÇÃO"];
    p.push(
      `${numero(pr.naOficina)} cortes na oficina · ${numero(pr.atrasados)} atrasados`,
    );
    if (pr.maisCritico) {
      const dias = pr.diasDeAtrasoDoMaisCritico;
      p.push(
        `Mais crítico: ${pr.maisCritico}${dias ? ` — ${numero(dias)} dias` : ""}`,
      );
    }
    b.push(p.join("\n"));
  }

  // --- Atendimento ---
  if (d.atendimento) {
    const a = d.atendimento;
    const at = ["", "💬 FILA DE ATENDIMENTO"];
    at.push(
      `${numero(a.aguardando)} aguardando · ${a.porCanal.map((c) => `${c.total} ${c.canal}`).join(", ")}`,
    );
    if (a.porAtendente.length) {
      at.push(a.porAtendente.map((x) => `· ${x.nome}: ${x.total}`).join("\n"));
    }
    if (a.semAtendente > 0)
      at.push(`⚠️ ${a.semAtendente} sem atendente atribuído`);
    b.push(at.join("\n"));

    const fl = ["", "📨 FLUXOS DO DIA"];
    if (d.fluxos.length) {
      for (const f of d.fluxos) {
        fl.push(
          `${f.template}: ${numero(f.enviadas)} enviadas · ${numero(f.lidas)} lidas`,
        );
      }
    }
    if (a.carrinhos) {
      const c = a.carrinhos;
      fl.push(
        `Carrinho abandonado: ${numero(c.naLoja.total)} na loja (${numero(c.naLoja.comTelefone)} com telefone) · ` +
          `${numero(c.noAtendimento.total)} no atendimento · ${numero(c.noAtendimento.disparados)} disparados`,
      );
      if (c.noAtendimento.naoChegaram > 0) {
        const base = c.noAtendimento.disparados || 1;
        // Percentual primeiro: "28 disparos com erro (22%)" fez o agente ler o
        // 28 como percentual e escrever "28% de erro" na análise do dia.
        fl.push(
          `⚠️ ${pct(c.noAtendimento.naoChegaram / base, 0)} não chegaram no WhatsApp — ${numero(c.noAtendimento.naoChegaram)} de ${numero(c.noAtendimento.disparados)}`,
        );
      }
      if (c.semCarrinho.length > 0) {
        fl.push(
          `⚠️ ${numero(c.semCarrinho.length)} abandonados com telefone ficaram fora da régua (${dinheiro(c.semCarrinho.reduce((t, x) => t + x.valor, 0))})`,
        );
      }
      if (c.noAtendimento.compraramDepois > 0) {
        fl.push(`${numero(c.noAtendimento.compraramDepois)} compraram depois do disparo`);
      }
    }

    if (a.reguas.length) {
      const enviadas = a.reguas.reduce((t, r) => t + r.enviadas, 0);
      const falhas = a.reguas.reduce((t, r) => t + r.falhas, 0);
      const receita = a.reguas.reduce((t, r) => t + r.receita, 0);
      fl.push(
        `Réguas de WhatsApp: ${numero(enviadas)} enviadas · ${numero(falhas)} falhas · ${dinheiro(receita)} atribuídos`,
      );
      for (const r of a.reguas) {
        fl.push(
          `  ${r.nome}: ${numero(r.enviadas)} enviadas` +
            (r.falhas > 0 ? ` · ${numero(r.falhas)} falhas` : "") +
            (r.conversoes > 0 ? ` · ${numero(r.conversoes)} compras (${dinheiro(r.receita)})` : ""),
        );
      }
    }
    if (a.npsSeteDias !== null) {
      fl.push(
        `NPS 7d: ${numero(a.npsSeteDias)} · ${numero(a.npsRespostas)} respostas`,
      );
    }
    b.push(fl.join("\n"));
  }

  // --- Trocas ---
  if (d.reversas) {
    const t = d.reversas;
    const tr = ["", "🔄 TROCAS E DEVOLUÇÕES"];
    tr.push(
      `${numero(t.abertas)} abertas — ${t.aberturasPorTipo.troca} troca · ` +
        `${t.aberturasPorTipo.estorno} estorno` +
        (t.aberturasPorTipo.sem_reembolso ? ` · ${t.aberturasPorTipo.sem_reembolso} sem reembolso` : ""),
    );
    tr.push(
      `${numero(t.concluidas)} ${t.concluidas === 1 ? "concluída" : "concluídas"} · ${numero(t.canceladas)} canceladas` +
        (t.valorTroca > 0 ? ` · ${dinheiro(t.valorTroca)} em diferença` : ""),
    );
    if (t.valorEstorno > 0 || t.valorRetido > 0) {
      tr.push(`Estornado ${dinheiro(t.valorEstorno)} · retido em crédito ${dinheiro(t.valorRetido)}`);
    }
    if (t.motivos.length) {
      tr.push(`Motivo nº1: ${t.motivos[0].motivo} (${t.motivos[0].total})`);
    }
    // O passivo vem por último e com alerta porque é o que ninguém vê.
    if (t.envelhecidas > 0) {
      tr.push(
        `⚠️ ${numero(t.envelhecidas)} abertas há +30 dias` +
          (t.gargalo ? ` · maior fila: ${t.gargalo.status} (${numero(t.gargalo.total)})` : ""),
      );
    }
    if (t.travadas > 0) tr.push(`${numero(t.travadas)} esperando a cliente postar há +7 dias`);

    // O confronto pedido a pedido é o ponto: "finalizada" no Troquecommerce não
    // quer dizer que o dinheiro saiu, e comparar só os totais confunde
    // descompasso de data com dinheiro que não saiu.
    if (d.estornos) {
      const c = d.estornos;
      tr.push(
        `Estorno Shopify ${dinheiro(c.shopify.valor)}` +
          (c.shopify.pendente > 0 ? ` (+${dinheiro(c.shopify.pendente)} pendente)` : "") +
          ` · Troquecommerce ${dinheiro(c.troque.valor)}`,
      );

      const listar = (xs: Array<{ pedido: string }>) => {
        const nomes = xs.slice(0, 4).map((x) => x.pedido).join(", ");
        return xs.length > 4 ? `${nomes} +${xs.length - 4}` : nomes;
      };

      const limpo =
        !c.soShopify.length && !c.soTroque.length && !c.valorDiferente.length;

      if (limpo) {
        tr.push(`✅ Os dois lados batem — ${numero(c.batem)} pedidos conferidos`);
      } else {
        if (c.soShopify.length) {
          tr.push(
            `⚠️ ${numero(c.soShopify.length)} só na Shopify (saiu sem reversa finalizada): ${listar(c.soShopify)}`,
          );
        }
        if (c.soTroque.length) {
          tr.push(
            `⚠️ ${numero(c.soTroque.length)} só no Troquecommerce (finalizado sem saída): ${listar(c.soTroque)}`,
          );
        }
        for (const x of c.valorDiferente.slice(0, 3)) {
          tr.push(
            `⚠️ ${x.pedido} valor diferente: Shopify ${dinheiro(x.shopify)} vs Troque ${dinheiro(x.troque)}`,
          );
        }
        if (c.valorDiferente.length > 3) {
          tr.push(`⚠️ +${c.valorDiferente.length - 3} com valor diferente`);
        }
      }
    }
    b.push(tr.join("\n"));
  }

  // --- Leitura do agente ---
  if (d.leitura) {
    b.push(["", "📌 LEITURA DO DIA", d.leitura.trim()].join("\n"));
  }

  return b.join("\n");
}
