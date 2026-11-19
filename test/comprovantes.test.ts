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

// Os dois anexos do #146097, que juntos somam os R$ 339,62 do pedido e que o
// leitor descartava — um por não ter hora, outro por não ter ano.
const reciboPagarme = `Comprovante de Pagamento Olá, informamos que a seguinte cobrança foi
processada com sucesso. Dados do Estabelecimento Nome: L&F boutique (Abril 26)
Dados da pagamento Código da cobrança pl_Dlp8MJkRxbQn3jezuJCLqVWzOEvwG7Yg
Data da cobrança 14/11/2026 Valor da cobrança R$ 289,90`;

const printDoApp = `L & F FASHION LTDA R$ 49,72 ✓ Concluído • segunda-feira, 16 de nov. 15:20
Informações do destinatário Para L & F FASHION LTDA Chave Pix 36.682.719/0001-05
Instituição financeira PAGSEGURO INTERNET IP S.A. Informações do remetente
De CLEUDMAR BATISTA FERREIRA`;

describe("formatos que o leitor descartava", () => {
  it("recibo sem hora é lido — a hora não é o que prova o pagamento", () => {
    const c = lerComprovante("ch_dRyjzYpHL5hNOrbM_authorization_1.pdf", reciboPagarme)!;
    expect(c.valor).toBe(289.9);
    expect(c.dia).toBe("2026-11-14");
    expect(c.quando).toBe("2026-11-14 00:00:00");
  });

  it("o código da cobrança identifica o adquirente sem nomeá-lo", () => {
    const c = lerComprovante("ch_dRyjzYpHL5hNOrbM_authorization_1.pdf", reciboPagarme)!;
    expect(c.codigo).toBe("pl_Dlp8MJkRxbQn3jezuJCLqVWzOEvwG7Yg");
    expect(c.trilho).toBe("pagarme");
  });

  it("print sem ano usa o ano do dia conferido", () => {
    const c = lerComprovante("x.jpg", printDoApp, "2026-11-16")!;
    expect(c.valor).toBe(49.72);
    expect(c.quando).toBe("2026-11-16 15:20:00");
    expect(c.trilho).toBe("pagbank");
  });

  it("dezembro lido em janeiro cai no ano anterior, não no seguinte", () => {
    const c = lerComprovante("x.jpg", "R$ 10,00 28 de dez. 10:00", "2027-01-03")!;
    expect(c.dia).toBe("2026-12-28");
  });

  it("sem ano e sem referência, não inventa data", () => {
    expect(lerComprovante("x.jpg", "R$ 10,00 28 de dez. 10:00")).toBeNull();
  });

  it("as duas partes somam o valor do pedido", () => {
    const a = lerComprovante("ch_x.pdf", reciboPagarme)!;
    const b = lerComprovante("x.jpg", printDoApp, "2026-11-16")!;
    expect(a.valor + b.valor).toBeCloseTo(339.62, 2);
  });
});
