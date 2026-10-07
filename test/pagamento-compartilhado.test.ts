import { describe, expect, it } from "vitest";
import { grupoQueSoma } from "../src/data/conferencia-manual.js";
import { lerComprovante } from "../src/data/comprovantes.js";
import { chaveDoComprovante } from "../src/data/conferencia-comprovantes.js";

// Print do app do Itaú anexado nos pedidos #141585 e #141586, como o modelo
// transcreve: data por extenso e valor igual à soma dos dois pedidos.
const pixItau = `itaú
01 out. 2026, 17:59:59, via SISPAG no app Itaú
tipo de transferência PIX TRANSFERENCIA
valor da transferência R$ 1.361,54
de NATALIA GREGORIO SOCIEDADE IND...
para L&F FASHION PAGSEGURO INTERNET IP S.A.
ID da transação E60701190202610012059DY56848MSQA`;

describe("um pagamento, vários pedidos", () => {
  it("acha o par que soma a cobrança", () => {
    const r = grupoQueSoma(
      [
        { pedido: "#141536", valor: 712.22 },
        { pedido: "#141537", valor: 679.7 },
      ],
      1391.92,
    );
    expect(r).toEqual(["#141536", "#141537"]);
  });

  it("ignora o pedido que não faz parte do pagamento", () => {
    const r = grupoQueSoma(
      [
        { pedido: "#1", valor: 712.22 },
        { pedido: "#2", valor: 679.7 },
        { pedido: "#3", valor: 100 },
      ],
      1391.92,
    );
    expect(r).toEqual(["#1", "#2"]);
  });

  it("dois conjuntos com a mesma soma é empate, não escolha", () => {
    const r = grupoQueSoma(
      [
        { pedido: "#1", valor: 100 },
        { pedido: "#2", valor: 200 },
        { pedido: "#3", valor: 100 },
        { pedido: "#4", valor: 200 },
      ],
      300,
    );
    expect(r).toBeNull();
  });

  it("nenhuma soma bate: nada é inventado", () => {
    expect(grupoQueSoma([{ pedido: "#1", valor: 10 }, { pedido: "#2", valor: 20 }], 99)).toBeNull();
  });

  it("um pedido sozinho não é pagamento compartilhado", () => {
    expect(grupoQueSoma([{ pedido: "#1", valor: 99 }], 99)).toBeNull();
  });
});

describe("comprovante do Itaú, data por extenso", () => {
  it("lê valor, data e destino do print", () => {
    const c = lerComprovante("print.jpg", pixItau)!;
    expect(c.valor).toBe(1361.54);
    expect(c.quando).toBe("2026-10-01 17:59:59");
    expect(c.trilho).toBe("pagbank");
  });

  it("o mesmo comprovante em dois pedidos tem a mesma chave", () => {
    const a = lerComprovante("print.jpg", pixItau)!;
    const b = lerComprovante("print.jpg", pixItau)!;
    expect(chaveDoComprovante(a)).toBe(chaveDoComprovante(b));
  });

  it("801,74 + 559,80 é o valor do comprovante", () => {
    expect(801.74 + 559.8).toBeCloseTo(lerComprovante("print.jpg", pixItau)!.valor, 2);
  });
});

describe("um pedido, várias cobranças", () => {
  // O caminho inverso: a atendente manda um link, a cliente paga parte, e o
  // resto vai num segundo link. A soma não pode ultrapassar o valor do pedido,
  // senão a cobrança de outro pedido da mesma cliente seria engolida.
  const somarAteCaber = (valores: number[], valor: number) => {
    const somadas: number[] = [];
    let soma = 0;
    for (const v of [...valores].sort((a, b) => b - a)) {
      if (soma + v <= valor + 0.01) {
        somadas.push(v);
        soma += v;
      }
    }
    return { somadas, soma };
  };

  it("duas cobranças cobrem a mercadoria do #142107", () => {
    const { somadas, soma } = somarAteCaber([1800, 270.43], 2146.4);
    expect(somadas).toEqual([1800, 270.43]);
    expect(soma).toBeCloseTo(2070.43, 2);
    // Sobra o frete do pedido, ao centavo.
    expect(2146.4 - soma).toBeCloseTo(75.97, 2);
  });

  it("não engole cobrança que estouraria o valor do pedido", () => {
    const { somadas } = somarAteCaber([1800, 500], 2146.4);
    expect(somadas).toEqual([1800]);
  });
});
