/**
 * "Ficou para depois" que alguém de fato retoma.
 *
 * Duas coisas do assistente falham por causa de terceiros e não por culpa
 * própria: o boletim das 8h, quando uma fonte não responde, e a cobrança,
 * quando o extrato vem incompleto. Até aqui, as duas tratavam "falhou" como
 * fim de linha — ninguém voltava para tentar, e o conserto era alguém
 * perceber e pedir à mão. Aconteceu em 09/10, em 10/11 e em 16/11.
 *
 * Isto guarda o dia em disco para que o vigia de hora em hora retome. Em
 * disco, e não em memória, porque reinício de serviço é justamente um dos
 * jeitos de perder o registro.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Adiado {
  dia: string;
  motivo: string;
  tentativas: number;
  desdeEm: string;
}

export interface Caderno {
  ler(): Adiado | null;
  adiar(dia: string, motivo: string): Adiado;
  limpar(): void;
}

/** Até quando insistir; passou disso, o problema não é de insistência. */
export const MAX_TENTATIVAS = 12;

export function criarCaderno(arquivo: string): Caderno {
  return {
    ler() {
      try {
        return JSON.parse(readFileSync(arquivo, "utf8")) as Adiado;
      } catch {
        return null;
      }
    },
    adiar(dia, motivo) {
      const atual = this.ler();
      const nova: Adiado =
        atual?.dia === dia
          ? { ...atual, motivo, tentativas: atual.tentativas + 1 }
          : { dia, motivo, tentativas: 1, desdeEm: new Date().toISOString() };
      mkdirSync(dirname(arquivo), { recursive: true });
      writeFileSync(arquivo, JSON.stringify(nova, null, 1));
      return nova;
    },
    limpar() {
      try {
        rmSync(arquivo);
      } catch {
        /* já não existia */
      }
    },
  };
}
