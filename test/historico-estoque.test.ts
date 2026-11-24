import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pasta = mkdtempSync(join(tmpdir(), "lf-estoque-"));
process.env.HISTORICO_ESTOQUE = join(pasta, "estoque.json");

const { registrarBalanco, balancoEm, movimentoAte, anteriorA, historico } = await import(
  "../src/data/historico-estoque.js"
);

/**
 * A medição de um dia carrega as vendas do dia **anterior** — é o dia que o
 * boletim daquela manhã cobriu. Confundir os dois foi o primeiro erro ao
 * escrever este teste, e seria o mesmo erro no relatório.
 */
const balanco = (medidoEm: string, noSite: number, vendidasNoDiaAnterior: number) => ({
  medidoEm,
  noSite,
  valorDeVenda: 0,
  valorDeCusto: null,
  emProducao: 0,
  prontoForaDoSite: 0,
  diaDoBoletim: (() => {
    const d = new Date(`${medidoEm}T12:00:00-03:00`);
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  })(),
  vendidasNoDia: vendidasNoDiaAnterior,
});

describe("histórico de estoque", () => {
  beforeEach(() => rmSync(process.env.HISTORICO_ESTOQUE!, { force: true }));

  it("guarda e devolve o balanço de um dia", () => {
    registrarBalanco(balanco("2026-11-20", 54069, 345));
    expect(balancoEm("2026-11-20")?.noSite).toBe(54069);
    expect(balancoEm("2026-11-19")).toBeNull();
  });

  it("sem medição anterior não inventa movimento", () => {
    registrarBalanco(balanco("2026-11-20", 54069, 345));
    expect(movimentoAte("2026-11-20")).toBeNull();
  });

  it("queda igual às vendas é reposição zero", () => {
    // Medido em 21/11: 53.724 no site, e no dia 20 saíram 345 peças.
    registrarBalanco(balanco("2026-11-20", 54069, 378));
    registrarBalanco(balanco("2026-11-21", 53724, 345));
    const m = movimentoAte("2026-11-21")!;
    expect(m.vendidas).toBe(345);
    expect(m.entraram).toBe(0);
  });

  it("deduz o que entrou mesmo sem ninguém registrar a reposição", () => {
    // O caso da Calça Tóquio: estoque sobe apesar das vendas.
    registrarBalanco(balanco("2026-11-18", 52374, 327));
    registrarBalanco(balanco("2026-11-19", 54447, 327));
    expect(movimentoAte("2026-11-19")!.entraram).toBe(54447 - 52374 + 327);
  });

  it("peça que some sem venda aparece como entrada negativa", () => {
    registrarBalanco(balanco("2026-11-20", 54069, 0));
    registrarBalanco(balanco("2026-11-21", 53000, 0));
    expect(movimentoAte("2026-11-21")!.entraram).toBe(-1069);
  });

  it("pula dia: soma as vendas de todas as medições do intervalo", () => {
    registrarBalanco(balanco("2026-11-20", 54069, 378));
    registrarBalanco(balanco("2026-11-21", 53724, 345));
    registrarBalanco(balanco("2026-11-22", 53413, 311));
    const m = movimentoAte("2026-11-22")!;
    expect(m.de).toBe("2026-11-21");
    expect(m.vendidas).toBe(311);
    expect(m.entraram).toBe(0);
  });

  it("o histórico sai em ordem e o anterior é o vizinho de trás", () => {
    registrarBalanco(balanco("2026-11-22", 53413, 238));
    registrarBalanco(balanco("2026-11-20", 54069, 345));
    expect(historico().map((b) => b.medidoEm)).toEqual(["2026-11-20", "2026-11-22"]);
    expect(anteriorA("2026-11-22")?.medidoEm).toBe("2026-11-20");
  });
});

rmSync(pasta, { recursive: true, force: true });
