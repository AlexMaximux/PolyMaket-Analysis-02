import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import * as dbModule from '../src/lib/db';
import { applySettingChanges } from '../src/lib/settings';
import { alertStrategy, evaluateJevRecordSignal, readSameHourRows } from '../src/lib/jevAlerts';
import { sendJevTestAlert } from '../src/lib/jevTestAlert';
import { forwardSnapshotRow } from '../src/lib/forwardSnapshot';
import { STRATEGIES_BY_ID, STRATEGY_HISTORY, FROZEN_STRATEGY_2, FROZEN_STRATEGY_3, FROZEN_STRATEGY_4, FROZEN_STRATEGY_5, FROZEN_STRATEGY } from '../src/lib/signalAnalysis';

type Opts = { score?: number; conf?: number; dir?: 'UP' | 'DOWN'; kev?: 'UP' | 'DOWN'; span?: 'UP' | 'DOWN'; solar?: { dir: 'UP' | 'DOWN'; conf: number } | null; coin?: string };
const rec = (hm: string, o: Opts = {}) => {
  const { score = 3.8, conf = 0.95, dir = 'UP', kev = dir, span = dir, solar = null, coin = 'BTC' } = o;
  const [mm, ss = '00'] = hm.split(':').slice(1).length ? [hm.split(':')[1], hm.split(':')[2]] : ['00'];
  const hh = hm.split(':')[0];
  const filename = `${coin.toLowerCase()}_updown_2026-09-27_${hh}-${mm}-${ss ?? '00'}_ET.json`;
  return {
    filename, coin, et_time: `2026-09-27 ${hh}:${mm}:${ss ?? '00'} ET`, timestamp: `2026-09-27T${String(Number(hh) + 4).padStart(2, '0')}:${mm}:00.000Z`,
    cards: { '1h': { slug: 'bitcoin-up-or-down-september-27-2026-3pm-et', up: 0.8 } },
    spot_price: 100, open_price: 99,
    predictions: {
      jev: { score, score_confidence: conf, direction: dir },
      kev: { score: 3.6, direction: kev }, span: { score: 3.2, direction: span },
      ...(solar ? { solar: { direction: solar.dir, score_confidence: solar.conf } } : {}),
    },
  };
};
const ev = (id: string, r: ReturnType<typeof rec>, prior: ReturnType<typeof rec>[] = []) =>
  evaluateJevRecordSignal(r, STRATEGIES_BY_ID[id], prior.map(p => forwardSnapshotRow(p.filename, p))).isSignal;

describe('every frozen strategy can drive the alert, with the meaning it has on Cloud Analysis', () => {
  it('lists v1, v2, s2, s3, s4 and s5', () => {
    expect(Object.keys(STRATEGIES_BY_ID)).toEqual(['v1', 'v2', 's2', 's3', 's4', 's5']);
    expect(STRATEGIES_BY_ID.v1).toBe(STRATEGY_HISTORY[0]);
    expect(STRATEGIES_BY_ID.s2).toBe(FROZEN_STRATEGY_2);
    expect(STRATEGIES_BY_ID.s3).toBe(FROZEN_STRATEGY_3);
    expect(STRATEGIES_BY_ID.s4).toBe(FROZEN_STRATEGY_4);
    expect(STRATEGIES_BY_ID.s5).toBe(FROZEN_STRATEGY_5);
  });
  it('v1 has no minute filter, v2 starts at minute 32', () => {
    expect([ev('v1', rec('15:10')), ev('v2', rec('15:10'))]).toEqual([true, false]);
  });
  it('s2 also needs Solar confidence of 80% or more, and a Solar answer at all', () => {
    const solar = (conf: number) => ev('s2', rec('15:40', { solar: { dir: 'UP', conf } }));
    expect([solar(0.85), solar(0.7), ev('s2', rec('15:40'))]).toEqual([true, false, false]);
    expect(ev('v2', rec('15:40'))).toBe(true);
  });
  it('s3 skips an hour where a signal the other way, at any confidence, already appeared', () => {
    const flip = rec('15:10', { dir: 'DOWN', score: 0.2, conf: 0.6 });
    expect([ev('v2', rec('15:40'), [flip]), ev('s3', rec('15:40'), [flip]), ev('s3', rec('15:40'))]).toEqual([true, false, true]);
  });
  it('s4 is Jev alone on any coin, and only when the hour first signal comes at minute 45 or later', () => {
    const jevAlone = rec('15:46', { score: 3.3, conf: 0.86, kev: 'DOWN', span: 'DOWN' });
    expect([ev('s4', jevAlone), ev('v2', jevAlone)]).toEqual([true, false]);
    expect(ev('s4', rec('15:46', { score: 3.3, conf: 0.86, coin: 'ETH' }))).toBe(true);
    const early = rec('15:20', { score: 3.3, conf: 0.9 }); // the hour's first signal is too early: the hour is skipped
    expect(ev('s4', jevAlone, [early])).toBe(false);
  });
  it('only the first signal of the hour alerts', () => {
    expect(ev('v2', rec('15:40'), [rec('15:35')])).toBe(false);
    expect(ev('v2', rec('15:35'), [rec('15:40')])).toBe(true); // a later row is not "before" it
  });
  it('reads the earlier rows of the same coin and hour from jev/history', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jevhist-'));
    fs.mkdirSync(path.join(dir, 'jev', 'history'), { recursive: true });
    const put = (r: ReturnType<typeof rec>) => fs.writeFileSync(path.join(dir, 'jev', 'history', r.filename), JSON.stringify(r));
    const early = rec('15:35'), current = rec('15:40');
    put(early); put(current); put(rec('14:35')); put(rec('15:36', { coin: 'ETH' }));
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    const rows = readSameHourRows(current, current.filename);
    expect(rows.map(r => r.filename)).toEqual([early.filename]);
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('the Jev alert rule setting and the test alert', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); dbModule.initializeDb(db); vi.spyOn(dbModule, 'getDb').mockReturnValue(db); });
  afterEach(() => { vi.restoreAllMocks(); db.close(); });

  it('accepts every strategy id and bot', () => {
    for (const id of ['v1', 'v2', 's2', 's3', 's4', 's5', 'bot']) expect(applySettingChanges({ 'jev.alertStrategy': id as never }).ok).toBe(true);
    expect(applySettingChanges({ 'jev.alertStrategy': 's6' as never }).ok).toBe(false);
    applySettingChanges({ 'jev.alertStrategy': 's3' });
    expect(alertStrategy()).toBe(FROZEN_STRATEGY_3);
  });

  const telegram = () => applySettingChanges({ 'jev.telegramToken': '123456789:abcdefghijklmnopqrstuvwxyz123456789', 'jev.telegramChat': '777' });
  const deps = (records: ReturnType<typeof rec>[]) => ({
    send: vi.fn().mockResolvedValue(true),
    rows: () => records.map(r => forwardSnapshotRow(r.filename, r)),
    record: (f: string) => (records.find(r => r.filename === f) ?? null) as Record<string, unknown> | null,
  });

  it('needs the Jev Telegram settings, and sends nothing without them', async () => {
    const d = deps([rec('15:40')]);
    expect((await sendJevTestAlert(d)).ok).toBe(false);
    expect(d.send).not.toHaveBeenCalled();
  });
  it('sends the alert as it really looks, built from the latest signal of the selected rule, marked as a test', async () => {
    telegram();
    applySettingChanges({ 'jev.alertStrategy': 's5' });
    const d = deps([rec('15:35'), rec('16:31', { dir: 'DOWN', score: 0.6, conf: 0.4 })]); // s5 accepts both; the second is the latest
    const r = await sendJevTestAlert(d);
    expect(r.ok).toBe(true);
    const [, chat, text] = d.send.mock.calls[0] as [string, string, string];
    expect(chat).toBe('777');
    expect(text.startsWith('🧪')).toBe(true);
    expect(text).toContain('قانون s5');
    expect(text).toContain('هشدار سیگنال معاملاتی');
    expect(text).toContain('DOWN');
    expect(text).toContain('Frozen strategy 1 + Optimised');
  });
  it('records nothing: it never marks an alert as sent', async () => {
    telegram();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jevtest-'));
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    await sendJevTestAlert(deps([rec('15:40')]));
    expect(fs.existsSync(path.join(dir, 'jev', 'alerts_sent.json'))).toBe(false);
    expect((db.prepare("SELECT count(*) AS n FROM alert_seen").get() as { n: number }).n).toBe(0);
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it('says so when the rule has had no signal, and when Telegram rejects the message', async () => {
    telegram();
    applySettingChanges({ 'jev.alertStrategy': 'v2' });
    const quiet = deps([rec('15:10')]); // minute 10: no v2 signal
    expect((await sendJevTestAlert(quiet)).message).toContain('no recent signal');
    expect(quiet.send.mock.calls[0][2]).toContain('سیگنالی از قانون v2 نبود');
    const bad = deps([rec('15:40')]);
    bad.send.mockResolvedValue(false);
    expect((await sendJevTestAlert(bad)).ok).toBe(false);
    expect((await sendJevTestAlert(deps([]))).ok).toBe(false);
    void FROZEN_STRATEGY;
  });
});
