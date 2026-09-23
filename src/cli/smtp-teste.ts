/**
 * Confere a senha de app do Gmail e, se você pedir, manda um e-mail de teste.
 *
 *   npm run smtp-teste
 *   npm run smtp-teste -- eu@exemplo.com
 */
import { testarConexao, enviarEmail, temEnvioDeEmail } from '../rh/email.js';

if (!temEnvioDeEmail()) {
  console.error('Faltam SMTP_USER e SMTP_PASSWORD no .env.');
  process.exit(1);
}

await testarConexao();
console.log('✓ o servidor aceitou usuário e senha');

const destino = process.argv[2];
if (destino) {
  await enviarEmail({
    para: destino,
    assunto: 'Teste de envio — assistente L&F',
    corpo: 'Se você está lendo isto, o envio de holerite por e-mail está funcionando.',
    anexo: { nome: 'teste.txt', conteudo: Buffer.from('teste') },
  });
  console.log(`✓ e-mail de teste enviado para ${destino}`);
}
