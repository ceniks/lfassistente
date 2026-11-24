import { beforeEach, describe, expect, it } from "vitest";
import {
  registrarFalha,
  falhasDaMontagem,
  zerarFalhas,
} from "../src/relatorio/falhas.js";
import { blocoDeFalhas } from "../src/digest/format.js";

describe("registro do que não pôde ser conferido", () => {
  beforeEach(() => zerarFalhas());

  it("guarda bloco e motivo", () => {
    registrarFalha(
      "produção (na_oficina)",
      new Error("o formato da listagem mudou"),
    );
    expect(falhasDaMontagem()).toMatchObject([
      { bloco: "produção (na_oficina)", motivo: "o formato da listagem mudou" },
    ]);
  });

  it("o mesmo bloco falhando duas vezes é uma falha só", () => {
    registrarFalha("produção", new Error("x"));
    registrarFalha("produção", new Error("y"));
    expect(falhasDaMontagem()).toHaveLength(1);
  });

  it("cada montagem começa limpa", () => {
    registrarFalha("produção", new Error("x"));
    zerarFalhas();
    expect(falhasDaMontagem()).toHaveLength(0);
  });
});

describe("aviso no resumo do WhatsApp", () => {
  it("dia sem falha não ganha aviso", () => {
    expect(blocoDeFalhas(undefined)).toBeNull();
    expect(blocoDeFalhas([])).toBeNull();
  });

  it("nomeia o bloco e diz que zero não é notícia", () => {
    const t = blocoDeFalhas([
      { bloco: "produção (na_oficina)", motivo: "o formato mudou" },
    ])!;
    expect(t).toContain("NÃO FOI POSSÍVEL CONFERIR");
    expect(t).toContain("produção (na_oficina)");
    expect(t).toContain("falta de leitura");
  });

  it("lista todos os blocos que falharam", () => {
    const t = blocoDeFalhas([
      { bloco: "produção", motivo: "x" },
      { bloco: "patrimônio", motivo: "y" },
    ])!;
    expect(t).toContain("• produção");
    expect(t).toContain("• patrimônio");
  });
});
