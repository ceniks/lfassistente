import { describe, expect, it } from "vitest";
import { explicacaoDe } from "../src/data/conciliacao.js";

describe("observação que explica reembolso sem reversa", () => {
  it('"AO REMETENTE" é devolução sem reenvio, não divergência', () => {
    // O texto real do #139004.
    expect(explicacaoDe("Estornado por:  AO REMETENTE")).toContain("sem reenvio");
  });

  it("não depende de caixa nem do espaçamento", () => {
    expect(explicacaoDe("estornado por: ao  remetente")).toBeTruthy();
    expect(explicacaoDe("AORemetente")).toBeTruthy();
  });

  it("observação livre continua sendo divergência, com o texto ao lado", () => {
    // O #137537 traz uma instrução de envio, não um motivo de estorno.
    expect(explicacaoDe("ENVIAR JUNTO COM O PEDIDO 137536")).toBeUndefined();
  });

  it("pedido sem observação não ganha explicação inventada", () => {
    expect(explicacaoDe(undefined)).toBeUndefined();
    expect(explicacaoDe("")).toBeUndefined();
  });
});
