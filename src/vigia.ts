import { contasComProblema, type SaudeConta } from './data/meta.js';
import { enviarTextoAosDonos } from './whatsapp/evolution.js';
import { dinheiro } from './digest/format.js';

/**
 * Vigia de coisas que não podem esperar até as 8h da manhã.
 *
 * O resumo diário é para entender o negócio. Isto aqui é para evitar prejuízo:
 * uma conta de anúncios suspensa por fatura não paga derruba a mídia inteira, e
 * hoje isso só seria percebido quando as vendas caíssem no dia seguinte.
 *
 * A regra que evita virar spam: avisa quando o estado MUDA, não a cada
 * checagem. Uma conta que está há três dias em período de tolerância e você já
 * sabe disso não precisa te lembrar de hora em hora.
 */

type Gravidade = SaudeConta['gravidade'];

/** Último estado visto por conta, para só avisar sobre mudança. */
const ultimoEstado = new Map<string, string>();

/** Quando avisamos pela última vez, para repetir o crítico uma vez por dia. */
const ultimoAviso = new Map<string, number>();

const UM_DIA = 24 * 60 * 60 * 1000;

export async function verificarContas(): Promise<void> {
  let problemas: SaudeConta[];

  try {
    problemas = await contasComProblema();
  } catch (e) {
    console.error('[vigia] não consegui checar as contas:', e);
    return;
  }

  const vistas = new Set<string>();

  for (const conta of problemas) {
    vistas.add(conta.id);

    const anterior = ultimoEstado.get(conta.id);
    const mudou = anterior !== conta.estado;
    const avisadoHa = Date.now() - (ultimoAviso.get(conta.id) ?? 0);

    // Crítico se repete uma vez por dia; atenção só quando muda.
    const deveAvisar = mudou || (conta.gravidade === 'critico' && avisadoHa > UM_DIA);

    ultimoEstado.set(conta.id, conta.estado);
    if (!deveAvisar) continue;

    await avisar(conta);
    ultimoAviso.set(conta.id, Date.now());
  }

  // Voltou ao normal: quem estava na lista e saiu dela.
  for (const [id, estado] of ultimoEstado) {
    if (vistas.has(id)) continue;
    ultimoEstado.delete(id);
    ultimoAviso.delete(id);
    await enviarTextoAosDonos(
      `✅ Conta de anúncios normalizada\n\nEstava em "${estado}" e voltou a ficar ativa.`,
    ).catch(() => undefined);
  }
}

const ICONE: Record<Gravidade, string> = {
  ok: '✅',
  atencao: '⚠️',
  critico: '🚨',
  desconhecido: '❓',
};

async function avisar(conta: SaudeConta): Promise<void> {
  const linhas = [
    `${ICONE[conta.gravidade]} Conta de anúncios: ${conta.nome}`,
    '',
    `Estado: ${conta.estado}`,
  ];

  if (conta.valorEmAberto && conta.valorEmAberto > 0) {
    linhas.push(`Em aberto: ${dinheiro(conta.valorEmAberto)}`);
  }

  linhas.push(
    '',
    conta.gravidade === 'critico'
      ? 'A veiculação provavelmente já parou. Resolva o pagamento no Gerenciador de Anúncios.'
      : 'Ainda está veiculando, mas se a fatura não for liquidada a conta é suspensa.',
  );

  await enviarTextoAosDonos(linhas.join('\n')).catch((e) =>
    console.error('[vigia] não consegui avisar:', e),
  );
}
