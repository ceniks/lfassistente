import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pasta = mkdtempSync(join(tmpdir(), "lf-cobranca-"));
process.env.PENDENCIAS = join(pasta, "pendencias.json");
process.env.COBRANCA_ADIADA = join(pasta, "adiada.json");
afterEach(() => undefined);

const { conciliar, marcarCobradas, emAberto, diasEntre } = await import(
  "../src/cobranca/pendencias.js"
);
const { montarCobranca } = await import("../src/cobranca/mensagem.js");

const p = (pedido: string, valor: number) => ({
  pedido,
  tipo: "sem-contrapartida" as const,
  valor,
  motivo: "sem cobrança e sem Pix na conta",
});

describe("livro de pendências", () => {
  it("o que aparece pela primeira vez é novo", () => {
    const m = conciliar("2026-11-12", [p("#1", 100)]);
    expect(m.novas.map((x) => x.pedido)).toEqual(["#1"]);
    expect(m.antigas).toHaveLength(0);
  });

  it("no dia seguinte, o mesmo pedido é antigo e guarda a data de origem", () => {
    const m = conciliar("2026-11-13", [p("#1", 100)]);
    expect(m.novas).toHaveLength(0);
    expect(m.antigas[0].desde).toBe("2026-11-12");
  });

  it("some da conferência = resolvido, sem ninguém dar baixa", () => {
    const m = conciliar("2026-11-14", []);
    expect(m.resolvidas.map((x) => x.pedido)).toEqual(["#1"]);
    expect(emAberto()).toHaveLength(0);
  });

  it("valor que muda é atualizado — cobrar o número velho seria cobrar errado", () => {
    conciliar("2026-11-14", [p("#2", 500)]);
    const m = conciliar("2026-11-15", [p("#2", 120)]);
    expect(m.antigas[0].valor).toBe(120);
  });

  it("marcar cobrada não encerra a pendência", () => {
    marcarCobradas("2026-11-15", ["#2"]);
    expect(emAberto()[0].cobradaEm).toEqual(["2026-11-15"]);
  });
});

describe("mensagem da cobrança", () => {
  it("dia limpo não gera mensagem", () => {
    expect(montarCobranca("2026-11-15", { novas: [], antigas: [], resolvidas: [] })).toBeNull();
  });

  it("nomeia pedido, valor e o que falta", () => {
    const t = montarCobranca("2026-11-15", {
      novas: [{ ...p("#145746", 613.2), desde: "2026-11-15", cobradaEm: [] }],
      antigas: [],
      resolvidas: [],
    })!;
    expect(t).toContain("#145746");
    expect(t).toContain("613,20");
    expect(t).toContain("sem cobrança e sem Pix");
  });

  it("mostra há quanto tempo está aberto, em vez de subir o tom", () => {
    const t = montarCobranca("2026-11-15", {
      novas: [],
      antigas: [{ ...p("#9", 10), desde: "2026-11-12", cobradaEm: ["2026-11-13"] }],
      resolvidas: [],
    })!;
    expect(t).toContain("aberto há 3 dias");
  });

  it("o nome de quem marcou como pago vem junto do pedido", () => {
    const t = montarCobranca("2026-11-15", {
      novas: [
        { ...p("#145746", 613.2), responsavel: "Gabriela Santos", desde: "2026-11-15", cobradaEm: [] },
      ],
      antigas: [],
      resolvidas: [],
    })!;
    expect(t).toContain("#145746 (Gabriela Santos)");
  });

  it("pedido sem responsável conhecido não ganha parênteses vazio", () => {
    const t = montarCobranca("2026-11-15", {
      novas: [{ ...p("#9", 10), desde: "2026-11-15", cobradaEm: [] }],
      antigas: [],
      resolvidas: [],
    })!;
    expect(t).toContain("#9 — R$ 10,00");
    expect(t).not.toContain("()");
  });

  it("o que fechou também é dito", () => {
    const t = montarCobranca("2026-11-15", {
      novas: [],
      antigas: [],
      resolvidas: [{ ...p("#7", 50), desde: "2026-11-10", cobradaEm: [] }],
    })!;
    expect(t).toContain("Resolvidos");
    expect(t).toContain("#7");
  });

  it("diasEntre conta dias corridos", () => {
    expect(diasEntre("2026-11-12", "2026-11-15")).toBe(3);
    expect(diasEntre("2026-11-15", "2026-11-15")).toBe(0);
  });
});

rmSync(pasta, { recursive: true, force: true });

const { pendenciasDoDia } = await import("../src/cobranca/index.js");

describe("o que entra na cobrança", () => {
  const base = {
    contrapartida: { divergencias: [] },
    manual: { vendas: [] },
    pix: null,
    comprovantes: null,
  } as never;

  const parcial = (pedido: string, semRastro: number) => ({
    pedido,
    situacao: "parcial" as const,
    semRastro,
    valor: 1000,
    metodo: "pagar.me",
    nota: undefined,
  });

  it("parcial sem cobertura é cobrada", () => {
    const d = { ...base, manual: { vendas: [parcial("#1", 210.25)] } } as never;
    expect(pendenciasDoDia(d).map((p) => p.pedido)).toEqual(["#1"]);
  });

  it("parcial que o extrato casou não é cobrada", () => {
    // O #146356: R$ 1.250 no link e R$ 210,25 por Pix, os dois encontrados.
    const d = {
      ...base,
      manual: { vendas: [parcial("#146356", 210.25)] },
      pix: { casados: [{ pedido: "#146356" }], semContrapartida: [] },
    } as never;
    expect(pendenciasDoDia(d)).toHaveLength(0);
  });

  it("parcial que o comprovante fechou não é cobrada", () => {
    const d = {
      ...base,
      manual: { vendas: [parcial("#2", 50)] },
      comprovantes: { pedidos: [{ pedido: "#2", fecha: true }] },
    } as never;
    expect(pendenciasDoDia(d)).toHaveLength(0);
  });

  it("comprovante que não fechou não protege o pedido", () => {
    const d = {
      ...base,
      manual: { vendas: [parcial("#3", 50)] },
      comprovantes: { pedidos: [{ pedido: "#3", fecha: false }] },
    } as never;
    expect(pendenciasDoDia(d)).toHaveLength(1);
  });

  it("não duplica o pedido que já está em sem-contrapartida", () => {
    const d = {
      ...base,
      contrapartida: { divergencias: [{ pedido: "#4", valor: 100, motivo: "sem cobrança" }] },
      manual: { vendas: [parcial("#4", 100)] },
    } as never;
    expect(pendenciasDoDia(d)).toHaveLength(1);
  });
});

const { adiar, lerAdiada, limparAdiada } = await import("../src/cobranca/adiada.js");

describe("dia adiado", () => {
  it("anota o dia e conta as tentativas", () => {
    limparAdiada();
    adiar("2026-11-18", "conferência incompleta");
    adiar("2026-11-18", "conferência incompleta");
    const a = lerAdiada()!;
    expect(a.dia).toBe("2026-11-18");
    expect(a.tentativas).toBe(2);
  });

  it("dia novo recomeça a contagem", () => {
    adiar("2026-11-19", "conferência incompleta");
    expect(lerAdiada()!.tentativas).toBe(1);
  });

  it("limpar apaga o registro", () => {
    limparAdiada();
    expect(lerAdiada()).toBeNull();
  });
});
