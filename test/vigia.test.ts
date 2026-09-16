import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/**
 * O que estes testes protegem: o número do bot.
 *
 * Mandar a mesma cobrança de hora em hora é o caminho mais curto para o
 * WhatsApp restringir o número — e já restringiu uma vez neste projeto.
 */
const enviados: string[] = [];
const contas = vi.fn();

vi.mock('../src/data/meta.js', () => ({ saudeDasContas: () => contas() }));
vi.mock('../src/whatsapp/evolution.js', () => ({
  enviarTextoAosDonos: async (t: string) => {
    enviados.push(t);
    return 1;
  },
}));

const { verificarContas } = await import('../src/vigia.js');

// São Paulo é UTC-3: 9h de SP é 12:00Z do mesmo dia; 22h de SP é 01:00Z do dia seguinte.
const emSP = (hora: number) => new Date(Date.UTC(2026, 8, 17, hora + 3, 0, 0));

const pendente = [
  { id: '1', nome: 'L&F01', estado: 'período de tolerância (cobrança pendente)', gravidade: 'atencao' as const, valorEmAberto: 1234 },
];
const desativada = [
  { id: '1', nome: 'L&F01', estado: 'desativada', gravidade: 'critico' as const },
];

beforeEach(() => {
  enviados.length = 0;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('vigia', () => {
  it('manda a cobrança uma vez só, mesmo checando de hora em hora', async () => {
    contas.mockResolvedValue(pendente);
    for (const h of [9, 10, 11, 12, 13, 14]) {
      vi.setSystemTime(emSP(h));
      await verificarContas();
    }
    expect(enviados.filter((t) => t.includes('Cobrança pendente'))).toHaveLength(1);
  });

  it('deploy fora das 9h não dispara cobrança, mesmo com memória zerada', async () => {
    contas.mockResolvedValue(pendente);
    for (const h of [10, 13, 16, 19, 22]) {
      vi.setSystemTime(emSP(h));
      await verificarContas();
    }
    expect(enviados).toHaveLength(0);
  });

  it('não manda cobrança de madrugada', async () => {
    contas.mockResolvedValue(pendente);
    vi.setSystemTime(emSP(3));
    await verificarContas();
    expect(enviados).toHaveLength(0);
  });

  it('conta desativada avisa na hora, a qualquer hora', async () => {
    contas.mockResolvedValue(desativada);
    vi.setSystemTime(emSP(3));
    await verificarContas();
    expect(enviados.filter((t) => t.includes('Conta desativada'))).toHaveLength(1);
  });

  it('conta ativa de novo avisa que normalizou', async () => {
    contas.mockResolvedValue(desativada);
    vi.setSystemTime(emSP(10));
    await verificarContas();
    enviados.length = 0;
    contas.mockResolvedValue([{ id: '1', nome: 'L&F01', estado: 'ativa', gravidade: 'ok' as const }]);
    await verificarContas();
    expect(enviados.filter((t) => t.includes('normalizada'))).toHaveLength(1);
  });

  it('falha de leitura da API não vira alerta nem falsa normalização', async () => {
    contas.mockResolvedValue([
      { id: '1', nome: 'L&F01', estado: 'não consegui consultar (500)', gravidade: 'desconhecido' as const },
    ]);
    vi.setSystemTime(emSP(10));
    await verificarContas();
    expect(enviados).toHaveLength(0);
  });
});
