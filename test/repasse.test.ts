import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

const ambiente = { ...process.env };

describe('repasse de eventos para outro sistema', () => {
  beforeEach(() => {
    // A configuração é lida uma vez e guardada em memória: sem resetar os
    // módulos, o segundo teste leria o ambiente do primeiro.
    vi.resetModules();
    process.env.WEBHOOK_REPASSE_URL = 'https://financeiro.exemplo.com/wa/eventos';
    process.env.WEBHOOK_REPASSE_JIDS = '120363000000000001@g.us, 120363000000000002@g.us';
  });
  afterEach(() => {
    process.env = { ...ambiente };
  });

  it('reconhece o grupo que pertence ao outro sistema', async () => {
    const { ehDeRepasse } = await import('../src/whatsapp/repasse.js');
    expect(ehDeRepasse('120363000000000001@g.us')).toBe(true);
  });

  it('não repassa conversa pessoal', async () => {
    const { ehDeRepasse } = await import('../src/whatsapp/repasse.js');
    expect(ehDeRepasse('5511999999999@s.whatsapp.net')).toBe(false);
  });

  it('não repassa grupo que não está na lista', async () => {
    const { ehDeRepasse } = await import('../src/whatsapp/repasse.js');
    expect(ehDeRepasse('120363000000000009@g.us')).toBe(false);
  });

  it('sem destino configurado, nada é repassado', async () => {
    delete process.env.WEBHOOK_REPASSE_URL;
    const { ehDeRepasse, temRepasse } = await import('../src/whatsapp/repasse.js');
    expect(temRepasse()).toBe(false);
    expect(ehDeRepasse('120363000000000001@g.us')).toBe(false);
  });
});
