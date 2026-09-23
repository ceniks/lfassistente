/**
 * Envio pela API do Gmail, com a conta da empresa.
 *
 * Escolhido no lugar de SMTP porque a autorização é a mesma que o projeto já
 * usa para o Google Ads: um consentimento no navegador, um refresh token na
 * env, e nada de senha de app circulando. O escopo é só `gmail.send` — este
 * código não consegue ler caixa nenhuma, só mandar.
 */
import { google } from "googleapis";
import { config, exigir } from "../config.js";

export function temGmail(): boolean {
  const c = config();
  return Boolean(c.GMAIL_REFRESH_TOKEN && c.GOOGLE_ADS_CLIENT_ID && c.GOOGLE_ADS_CLIENT_SECRET);
}

function cliente() {
  const c = config();
  const auth = new google.auth.OAuth2(
    exigir("GOOGLE_ADS_CLIENT_ID"),
    exigir("GOOGLE_ADS_CLIENT_SECRET"),
  );
  auth.setCredentials({ refresh_token: c.GMAIL_REFRESH_TOKEN });
  return google.gmail({ version: "v1", auth });
}

/** Cabeçalho com acento vira `=?UTF-8?B?…?=`, senão o Gmail entrega em mojibake. */
const cabecalho = (texto: string) =>
  /^[\x20-\x7E]*$/.test(texto)
    ? texto
    : `=?UTF-8?B?${Buffer.from(texto, "utf8").toString("base64")}?=`;

export interface MensagemGmail {
  para: string;
  assunto: string;
  corpo: string;
  anexo?: { nome: string; conteudo: Buffer; tipo?: string };
}

export async function enviarPeloGmail(m: MensagemGmail): Promise<string> {
  const fronteira = `lf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;

  const partes = [
    `To: ${m.para}`,
    `Subject: ${cabecalho(m.assunto)}`,
    "MIME-Version: 1.0",
  ];

  if (m.anexo) {
    partes.push(
      `Content-Type: multipart/mixed; boundary="${fronteira}"`,
      "",
      `--${fronteira}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(m.corpo, "utf8").toString("base64"),
      `--${fronteira}`,
      `Content-Type: ${m.anexo.tipo ?? "application/pdf"}; name="${m.anexo.nome}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${m.anexo.nome}"`,
      "",
      m.anexo.conteudo.toString("base64").replace(/(.{76})/g, "$1\n"),
      `--${fronteira}--`,
      "",
    );
  } else {
    partes.push(
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(m.corpo, "utf8").toString("base64"),
    );
  }

  const r = await cliente().users.messages.send({
    userId: "me",
    requestBody: {
      raw: Buffer.from(partes.join("\r\n"), "utf8")
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, ""),
    },
  });

  return r.data.id ?? "";
}

/**
 * Confere se a autorização ainda vale, sem mandar mensagem.
 *
 * Só renova o token: `getProfile` exigiria escopo de leitura, e este projeto
 * pede de propósito apenas o de envio.
 */
export async function autorizacaoValida(): Promise<boolean> {
  const c = config();
  const auth = new google.auth.OAuth2(
    exigir("GOOGLE_ADS_CLIENT_ID"),
    exigir("GOOGLE_ADS_CLIENT_SECRET"),
  );
  auth.setCredentials({ refresh_token: c.GMAIL_REFRESH_TOKEN });
  const t = await auth.getAccessToken();
  return Boolean(t.token);
}
