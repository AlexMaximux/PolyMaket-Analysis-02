import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ensureTfmService, resetTfmServiceForTests } from '@/lib/tfm/service';

const deps = (over: Record<string, unknown> = {}) => {
  const spawnServer = vi.fn();
  let t = 1_000_000;
  return { spawnServer, tick: (ms: number) => { t += ms; },
    d: { health: async () => ({ ok: false }), installed: () => true, spawnServer, now: () => t, autostart: true, ...over } };
};

describe('ensureTfmService', () => {
  beforeEach(() => resetTfmServiceForTests());
  it('does nothing when the service answers', async () => {
    const x = deps({ health: async () => ({ ok: true }) });
    expect(await ensureTfmService(x.d)).toBe('ready');
    expect(x.spawnServer).not.toHaveBeenCalled();
  });
  it('never starts what is not installed, or when autostart is off', async () => {
    const a = deps({ installed: () => false });
    expect(await ensureTfmService(a.d)).toBe('not-installed');
    const b = deps({ autostart: false });
    expect(await ensureTfmService(b.d)).toBe('offline');
    expect(a.spawnServer).not.toHaveBeenCalled();
    expect(b.spawnServer).not.toHaveBeenCalled();
  });
  it('starts it once, and again only after 90 seconds without an answer', async () => {
    const x = deps();
    expect(await ensureTfmService(x.d)).toBe('starting');
    expect(await ensureTfmService(x.d)).toBe('starting');
    expect(x.spawnServer).toHaveBeenCalledTimes(1);
    x.tick(91_000);
    expect(await ensureTfmService(x.d)).toBe('starting');
    expect(x.spawnServer).toHaveBeenCalledTimes(2);
  });
});
