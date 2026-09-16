import { saudeDasContas, type SaudeConta } from './data/meta.js';
import { enviarTextoAosDonos } from './whatsapp/evolution.js';
import { dinheiro } from './digest/format.js';

/**
 * Vigia de coisas que não podem esperar até as 8h da manhã.
 *
 * O resumo diário é para entender o negócio. Isto aqui é para evitar prejuízo:
 * uma conta de anúncios suspensa por fatura não paga derruba a mídia inteira, e
 * hoje isso só seria percebido quando as vendas caíssem no dia seguinte.
 *
 * A regra que evita virar spam está logo abaixo, e ela é diferente por tipo de
 * problema: cobrança pendente é prazo, conta desativada é prejuízo correndo.
 */

type Gravidade = SaudeConta['gravidade'];

/**
 * Duas regras diferentes, porque são dois problemas diferentes.
 *
 * **Cobrança pendente** é aviso de prazo: a conta ainda veicula. Não adianta
 * saber disso de hora em hora — e mandar de hora em hora é o caminho para o
 * número do bot ser bloqueado pelo WhatsApp, que é risco maior que a própria
 * fatura. Vai uma vez por dia, na primeira checagem depois das 9h.
 *
 * **Conta desativada** é prejuízo correndo: a veiculação parou. Esse avisa na
 * hora em que for detectado, e repete uma vez por dia enquanto durar.
 *
 * O estado mora em memória, então um deploy zera o histórico. É de propósito
 * que o aviso de cobrança tenha hora marcada: sem isso, cada reinício do
 * serviço mandaria a mensagem de novo — foi exatamente o que aconteceu.
 */
const HORA_DO_AVISO_DE_COBRANCA = 9;

/** Dia (São Paulo) do último aviso de cobrança pendente, por conta. */
const avisoDeCobranca = new Map<string, string>();

/** Quando avisamos da conta desativada, por conta. */
const avisoDeDesativacao = new Map<string, number>();

/** Contas que já receberam algum aviso — só essas merecem "normalizada". */
const comAvisoAberto = new Set<string>();

const UM_DIA = 24 * 60 * 60 * 1000;

function diaEmSaoPaulo(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function horaEmSaoPaulo(d: Date): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'America/Sao_Paulo',
      hour: '2-digit',
      hour12: false,
    }).format(d),
  );
}

export async function verificarContas(): Promise<void> {
  let contas: SaudeConta[];

  try {
    // Todas as contas, não só as com problema: sem ver o estado `ok`
    // explicitamente não dá para distinguir "voltou ao normal" de "a API não
    // respondeu agora" — e a segunda virava uma falsa mensagem de
    // normalização.
    contas = await saudeDasContas();
  } catch (e) {
    console.error('[vigia] não consegui checar as contas:', e);
    return;
  }

  const agora = new Date();
  const hoje = diaEmSaoPaulo(agora);
  const normalizadas = new Set<string>();

  for (const conta of contas) {
    // Falha de leitura da API não é incidente da conta. Antes isso virava
    // alerta, e voltar ao normal na hora seguinte virava outro — dois
    // disparos por uma instabilidade da Meta.
    if (conta.gravidade === 'desconhecido') {
      console.error(`[vigia] ${conta.nome}: ${conta.estado}`);
      continue;
    }

    if (conta.gravidade === 'ok') {
      normalizadas.add(conta.id);
      continue;
    }

    if (conta.gravidade === 'critico') {
      const ultimo = avisoDeDesativacao.get(conta.id) ?? 0;
      if (agora.getTime() - ultimo < UM_DIA) continue;

      await avisarDesativacao(conta);
      avisoDeDesativacao.set(conta.id, agora.getTime());
      comAvisoAberto.add(conta.id);
      continue;
    }

    // Atenção: cobrança pendente, ainda veiculando.
    if (avisoDeCobranca.get(conta.id) === hoje) continue;
    if (horaEmSaoPaulo(agora) < HORA_DO_AVISO_DE_COBRANCA) continue;

    await avisarCobranca(conta);
    avisoDeCobranca.set(conta.id, hoje);
    comAvisoAberto.add(conta.id);
  }

  // Voltou ao normal: conta que a Meta confirmou como ativa e que tinha aviso
  // aberto. Conta que não deu para ler não entra aqui.
  for (const id of [...comAvisoAberto]) {
    if (!normalizadas.has(id)) continue;
    comAvisoAberto.delete(id);
    avisoDeCobranca.delete(id);
    avisoDeDesativacao.delete(id);
    await enviarTextoAosDonos(
      '✅ Conta de anúncios normalizada\n\nSaiu da lista de problemas e voltou a ficar ativa.',
    ).catch(() => undefined);
  }
}

const ICONE: Record<Gravidade, string> = {
  ok: '✅',
  atencao: '⚠️',
  critico: '🚨',
  desconhecido: '❓',
};

async function avisarCobranca(conta: SaudeConta): Promise<void> {
  const linhas = [
    `${ICONE[conta.gravidade]} Cobrança pendente: ${conta.nome}`,
    '',
    `Estado: ${conta.estado}`,
  ];

  if (conta.valorEmAberto && conta.valorEmAberto > 0) {
    linhas.push(`Em aberto: ${dinheiro(conta.valorEmAberto)}`);
  }

  linhas.push(
    '',
    'A conta continua veiculando. Se a fatura não for liquidada, é suspensa — e aí a mídia para.',
    'Este aviso sai uma vez por dia enquanto a pendência existir.',
  );

  await enviarTextoAosDonos(linhas.join('\n')).catch((e) =>
    console.error('[vigia] não consegui avisar da cobrança:', e),
  );
}

async function avisarDesativacao(conta: SaudeConta): Promise<void> {
  const linhas = [
    `🚨 Conta desativada: ${conta.nome}`,
    '',
    `Estado: ${conta.estado}`,
  ];

  if (conta.motivoDesativacao) linhas.push(`Motivo: ${conta.motivoDesativacao}`);
  if (conta.valorEmAberto && conta.valorEmAberto > 0) {
    linhas.push(`Em aberto: ${dinheiro(conta.valorEmAberto)}`);
  }

  linhas.push(
    '',
    'A veiculação parou. Cada hora parada é dia de venda perdido — resolva no Gerenciador de Anúncios.',
  );

  await enviarTextoAosDonos(linhas.join('\n')).catch((e) =>
    console.error('[vigia] não consegui avisar da desativação:', e),
  );
}
