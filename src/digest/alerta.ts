/**
 * A saída de emergência do boletim.
 *
 * O aviso de falha ia pelo WhatsApp, que é justamente o que cai. Aconteceu
 * duas vezes — 09/10 e 08/11, as duas com a sessão desconectada por 401 — e
 * nas duas o sistema sabia que tinha falhado, registrou no `/diag`, e não teve
 * como contar: o canal do aviso era o canal quebrado.
 *
 * Então quando o WhatsApp não entrega, o e-mail entrega. E leva o PDF junto
 * quando ele existe: avisar que o boletim ficou pronto sem mandá-lo seria
 * contar o problema e guardar a solução.
 */
import { config } from '../config.js';
import { enviarPeloGmail, temGmail } from '../rh/gmail.js';

export function temEmailDeAlerta(): boolean {
  return Boolean(config().EMAIL_ALERTA && temGmail());
}

/**
 * Manda o aviso por e-mail. Nunca lança: é o último recurso, e um erro aqui
 * derrubaria o tratamento do erro que o trouxe até aqui.
 */
export async function avisarPorEmail(
  assunto: string,
  corpo: string,
  anexo?: { nome: string; conteudo: Buffer },
): Promise<boolean> {
  const para = config().EMAIL_ALERTA;
  if (!para || !temGmail()) return false;

  try {
    await enviarPeloGmail({
      para,
      assunto,
      corpo,
      ...(anexo ? { anexo: { ...anexo, tipo: 'application/pdf' } } : {}),
    });
    console.error(`[alerta] e-mail enviado para ${para.replace(/(.{2}).*(@.*)/, '$1***$2')}`);
    return true;
  } catch (e) {
    console.error('[alerta] e-mail também falhou:', e instanceof Error ? e.message : e);
    return false;
  }
}
