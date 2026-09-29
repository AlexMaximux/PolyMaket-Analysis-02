import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { collectHistoryMarketSlugs } from '../src/lib/marketResolver';

function ts(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

describe('collectHistoryMarketSlugs', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('finds a recent btc file even when six other coins alphabetically after it fill up first', () => {
    // Reproduces the real bug: files.sort().reverse() sorts by full filename (coin prefix first),
    // so reverse-alphabetical order processes zec/xrp/sol/hype/eth/doge before ever reaching btc/bnb.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-test-'));
    const write = (coin: string, when: Date, slug: string) =>
      fs.writeFileSync(path.join(dir!, `${coin}_updown_${ts(when)}_ET.json`), JSON.stringify({ cards: { '1h': { slug } } }));

    const now = new Date();
    for (const coin of ['zec', 'xrp', 'sol', 'hype', 'eth', 'doge']) {
      write(coin, now, `${coin}-recent`);
    }
    write('btc', now, 'btc-recent');

    const slugs = collectHistoryMarketSlugs(3, dir);
    expect(slugs.has('btc-recent')).toBe(true);
  });

  it('excludes files older than maxDays regardless of coin', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-test-'));
    const write = (coin: string, when: Date, slug: string) =>
      fs.writeFileSync(path.join(dir!, `${coin}_updown_${ts(when)}_ET.json`), JSON.stringify({ cards: { '1h': { slug } } }));

    const now = new Date();
    const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    write('btc', now, 'btc-recent');
    write('btc', fiveDaysAgo, 'btc-stale');

    const slugs = collectHistoryMarketSlugs(3, dir);
    expect(slugs.has('btc-recent')).toBe(true);
    expect(slugs.has('btc-stale')).toBe(false);
  });
});
