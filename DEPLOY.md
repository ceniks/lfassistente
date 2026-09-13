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
