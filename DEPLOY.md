# Deploy no Railway

Três serviços: Postgres, Evolution API e este projeto. O worker de PDF entra
depois.

A ordem importa — cada passo produz uma credencial que o próximo precisa.

---

## Antes de começar

Você vai precisar destas cinco coisas. Nenhuma delas eu consigo gerar:

| O quê | Onde | Observação |
|---|---|---|
| **Chip dedicado** | Operadora | Linha nova, ativa no WhatsApp. Nunca o seu número nem o do AtendePro |
| **Chave da API Claude** | console.anthropic.com | Configure um limite de gasto junto |
| **Client ID e Secret do Shopify** | Dev Dashboard → seu app → Configurações | O app precisa estar **instalado na loja** e na mesma organização |
| **System user do Meta** | Business Manager → Usuários do sistema | Permissão `ads_read`, token sem expiração |
| **Conta no Railway** | railway.app | Plano Hobby, US$ 5/mês |

O Corte Pro e o AtendePro já estão prontos — as chaves estão no seu `.env`.

---

## 1. Suba o código para o GitHub

```bash
cd ~/Downloads/lf-assistant
git push
```

O Railway faz deploy a partir do repositório, então nada acontece antes disso.

---

## 2. Postgres

No Railway: **New Project** → **Provision PostgreSQL**.

Só isso. Ele gera a `DATABASE_URL` sozinho, e os outros serviços vão referenciá-la.

---

## 3. Evolution API

**New** → **Docker Image** → `evoapicloud/evolution-api:latest`

Variáveis:

```
AUTHENTICATION_API_KEY=<gere com: openssl rand -hex 32>
DATABASE_ENABLED=true
DATABASE_PROVIDER=postgresql
DATABASE_CONNECTION_URI=${{Postgres.DATABASE_URL}}
DATABASE_SAVE_DATA_INSTANCE=true
DATABASE_SAVE_DATA_NEW_MESSAGE=true
DATABASE_SAVE_MESSAGE_UPDATE=true
CONFIG_SESSION_PHONE_CLIENT=LF
CONFIG_SESSION_PHONE_NAME=Chrome
```

A sintaxe `${{Postgres.DATABASE_URL}}` é do Railway: ele resolve a referência
para o serviço Postgres do mesmo projeto.

> **`DATABASE_SAVE_DATA_INSTANCE=true` não é opcional.** É ele que guarda a
> sessão do WhatsApp no banco em vez do disco. Sem isso, todo deploy e toda
> manutenção da plataforma derrubam a sessão e você lê o QR de novo. É o erro
> mais comum de quem roda Evolution no Railway.

Em **Settings → Networking**, gere o domínio público. Guarde a URL.

Em **Settings**, confirme que **Serverless / App Sleeping está desligado** —
container dormindo derruba a conexão do WhatsApp.

---

## 4. Conecte o WhatsApp

Crie a instância (troque a URL, a chave e o número):

```bash
curl -X POST "https://<evolution>.up.railway.app/instance/create" \
  -H "apikey: <AUTHENTICATION_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "instanceName": "lf",
    "number": "<numero do chip, só dígitos com DDI>",
    "qrcode": true,
    "integration": "WHATSAPP-BAILEYS"
  }'
```

A resposta traz o QR em base64. Cole o conteúdo do campo `base64` na barra de
endereços do navegador para ver a imagem, e leia com o WhatsApp do chip.

Confirme que conectou:

```bash
curl "https://<evolution>.up.railway.app/instance/connectionState/lf" \
  -H "apikey: <AUTHENTICATION_API_KEY>"
```

Deve responder `"state": "open"`.

---

## 5. Este serviço

**New** → **GitHub Repo** → `ceniks/lfassistente`.

O Railway lê o `railway.json` e usa o `Dockerfile`. Variáveis:

```
EVOLUTION_URL=https://<evolution>.up.railway.app
EVOLUTION_API_KEY=<a mesma AUTHENTICATION_API_KEY>
EVOLUTION_INSTANCE=lf
OWNER_PHONE=<seu número pessoal, só dígitos com DDI>

ANTHROPIC_API_KEY=
CLAUDE_MODEL=claude-sonnet-5

SHOPIFY_SHOP=l-f-oficial.myshopify.com
SHOPIFY_CLIENT_ID=
SHOPIFY_CLIENT_SECRET=
SHOPIFY_API_VERSION=2026-07

META_SYSTEM_TOKEN=
META_AD_ACCOUNT_IDS=2384690018414844
META_TAX_FACTOR=1.138304

ATENDEPRO_MCP_URL=https://kqajenteyjuiqsfxokfm.supabase.co/functions/v1/mcp
ATENDEPRO_TOKEN=
CORTEPRO_MCP_URL=https://bpbryewriqaufylcfcax.supabase.co/functions/v1/mcp-server
CORTEPRO_TOKEN=

TZ=America/Sao_Paulo
DIGEST_CRON=0 8 * * *
NODE_ENV=production
```

> **`OWNER_PHONE` é o seu número, não o do chip.** O chip é de onde a mensagem
> sai; o `OWNER_PHONE` é para onde ela vai, e é a allowlist que decide quem pode
> conversar com o assistente. Só esse número acorda o agente.

Gere o domínio público em **Settings → Networking**.

---

## 6. Ligue o webhook

```bash
curl -X POST "https://<evolution>.up.railway.app/webhook/set/lf" \
  -H "apikey: <AUTHENTICATION_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "webhook": {
      "enabled": true,
      "url": "https://<lf-assistant>.up.railway.app/wa/webhook",
      "byEvents": false,
      "base64": false,
      "events": ["MESSAGES_UPSERT", "CONNECTION_UPDATE"]
    }
  }'
```

---

## 7. Confira

```bash
curl https://<lf-assistant>.up.railway.app/health
```

Deve responder `{"ok":true}`.

Depois mande `oi` do seu número para o chip. Se responder, o caminho inteiro
está de pé: WhatsApp → Evolution → webhook → agente → resposta.

Se não responder, os logs do serviço no Railway dizem onde parou. O webhook
loga cada mensagem que chega e cada uma que descarta por estar fora da
allowlist.

---

## Custo esperado

Faixa de US$ 14 a 22 por mês: US$ 5 do plano Hobby (que já inclui US$ 5 de
crédito de recursos) mais o consumo dos três serviços, medido a US$ 10/GB de RAM
e US$ 20/vCPU. A conta da API Claude é separada e depende de quanto você
conversa com o assistente.

## Se o resumo não chegar às 8h

O cron é `node-cron` dentro deste serviço, não o cron do Railway — que roda em
UTC e pula execuções silenciosamente. Para testar sem esperar o dia seguinte, o
comando abaixo monta e envia o resumo na hora:

```bash
npm run digest 2026-09-12 -- --enviar
```

E se algo falhar às 8h, o assistente manda uma mensagem dizendo o que quebrou.
Silêncio significaria que você acharia que o dia foi fraco quando na verdade o
robô é que não rodou.

## Página de holerites (`/rh`)

Mesmo serviço, rota própria: `https://<app>.up.railway.app/rh`. Sobe o PDF da
contabilidade, mostra um holerite por funcionário já casado com o cadastro, e
envia depois de conferir.

Variáveis necessárias no Railway:

| Variável | Para quê |
|---|---|
| `RH_SENHA` | senha da página. **Sem ela a página fica desligada** — é melhor não existir do que existir aberta na internet. |
| `GMAIL_REFRESH_TOKEN` | autorização de envio (escopo `gmail.send`), obtida no mesmo cliente OAuth do Google Ads. |

O cadastro de funcionários entra pela própria página, subindo um CSV com nome e
e-mail (a planilha do Google continua valendo se `RH_SPREADSHEET_ID` estiver
configurada). Ele é gravado em `dados/funcionarios.json`, que é descartável: se
o container reiniciar, sobe o CSV de novo.

Nenhum holerite é gravado em disco no servidor. O lote vive na memória por duas
horas e some.

O que fica gravado é o **registro de envios** (`dados/envios-holerite.json`):
mês, data, quem recebeu e se deu certo. A página mostra isso em "Envios
anteriores" e usa para marcar quem já recebeu no mês, deixando a linha
desmarcada.

**Para o registro sobreviver a deploy**, monte um volume no Railway (Service →
Settings → Volumes) em `/app/dados`. Sem volume o arquivo some a cada build, e
o histórico recomeça — os e-mails em si continuam na caixa "Enviados" da conta
do Gmail, que é a prova durável.

Assunto e texto do e-mail vêm de `HOLERITE_ASSUNTO` e `HOLERITE_CORPO`, com os
marcadores `{tratamento}`, `{primeiro}`, `{nome}` e `{mes}`. A página carrega
esses modelos em campos editáveis: dá para ajustar o texto de um mês específico
sem mexer em variável nenhuma.

## Dois sistemas no mesmo número

A Evolution entrega os eventos de uma instância para **um** webhook. Se outro
projeto configurar o webhook da instância `lf`, o assistente para de receber
mensagens — sem erro e sem aviso.

Por isso o assistente continua sendo o único assinante e repassa o que é do
outro sistema, filtrando por conversa:

| Variável | Para quê |
|---|---|
| `WEBHOOK_REPASSE_URL` | destino dos eventos (ex.: `https://financeiro.up.railway.app/wa/eventos`) |
| `WEBHOOK_REPASSE_TOKEN` | segredo que o destino exige em `Authorization: Bearer` |
| `WEBHOOK_REPASSE_JIDS` | JIDs cujos eventos são dele, separados por vírgula |

O corpo vai cru, como a Evolution mandou, com `key.participant` preservado e
incluindo `fromMe: true` — é assim que o outro lado confirma que a mensagem
dele saiu. `connection.update` é repassado sempre, porque é o que avisa que o
número caiu. Falha no destino vira log: nunca derruba o assistente.

Enviar mensagem não conflita: o outro sistema chama a API da Evolution
diretamente com a mesma chave.
