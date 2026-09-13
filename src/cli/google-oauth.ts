/**
 * Obtém o refresh token do Google Ads. Roda uma vez, na sua máquina.
 *
 *   npm run google-oauth
 *
 * Por que existe: o refresh token é a única credencial do Google que não se
 * consegue copiar de um painel. Ele nasce de um consentimento seu no navegador,
 * e só aparece uma vez — na primeira autorização. Depois disso o servidor o usa
 * para renovar o acesso sozinho, para sempre, sem navegador.
 *
 * O script sobe um servidor local só para receber a resposta do Google, troca o
 * código pelo refresh token e imprime. Nada sai da sua máquina além do fluxo
 * normal do OAuth.
 */
import { createServer } from 'node:http';
import { config } from '../config.js';

const PORTA = 8787;
const REDIRECT = `http://localhost:${PORTA}/callback`;
const ESCOPO = 'https://www.googleapis.com/auth/adwords';

const c = config();
const clientId = c.GOOGLE_ADS_CLIENT_ID;
const clientSecret = c.GOOGLE_ADS_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(
    'Faltam GOOGLE_ADS_CLIENT_ID e GOOGLE_ADS_CLIENT_SECRET no .env.\n\n' +
      'Pegue os dois no Google Cloud Console, em APIs e Serviços → Credenciais,\n' +
      'criando um "ID do cliente OAuth" do tipo "App para computador".',
  );
  process.exit(1);
}

const autorizacao = new URL('https://accounts.google.com/o/oauth2/v2/auth');
autorizacao.searchParams.set('client_id', clientId);
autorizacao.searchParams.set('redirect_uri', REDIRECT);
autorizacao.searchParams.set('response_type', 'code');
autorizacao.searchParams.set('scope', ESCOPO);
// Sem estes dois, o Google devolve só um access token de uma hora e nenhum
// refresh token — e o servidor ficaria pedindo login toda hora.
autorizacao.searchParams.set('access_type', 'offline');
autorizacao.searchParams.set('prompt', 'consent');

console.log('\nAbra este endereço no navegador e autorize:\n');
console.log(autorizacao.toString());
console.log('\nAguardando a autorização…\n');

const servidor = createServer(async (req, res) => {
  if (!req.url?.startsWith('/callback')) {
    res.writeHead(404).end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORTA}`);
  const erro = url.searchParams.get('error');
  const codigo = url.searchParams.get('code');

  if (erro || !codigo) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<p>Autorização não concluída: ${erro ?? 'sem código'}. Pode fechar esta aba.</p>`);
    console.error(`\nFalhou: ${erro ?? 'o Google não devolveu o código'}`);
    servidor.close();
    process.exit(1);
  }

  try {
    const troca = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: codigo,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: REDIRECT,
        grant_type: 'authorization_code',
      }),
    });

    const dados = (await troca.json()) as { refresh_token?: string; error_description?: string };

    if (!dados.refresh_token) {
      throw new Error(
        dados.error_description ??
          'o Google não devolveu refresh_token — verifique se o app está em modo de teste ' +
            'com sua conta na lista de usuários, ou revogue o acesso e tente de novo',
      );
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<p>Pronto. Pode fechar esta aba e voltar ao terminal.</p>');

    console.log('Cole esta linha no seu .env:\n');
    console.log(`GOOGLE_ADS_REFRESH_TOKEN=${dados.refresh_token}\n`);
    console.log('Guarde com o mesmo cuidado de uma senha: ele não expira.\n');
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<p>Deu erro na troca do código. Veja o terminal.</p>');
    console.error(`\nFalhou: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    servidor.close();
    setTimeout(() => process.exit(0), 500);
  }
});

servidor.listen(PORTA);
