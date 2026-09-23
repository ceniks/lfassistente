/**
 * Envio dos holerites por e-mail.
 *
 * SMTP do Gmail da empresa com senha de app: a funcionária vê o remetente que
 * já conhece, e não é preciso publicar domínio em serviço nenhum. A senha de
 * app fica na env, nunca no código.
 */
import nodemailer, { type Transporter } from "nodemailer";
import { config, exigir } from "../config.js";

let transporte: Transporter | null = null;

export function temEnvioDeEmail(): boolean {
  const c = config();
  return Boolean(c.SMTP_USER && c.SMTP_PASSWORD);
}

function conectar(): Transporter {
  if (transporte) return transporte;
  const c = config();
  transporte = nodemailer.createTransport({
    host: c.SMTP_HOST,
    port: c.SMTP_PORT,
    secure: c.SMTP_PORT === 465,
    auth: { user: exigir("SMTP_USER"), pass: exigir("SMTP_PASSWORD") },
  });
  return transporte;
}

export interface Envio {
  para: string;
  assunto: string;
  corpo: string;
  anexo: { nome: string; conteudo: Buffer };
}

export async function enviarEmail(e: Envio): Promise<void> {
  const c = config();
  await conectar().sendMail({
    from: c.SMTP_FROM || c.SMTP_USER,
    to: e.para,
    subject: e.assunto,
    text: e.corpo,
    attachments: [{ filename: e.anexo.nome, content: e.anexo.conteudo }],
  });
}

/** Confere usuário e senha sem mandar mensagem nenhuma. */
export async function testarConexao(): Promise<void> {
  await conectar().verify();
}
