import { describe, expect, it } from "vitest";
import { lerCortes } from "../src/data/cortes-texto.js";

// O formato que o Corte Pro passou a devolver em novembro/2026.
const novo = `2 corte(s), 1401 peças no total:

• CORTE 489 (codigo=489; codigo_interno=516) — Calça Barcelona Citizen ref:130 (Calça)
  No galpão | 1228 pç | resp. João Pereira | início 09/10/2026
  oficina R$ 32,00/pç = R$ 39.296,00 | entretelagem R$ 0,90/pç = R$ 1.105,20
  retirada da oficina 17/11/2026 | vencimento 12/12/2026 | a pagar
• CORTE 487B (codigo=487B; codigo_interno=514) — Calça Moletom ref:122 (Calça)
  No galpão | 173 pç | resp. João Pereira | início 28/09/2026
  oficina R$ 8,00/pç = R$ 1.384,00 | entretelagem R$ 0,00/pç = R$ 0,00
  retirada da oficina 19/11/2026 | vencimento 14/12/2026 | a pagar`;

// O formato de uma linha, de antes.
const antigo = `1 corte(s), 826 peças no total:

• CRT-027 — Casaco Londres ref:95 (Casaco) | No galpão | 826 pç | resp. Maria | início 22/05/2026 | saiu da oficina 11/08/2026`;

describe("listagem de cortes do Corte Pro", () => {
  it("lê o formato novo, de quatro linhas", () => {
    const c = lerCortes(novo);
    expect(c).toHaveLength(2);
    expect(c[0]).toMatchObject({
      codigo: "489",
      categoria: "Calça",
      status: "No galpão",
      pecas: 1228,
      inicio: "09/10/2026",
      saiuDaOficina: "17/11/2026",
    });
  });

  it("o código é o que o buscar_corte entende, não o interno", () => {
    expect(lerCortes(novo)[1].codigo).toBe("487B");
  });

  it("continua lendo o formato antigo", () => {
    const c = lerCortes(antigo);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({
      codigo: "CRT-027",
      pecas: 826,
      saiuDaOficina: "11/08/2026",
    });
  });

  it("corte na oficina não tem data de retirada", () => {
    const oficina = `1 corte(s), 735 peças no total:

• CORTE 494 (codigo=494; codigo_interno=521) — Conjuto calça Leeg e Top ref: 134,135 (Calça)
  Na oficina | 735 pç | resp. João Pereira | início 17/11/2026
  retirada da oficina — | vencimento — | aguardando saída da oficina`;
    expect(lerCortes(oficina)[0].saiuDaOficina).toBeUndefined();
  });

  it("ler menos do que o cabeçalho anuncia é erro, não resultado", () => {
    const quebrado = `3 corte(s), 100 peças no total:

• CORTE 1 (codigo=1; codigo_interno=1) — Algo (Calça)
  Na oficina | 100 pç | resp. X | início 01/11/2026`;
    expect(() => lerCortes(quebrado)).toThrow(/li 1 de 3/);
  });

  it("listagem vazia não é erro", () => {
    expect(lerCortes("0 corte(s), 0 peças no total:")).toHaveLength(0);
  });
});
