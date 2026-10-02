import { describe, expect, it } from "vitest";
import { cobrancasDoMesmoValor } from "../src/data/conferencia-manual.js";
import type { PedidoPagarme } from "../src/data/pagarme.js";

const cobranca = (id: string, valor: number): PedidoPagarme =>
  ({ id, codigo: `pl_${id}`, valor, status: "paid", pago: true, email: "x@y.z", nome: "X", criadoEm: "", metodo: "credit_card", chargeId: `ch_${id}` }) as PedidoPagarme;

describe("casamento pelo valor quando o pagador não é a cliente", () => {
  it("uma cobrança livre do valor exato fecha o pedido", () => {
    const r = cobrancasDoMesmoValor(2084.2, [cobranca("a", 2084.2), cobranca("b", 999)], new Set());
    expect(r.map((c) => c.id)).toEqual(["a"]);
  });

  it("um centavo de diferença ainda casa", () => {
    expect(cobrancasDoMesmoValor(1538.43, [cobranca("a", 1538.42)], new Set())).toHaveLength(1);
  });

  it("cobrança já reivindicada por outro pedido não conta", () => {
    expect(cobrancasDoMesmoValor(2084.2, [cobranca("a", 2084.2)], new Set(["a"]))).toHaveLength(0);
  });

  it("duas do mesmo valor viram dúvida, não sorteio", () => {
    const r = cobrancasDoMesmoValor(500, [cobranca("a", 500), cobranca("b", 500)], new Set());
    expect(r).toHaveLength(2);
  });
});
