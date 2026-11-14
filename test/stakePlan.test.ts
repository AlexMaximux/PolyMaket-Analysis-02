import { describe, it, expect } from 'vitest';
import { applyStakePlan, runLab, sanitizeLabConfig } from '@/lib/jevLab';
import { DEFAULT_ANALYSIS_CONFIG, computeMetrics, tradePnl, type SnapshotRow, type StakePlan, type Trade, type TradeStatus } from '@/lib/signalAnalysis';

// A trade at entry 0.2: a win pays 4x the stake, a loss costs the stake.
const trade = (status: TradeStatus, entry = 0.2): Trade => ({
  row: {} as SnapshotRow, coin: 'BTC', marketKey: 'k', time: 0, minute: 40, hour: 10, date: '2026-11-12', dir: 'UP',
  modelScore: 4, modelConf: 95, agreeCount: 3, priorOpposite: false, priceMove: null, fastMoveBlocked: false,
  quote: entry, entry, tfmProb: null, tfmEdge: null, status, pnl: tradePnl(status, entry, 10),
});
const seq = (s: string, entry = 0.2) => [...s].map((c) => trade(c === 'W' ? 'WIN' : c === 'L' ? 'LOSS' : 'PENDING', entry));
const plan = (stakePlan: StakePlan, stake = 50, bankroll = 500, stakePercent = 10, stakeCap = 800) => ({ stakePlan, stake, bankroll, stakePercent, stakeCap });
const stakes = (p: StakePlan, s: string, entry?: number, stake?: number, bankroll?: number) =>
  applyStakePlan(seq(s, entry), plan(p, stake, bankroll)).trades.map((t) => t.stake);

describe('applyStakePlan', () => {
  it('leaves the flat plan alone', () => {
    const t = seq('WLW');
    const r = applyStakePlan(t, plan('flat'));
    expect(r.trades).toBe(t);
    expect(r.staking).toBeNull();
  });

  it('p1 doubles after a loss and returns to the base after a win', () => {
    // entry 0.5: win pays the stake
    // always 2x the base after a loss, never 4x after two losses
    expect(stakes('p1', 'LWWLLW', 0.5)).toEqual([50, 100, 50, 50, 100, 100]);
    const r = applyStakePlan(seq('LWW', 0.5), plan('p1'));
    expect(r.trades.map((t) => t.pnl)).toEqual([-50, 100, 50]);
    expect(r.staking!.final).toBe(600);
    expect(r.staking!.maxStake).toBe(100);
  });

  it('p2 raises the base each time the balance doubles and lowers it again; p3 never lowers it', () => {
    // bankroll 500, entry 0.2 (win = +4x): 500 -> 700 -> 900 -> 1100 (tier 1), then losses
    expect(stakes('p2', 'WWWLLL')).toEqual([50, 50, 50, 100, 200, 100]);
    expect(stakes('p3', 'WWWLLL')).toEqual([50, 50, 50, 100, 200, 200]);
    expect(stakes('p1', 'WWWLLL')).toEqual([50, 50, 50, 50, 100, 100]);
  });

  it('starts the next tier exactly at twice the bankroll', () => {
    // 500 +450 (stake 50 at entry 0.1: win pays 9x) = 950, +450 = 1400
    expect(stakes('p2', 'WWW', 0.1)).toEqual([50, 50, 100]);
  });

  it('never stakes more than the balance, and reports ruin and skipped trades', () => {
    const r = applyStakePlan(seq('LLLL', 0.5), plan('p1', 50, 100));
    expect(r.trades.map((t) => t.stake)).toEqual([50, 50, 0, 0]);
    expect(r.trades.map((t) => t.pnl)).toEqual([-50, -50, 0, 0]);
    expect(r.staking).toMatchObject({ final: 0, lowest: 0, ruined: true, ruinedAtTrade: 3, skipped: 2 });
  });

  it('is not ruined while the balance can pay the base stake', () => {
    const r = applyStakePlan(seq('LLW', 0.5), plan('p1', 50, 500));
    expect(r.staking!.ruined).toBe(false);
    expect(r.staking!.ruinedAtTrade).toBeNull();
    expect(r.staking!.lowest).toBe(350);
    expect(r.staking!.maxDrawdownPct).toBeCloseTo(150 / 500, 6);
  });

  it('gives a pending trade a stake but does not move the balance', () => {
    const r = applyStakePlan(seq('LP', 0.5), plan('p1'));
    expect(r.trades.map((t) => [t.stake, t.pnl])).toEqual([[50, -50], [100, 0]]);
    expect(r.staking!.final).toBe(450);
  });
});

describe('applyStakePlan p4 (percent of the balance, 2x after a loss, capped)', () => {
  it('stakes a percentage of the current balance and doubles the percentage after a loss', () => {
    // entry 0.5: win pays the stake. 500 -L50-> 450 -W90-> 540 -W54-> 594
    const r = applyStakePlan(seq('LWW', 0.5), plan('p4'));
    expect(r.trades.map((t) => t.stake)).toEqual([50, 90, 54]);
    expect(r.trades.map((t) => t.pnl)).toEqual([-50, 90, 54]);
    expect(r.staking!.final).toBeCloseTo(594, 6);
    expect(r.staking!.maxStake).toBeCloseTo(90, 6);
  });
  it('ignores the base stake', () => {
    expect(applyStakePlan(seq('W', 0.5), plan('p4', 5, 500)).trades[0].stake).toBe(50);
  });
  it('never stakes more than the cap, also after a loss', () => {
    const r = applyStakePlan(seq('LWL', 0.5), plan('p4', 50, 10000, 10, 800));
    expect(r.trades.map((t) => t.stake)).toEqual([800, 800, 800]);
  });
  it('never runs the balance to zero, and flags a fall to half the bankroll or less', () => {
    // 500 -> 450 -> 360 -> 288 -> 230.4 (stakes 50, 90, 72, 57.6)
    const r = applyStakePlan(seq('LLLLL', 0.5), plan('p4'));
    expect(r.trades.slice(0, 4).map((t) => t.stake)).toEqual([50, 90, 72, expect.closeTo(57.6, 6)]);
    expect(r.staking).toMatchObject({ ruined: true, ruinedAtTrade: 4, skipped: 0 });
    expect(r.staking!.final).toBeGreaterThan(0);
  });
  it('is not flagged while the balance stays above half the bankroll', () => {
    const r = applyStakePlan(seq('LLW', 0.5), plan('p4'));
    expect(r.staking!.ruined).toBe(false);
    expect(r.staking!.ruinedAtTrade).toBeNull();
  });
});

describe('computeMetrics with per-trade stakes', () => {
  it('measures ROI on the money actually staked', () => {
    const t = applyStakePlan(seq('LW', 0.5), plan('p1')).trades; // stakes 50 and 100, pnl -50 and +100
    const m = computeMetrics(t, 50);
    expect(m.pnl).toBe(50);
    expect(m.roi).toBeCloseTo(50 / 150, 6);
  });
  it('is unchanged without per-trade stakes', () => {
    const t = seq('LW', 0.5).map((x) => ({ ...x, pnl: tradePnl(x.status, x.entry, 10) }));
    expect(computeMetrics(t, 10).roi).toBeCloseTo(0, 6);
  });
});

describe('sanitizeLabConfig stake plan', () => {
  it('keeps a valid plan and bankroll, falls back otherwise', () => {
    const ok = sanitizeLabConfig({ stakePlan: 'p2', bankroll: 500 });
    expect([ok.stakePlan, ok.bankroll]).toEqual(['p2', 500]);
    const bad = sanitizeLabConfig({ stakePlan: 'martingale', bankroll: -5 });
    expect([bad.stakePlan, bad.bankroll]).toEqual(['flat', 1]);
    expect(sanitizeLabConfig({}).stakePlan).toBe('flat');
    const p4 = sanitizeLabConfig({ stakePlan: 'p4', stakePercent: 10, stakeCap: 800 });
    expect([p4.stakePlan, p4.stakePercent, p4.stakeCap]).toEqual(['p4', 10, 800]);
    const def = sanitizeLabConfig({});
    expect([def.stakePercent, def.stakeCap]).toEqual([10, 800]);
    const bad4 = sanitizeLabConfig({ stakePercent: 500, stakeCap: -1 });
    expect([bad4.stakePercent, bad4.stakeCap]).toEqual([100, 1]);
  });
});

describe('runLab with a stake plan', () => {
  const row = (hour: number, outcome: 'UP' | 'DOWN'): SnapshotRow => ({
    filename: `btc_updown_2026-11-12_${hour}-40-00_ET.json`, coin: 'BTC', et_time: `2026-11-12 ${hour}:40:00 ET`,
    timestamp: `2026-11-12T${hour + 5}:40:00.000Z`, market_slug: `bitcoin-up-or-down-november-12-2026-${hour}am-et`,
    score: 3.8, score_confidence: 95, direction: 'UP', up_1h_num: 50, market_outcome: outcome,
  });
  const rows = [row(10, 'DOWN'), row(11, 'UP'), row(12, 'UP')];
  const base = { ...DEFAULT_ANALYSIS_CONFIG, coins: ['BTC'], dedupe: 'firstPerHour' as const, stake: 50, bankroll: 500 };

  it('sizes trades by the plan and reports the balance', () => {
    const run = runLab(rows, { ...base, stakePlan: 'p1' });
    expect(run.trades.map((t) => t.stake)).toEqual([50, 100, 50]);
    expect(run.metrics.pnl).toBe(100); // -50 + 100 + 50
    expect(run.staking).toMatchObject({ plan: 'p1', start: 500, final: 600, ruined: false });
  });

  it('leaves the flat run as it was', () => {
    const run = runLab(rows, { ...base, stakePlan: 'flat' });
    expect(run.staking).toBeNull();
    expect(run.trades.every((t) => t.stake === undefined)).toBe(true);
    expect(run.metrics.pnl).toBe(50); // -50 + 50 + 50
  });
});
