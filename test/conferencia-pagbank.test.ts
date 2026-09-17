import { describe, expect, it } from "vitest";

/**
 * A conferência do gateway tem uma regra que erra silenciosamente se for
 * escrita errada: ausência de cobrança e falha de rede parecem a mesma coisa
 * do lado de fora, e tratar as duas igual inventaria divergência todo dia que
 * o PagBank tossir. Estes testes fixam a distinção e a tolerância de centavo.
 */
import { conferir, TOLERANCIA } from "../src/data/conferencia-pagbank.js";
import type { Cobranca } from "../src/data/pagbank.js";

const cobranca = (p: Partial<Cobranca> = {}): Cobranca => ({
  id: "CHAR_1",
  referencia: "ref1",
  status: "PAID",
  valor: 100,
  pago: 100,
  estornado: 0,
  pagoEm: "2026-09-16T10:00:00-03:00",
  metodo: "CREDIT_CARD",
  parcelas: 3,
  ...p,
});

const linha = {
  pedido: "#1",
  gateway: "PagBank - Cartão de Crédito",
  referencia: "ref1",
  valor: 100,
};

describe("conferência do gateway", () => {
  it("aprova quando valor e status batem", () => {
    expect(conferir(linha, cobranca()).veredito).toBe("ok");
  });

  it("acusa ausência quando o PagBank não conhece a referência", () => {
    const r = conferir(linha, null);
    expect(r.veredito).toBe("ausente");
    expect(r.explicacao).toContain("não conhece");
  });

  it("acusa status quando a cobrança não está paga", () => {
    expect(conferir(linha, cobranca({ status: "WAITING" })).veredito).toBe(
      "status",
    );
  });

  it("acusa valor quando a diferença passa da tolerância", () => {
    expect(
      conferir(linha, cobranca({ pago: 100 + TOLERANCIA * 2 })).veredito,
    ).toBe("valor");
  });

  it("ignora diferença de arredondamento dentro da tolerância", () => {
    expect(
      conferir(linha, cobranca({ pago: 100 + TOLERANCIA / 2 })).veredito,
    ).toBe("ok");
  });
});
