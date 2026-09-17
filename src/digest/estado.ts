/**
 * O que aconteceu na última tentativa de montar o resumo.
 *
 * Existe por causa de uma manhã sem boletim e sem erro: nada no WhatsApp, e do
 * lado de fora nenhuma forma de saber se o cron não disparou, se a montagem
 * travou ou se o envio falhou. Fica em memória de propósito — é diagnóstico do
 * processo que está no ar, não histórico.
 */
export interface TentativaDeResumo {
  dia: string;
  comecouEm: string;
  terminouEm?: string;
  situacao: 'rodando' | 'enviado' | 'falhou';
  erro?: string;
  duracaoEmSegundos?: number;
  /** O boletim em PDF sai depois do resumo e falha por conta própria. */
  pdf?: { situacao: 'enviado' | 'falhou'; erro?: string; tamanhoEmKb?: number };
}

let ultima: TentativaDeResumo | null = null;

export function resumoComecou(dia: string): void {
  ultima = { dia, comecouEm: new Date().toISOString(), situacao: 'rodando' };
}

export function resumoTerminou(situacao: 'enviado' | 'falhou', erro?: string): void {
  if (!ultima) return;
  const fim = new Date();
  ultima = {
    ...ultima,
    situacao,
    erro,
    terminouEm: fim.toISOString(),
    duracaoEmSegundos: Math.round((fim.getTime() - new Date(ultima.comecouEm).getTime()) / 1000),
  };
}

export function boletimTerminou(
  situacao: 'enviado' | 'falhou',
  extra: { erro?: string; tamanhoEmKb?: number } = {},
): void {
  if (!ultima) return;
  ultima = { ...ultima, pdf: { situacao, ...extra } };
}

export function ultimaTentativa(): TentativaDeResumo | null {
  return ultima;
}
