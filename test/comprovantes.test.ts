import { describe, expect, it } from "vitest";
import { lerComprovante } from "../src/data/comprovantes.js";

// Texto como o pdfjs entrega os dois comprovantes reais do pedido #140825 e o
// recibo de link de pagamento do #140812.
const pixMercadoPago = `Comprovante BB R$ 425,74 22/09/2026 às 13:49:27 Pix - QR Code
Recebedor L&f Fashion CNPJ 36.682.719/0001-05 Instituição 10573521 MERCADO PAGO IP LTDA.
Pagador Edna Aparecida A Silveira CPF ***.024.766-**`;

const pixNaConta = `Comprovante BB R$ 339,55 26/09/2026 às 12:20:22 Pix Enviado
Recebedor L&f Fashion CNPJ 36.682.719/0001-05 Agência 0001 Conta 359518479
Instituição 08561701 PAGSEGURO INTERNET IP S.A.`;

const linkDePagamento = `Sua compra foi aprovada Valor do pagamento R$ 1.289,09
Vendido por: L F FASHION Forma de pagamento: 8x - Mastercard
Código da transação: 2BF7C05D-8E93-4ED7-8931-90753F9B7A74
Data do pagamento: 25/09/2026 às 22:07:11
Detalhes da compra 1 item Link de Pagamento R$ 1.289,09 Total R$ 1.289,09`;

describe("leitura de comprovante", () => {
  it("separa os dois Pix do mesmo pedido pelo destino", () => {
    const a = lerComprovante("a.pdf", pixMercadoPago)!;
    expect(a.valor).toBe(425.74);
    expect(a.dia).toBe("2026-09-22");
    expect(a.quando).toBe("2026-09-22 13:49:27");
    expect(a.trilho).toBe("mercadopago");
    expect(a.instituicao).toBe("Mercado Pago");

    const b = lerComprovante("b.pdf", pixNaConta)!;
    expect(b.valor).toBe(339.55);
    expect(b.dia).toBe("2026-09-26");
    expect(b.trilho).toBe("pagbank");

    expect(a.valor + b.valor).toBeCloseTo(765.29, 2);
  });

  it("lê o recibo de link e guarda o código da transação", () => {
    const c = lerComprovante("c.pdf", linkDePagamento)!;
    expect(c.valor).toBe(1289.09);
    expect(c.dia).toBe("2026-09-25");
    expect(c.codigo).toBe("2BF7C05D-8E93-4ED7-8931-90753F9B7A74");
    // O recibo não nomeia adquirente nenhum: quem identifica é o código.
    expect(c.trilho).toBe("link");
  });

  it("o valor repetido no total não vira soma", () => {
    expect(lerComprovante("c.pdf", linkDePagamento)!.valor).toBe(1289.09);
  });

  it("documento sem valor ou sem data não vira comprovante", () => {
    expect(lerComprovante("x.pdf", "Comprovante BB R$ 10,00")).toBeNull();
    expect(lerComprovante("x.pdf", "22/09/2026 às 13:49:27")).toBeNull();
  });
});
