import { describe, expect, it } from "vitest";
import { perguntaDeEstoqueNoSite } from "../src/whatsapp/atalhos.js";

describe("atalho: peças no site", () => {
  it.each([
    "quantas peças tem no site?",
    "Quantas peças temos no site",
    "qual o estoque do site",
    "estoque no site",
    "balanço de peças no site",
    "quantas unidades na loja?",
    "QUANTAS PECAS TEM NO SITE",
  ])("reconhece: %s", (t) => expect(perguntaDeEstoqueNoSite(t)).toBe(true));

  // Perguntas parecidas que querem outra coisa seguem para o agente.
  it.each([
    "quantas peças vendemos ontem no site?",
    "quantas peças estão na oficina",
    "estoque de tecido",
    "quantas peças em produção",
    "quanto vendemos na semana",
    "manda o boletim completo",
  ])("não sequestra: %s", (t) => expect(perguntaDeEstoqueNoSite(t)).toBe(false));
});
