import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A garantia é de silêncio: número que não está no OWNER_PHONE não recebe
 * resposta nenhuma no privado — nem resposta do agente, nem recado de recusa,
 * nem "não posso te atender". Qualquer uma dessas confirmaria que o número é
 * de um robô e abriria conversa onde não deve haver nenhuma.
 */
async function comDonos(lista: string) {
  vi.resetModules();
  process.env.NODE_ENV = "test";
  process.env.OWNER_PHONE = lista;
  return import("../src/config.js");
}

describe("allowlist do privado", () => {
  beforeEach(() => vi.resetModules());

  it("o dono é reconhecido", async () => {
    const { ehDono } = await comDonos("5511997937982");
    expect(ehDono("5511997937982@s.whatsapp.net")).toBe(true);
  });

  it("qualquer outro número fica de fora", async () => {
    const { ehDono } = await comDonos("5511997937982");
    expect(ehDono("5511333333333@s.whatsapp.net")).toBe(false);
    expect(ehDono("5521999998888@s.whatsapp.net")).toBe(false);
    expect(ehDono("554899999999@s.whatsapp.net")).toBe(false);
  });

  it("grupo nunca é dono — conversa de grupo não vira conversa com o agente", async () => {
    const { ehDono } = await comDonos("5511997937982");
    expect(ehDono("120363420444124026@g.us")).toBe(false);
    expect(ehDono("120363431550281741@g.us")).toBe(false);
  });

  it("o dono respondendo do notebook continua sendo o dono", async () => {
    // O Baileys devolve `numero:aparelho@s.whatsapp.net` em aparelho secundário.
    const { ehDono } = await comDonos("5511997937982");
    expect(ehDono("5511997937982:12@s.whatsapp.net")).toBe(true);
  });

  it("o nono dígito não tranca nem destranca ninguém", async () => {
    const { ehDono } = await comDonos("5511997937982");
    expect(ehDono("551197937982@s.whatsapp.net")).toBe(true);
    // Mesmo DDD, número diferente: continua fora.
    expect(ehDono("5511997937983@s.whatsapp.net")).toBe(false);
  });

  it("tirar um número da lista cala o assistente para ele", async () => {
    const { ehDono } = await comDonos("5511997937982");
    expect(ehDono("5511999995214@s.whatsapp.net")).toBe(false);
  });
});
