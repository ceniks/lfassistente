/**
 * O que não deu para conferir hoje.
 *
 * Todo bloco do boletim é opcional por desenho: fonte que falha não derruba o
 * relatório inteiro. O preço disso é que a falha vira ausência, e ausência é
 * indistinguível de zero — foi assim que "Em produção: 0 peças" saiu no
 * check-in com 9.092 peças na oficina, porque o Corte Pro mudou o formato da
 * listagem e ninguém ficou sabendo.
 *
 * Zero é uma afirmação sobre o negócio. "Não consegui contar" é uma
 * afirmação sobre o sistema. As duas precisam parecer diferentes, e é isso
 * que este registro existe para garantir.
 */
export interface Falha {
  /** O bloco afetado, no nome que o relatório usa. */
  bloco: string;
  motivo: string;
  em: string;
}

let falhas: Falha[] = [];

export function registrarFalha(bloco: string, erro: unknown): void {
  const motivo = erro instanceof Error ? erro.message : String(erro);
  // Um bloco que falha duas vezes na mesma montagem é uma falha só.
  if (falhas.some((f) => f.bloco === bloco)) return;
  falhas.push({
    bloco,
    motivo: motivo.slice(0, 200),
    em: new Date().toISOString(),
  });
}

export function falhasDaMontagem(): Falha[] {
  return [...falhas];
}

/** Chamado no início de cada montagem: o registro é do boletim de hoje. */
export function zerarFalhas(): void {
  falhas = [];
}
