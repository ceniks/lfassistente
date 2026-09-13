# lf-assistant

Assistente da L&F no WhatsApp. Manda o resumo da operação às 8h, responde quando
perguntado e gera o detalhado em PDF sob demanda.

## O que já está pronto

| Arquivo | O que faz |
|---|---|
| `src/data/classify.ts` | Regras de troca, influencer e normalização de texto |
| `src/data/shopify.ts` | Pedidos pagos do dia, agregação e tráfego (ShopifyQL) |
| `src/data/meta.ts` | Gasto, ROAS, custo de leilão e mensagens por template |
| `src/data/metas.ts` | Metas diárias lidas do Google Sheets |
| `src/digest/format.ts` | Montagem da mensagem |
| `src/digest/build.ts` | Junta as fontes, calcula a média de 7 dias |
| `src/whatsapp/evolution.ts` | Envio de texto e documento |
| `src/whatsapp/webhook.ts` | Recebimento, com allowlist do número do dono |
| `src/agent/` | Agent SDK, MCPs e as instruções do assistente |
| `mcp/loja-server.ts` | Servidor MCP que expõe vendas, tráfego, mídia e comparativo ao agente |

Falta ligar: Google Ads (esperando developer token), produção e atendimento via
MCP próprio, worker de PDF, e o balanço financeiro (fase final).

### Por que as regras vivem no código, não no prompt

O servidor MCP devolve agregados, nunca payload cru — um dia de pedidos tem
dezenas de milhares de tokens e a resposta a "quanto vendi hoje?" cabe em dez
linhas. E as definições de faturamento e exclusão são determinísticas ali: se
morassem só na instrução do modelo, uma resposta mais criativa num dia ruim
mudaria o número.

## Ver a cara da mensagem sem credencial nenhuma

```bash
npm install
npm run preview
```

Monta o resumo com os números reais de 12/09/2026 e imprime no terminal.

## Rodar de verdade

```bash
cp .env.example .env    # preencha
npm run dev             # webhook + cron
npm run digest          # monta o resumo de ontem e imprime
npm run digest 2026-09-12 --enviar   # manda um dia específico no WhatsApp
```

## As definições de métrica

Estão em três lugares e precisam continuar iguais nos três: `classify.ts`,
`src/agent/prompt.ts` e a spec no projeto do Claude.

- **Faturamento** = pedidos com pagamento confirmado naquele dia, não pedidos
  criados no dia. Com Pix e boleto, um pedido de terça pode ser pago na quinta —
  e conta na quinta.
- **Fora da conta**: trocas (cupom `TROCA…` ou app Troquecommerce) e influencers
  (tag `Influencer`, pedidos de seeding que saem a R$ 0).
- **Dentro da conta**: draft orders de venda assistida. São venda real.
- **Desconto** em três linhas: promoção automática, cupom e seeding.
- **Conversão** = sessões que concluíram checkout ÷ sessões. Já exclui troca e
  influencer por natureza.
- **Meta**: valor pago = gasto da API × 1,138304 (imposto de 13,8304%). O ROAS
  usa o valor pago; CPM, CPC e CPA usam o gasto líquido. No Google não há
  gross-up.

### Duas armadilhas que já custaram tempo

**A busca do Shopify não faz o que parece.** `tag:influ*` devolve zero — não há
wildcard em tag. `source_name:14177927169` também devolve zero, mesmo sendo esse
o `sourceName` real dos pedidos do TroqueCommerce. Por isso a classificação é
feita lendo os pedidos do dia, nunca por query. (`source_name:shopify_draft_order`
funciona, é a exceção.)

**A média de 7 dias precisa sair do mesmo cálculo do dia.** Comparar o ticket de
hoje, calculado com as exclusões, contra uma média tirada do painel do Shopify,
que conta tudo, produz variação inventada. É por isso que `media7d()` refaz o
cálculo dia a dia em vez de puxar o agregado pronto.

## Deploy no Railway

Quatro serviços: `evolution-api`, este aqui, Postgres e (depois) o worker de PDF.

1. Postgres pelo painel do Railway.
2. Evolution API pelo template da comunidade, apontando `DATABASE_CONNECTION_URI`
   para o Postgres. **Ligue `DATABASE_SAVE_DATA_INSTANCE=true`** — sem isso a
   sessão do WhatsApp fica em disco efêmero e você lê o QR de novo a cada deploy.
   E deixe `sleepApplication: false`: container dormindo derruba a conexão.
3. Este serviço a partir do repositório. As variáveis estão em `.env.example`.
4. Aponte o webhook da instância da Evolution para
   `https://<este-serviço>.up.railway.app/wa/webhook`, eventos `MESSAGES_UPSERT`
   e `CONNECTION_UPDATE`.

O cron do resumo é `node-cron` dentro deste processo, não o cron do Railway — o
do Railway roda em UTC e pula execuções silenciosamente se a anterior ainda
estiver rodando.

## Segurança

O webhook é público por necessidade. Três camadas, em ordem de custo: allowlist
do JID do dono, verificação da `apikey`, TLS do Railway. A allowlist é a que
importa — mensagem de outro número não acorda o agente.

Fase 1 é leitura pura: `allowedTools` não inclui nenhuma ferramenta de escrita.
