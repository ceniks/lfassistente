import { describe, expect, it } from "vitest";
import { conferirContrapartida } from "../src/data/contrapartida.js";
import type { ConferenciaPix } from "../src/data/conferencia-pix.js";
import type { ConferenciaManual } from "../src/data/conferencia-manual.js";
import type { ResumoVendas } from "../src/data/shopify.js";

const vendas = { receitaTotal: 1000 } as ResumoVendas;
const manual = { vendas: [], semRastro: 0 } as unknown as ConferenciaManual;

const pix = (over: Partial<ConferenciaPix> = {}): ConferenciaPix =>
  ({
    dia: "2026-09-27",
    semExtrato: false,
    sincronizou: true,
    atualizadoAte: null,
    conexoes: [{ banco: "PagBank", status: "UPDATED", execucao: "SUCCESS", coletadoEm: "2026-09-28T09:00:00.000Z", reconectar: null }],
    coletadoAte: "2026-09-28T09:00:00.000Z",
    cobreODia: true,
    entradas: { quantidade: 0, valor: 0 },
    casados: [],
    semContrapartida: [],
    valorCasado: 0,
    valorSemContrapartida: 0,
    ...over,
  }) as ConferenciaPix;

const conferir = (m: ConferenciaManual | null, p: ConferenciaPix | null) =>
  conferirContrapartida(vendas, null, null, m, p);

describe("motivo do extrato incompleto", () => {
  it("dia sem Pix nenhum, com o extrato em dia, não é aviso", () => {
    const c = conferir(manual, pix({ semExtrato: true }));
    expect(c.extratoIncompleto).toBe(false);
    expect(c.motivoDoExtrato).toBeNull();
  });

  it("coleta anterior ao fim do dia vira aviso com a hora da coleta", () => {
    const c = conferir(
      manual,
      pix({ cobreODia: false, coletadoAte: "2026-09-27T09:45:00.000Z" }),
    );
    expect(c.extratoIncompleto).toBe(true);
    expect(c.motivoDoExtrato).toContain("27/09 06:45");
  });

  it("conexão fora de UPDATED aponta o banco e a reconexão", () => {
    const c = conferir(
      manual,
      pix({
        conexoes: [
          { banco: "Santander Empresas", status: "LOGIN_ERROR", execucao: "INVALID_CREDENTIALS", coletadoEm: null, reconectar: "https://x" },
        ],
      }),
    );
    expect(c.motivoDoExtrato).toContain("Santander Empresas");
    expect(c.motivoDoExtrato).toContain("reconectar");
  });

  it("sem bloco do Pix, a culpa não é do banco", () => {
    expect(conferir(manual, null).motivoDoExtrato).toContain("leitura do extrato falhou");
    expect(conferir(null, null).motivoDoExtrato).toContain("Pagar.me");
  });
});
