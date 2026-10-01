import fs from 'fs';
import path from 'path';
import { loadEnvConfig } from '@next/env';
import { fetchUpdownSnapshot } from './updownSnapshot';
import { checkAndSendJevSignalAlert } from './jevAlerts';
import { getSetting } from './settings';

try {
  loadEnvConfig(process.cwd());
} catch {}

/** OpenRouter key from /control settings (falls back to OPENROUTER_API_KEY in .env.local). */
function openRouterKey(apiKey?: string): string {
  return apiKey || getSetting('openrouter.apiKey');
}

function getCard(row: any) {
  if (!row) return null;
  const up = row.live ?? row.up ?? null;
  const down = row.liveDown ?? (up != null ? 1 - up : null);
  return {
    title: row.title ?? null,
    slug: row.slug ?? null,
    status: row.accepting ? 'OPEN' : 'CLOSED',
    up: up != null ? Number(up.toFixed(4)) : null,
    down: down != null ? Number(down.toFixed(4)) : null,
    up_display: up != null ? `${(up * 100).toFixed(1)}%` : null,
    down_display: down != null ? `${(down * 100).toFixed(1)}%` : null,
  };
}

export const COIN_NAMES: Record<string, string> = {
  btc: 'Bitcoin',
  eth: 'Ethereum',
  sol: 'Solana',
  xrp: 'XRP',
  doge: 'Dogecoin',
  hype: 'Hyperliquid',
  bnb: 'BNB',
};

export async function generateJevSnapshot(coin = 'btc') {
  const coinKey = (coin || 'btc').toLowerCase();
  const coinLabel = COIN_NAMES[coinKey] || coinKey.toUpperCase();
  const data = await fetchUpdownSnapshot(coinKey);
  if (!data) {
    throw new Error(`Failed to fetch Up/Down data for ${coinLabel} (${coinKey}) from internal API`);
  }

  const now = new Date();
  const timeET = now.toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
  const timeET24 = now.toLocaleTimeString('en-GB', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const dateET = now.toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
  });

  const m1h = data.m1h;
  const m15 = data.m15;
  const m5 = data.m5;

  const fair15m = data.model?.fairUp != null ? Number(data.model.fairUp.toFixed(4)) : null;
  const fair5m = data.model5?.fairUp != null ? Number(data.model5.fairUp.toFixed(4)) : null;
  const fairBase = data.modelA?.fairUp != null ? Number(data.modelA.fairUp.toFixed(4)) : null;
  const fairJoint = data.modelC?.valid && data.modelC?.fairUp != null ? Number(data.modelC.fairUp.toFixed(4)) : null;

  const spotPrice = data.spotPrice != null ? Number(data.spotPrice) : data.model?.st != null ? Number(data.model.st) : null;
  const openPrice = data.openPrice != null ? Number(data.openPrice) : data.model?.s0 != null ? Number(data.model.s0) : null;

  const payload = {
    et_time: `${dateET} ${timeET24} ET`,
    date_et: dateET,
    current_time_et: timeET,
    current_time_et_24h: timeET24,
    timestamp: now.toISOString(),
    coin: coinKey.toUpperCase(),
    coin_label: coinLabel,
    spot_price: spotPrice,
    open_price: openPrice,
    price_to_beat: openPrice,
    cards: {
      '1h': getCard(m1h),
      '15m': getCard(m15),
      '5m': getCard(m5),
    },
    fair_values: {
      model_15m: fair15m,
      model_5m: fair5m,
      base_no_drift: fairBase,
      joint_solve: fairJoint,
    },
    // Kept for backtests only (callJevDecision forwards cards + fair_values, not these):
    // the exact model inputs and the tradeable Up-token book at snapshot time.
    model_inputs: {
      model_version: data.modelVersion ?? null,   // which fair-value formulas produced fair_values
      t: data.t ?? null,
      s0: data.openPrice ?? null,
      sa: data.model?.sa ?? null,
      sa5: data.sa5 ?? null,
      st: data.spotPrice ?? null,
      sigma1h: data.sigma1h ?? null,
      sigma_source: data.sigmaSource ?? null,
      p15: data.model?.p15 ?? null,
      p5: data.model5?.p5 ?? null,
    },
    books: {
      '1h': m1h?.book ?? null,
      '15m': m15?.book ?? null,
    },
  };

  const jsonStr = JSON.stringify(payload, null, 2);

  const jevDir = path.join(process.cwd(), 'jev');
  const publicJevDir = path.join(process.cwd(), 'public', 'jev');

  for (const dir of [jevDir, publicJevDir]) {
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(path.join(dir, `${coinKey}_updown.json`), jsonStr, 'utf8');
      if (coinKey === 'btc') {
        fs.writeFileSync(path.join(dir, 'latest.json'), jsonStr, 'utf8');
        fs.writeFileSync(path.join(dir, 'data.json'), jsonStr, 'utf8');
      }
    } catch {}
  }

  return payload;
}

async function fetchWithRetry(url: string, options: RequestInit, retries = 2, delayMs = 1200): Promise<Response> {
  let lastError: any = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.status === 429 || res.status >= 500) {
        if (attempt < retries) {
          const waitTime = delayMs * (attempt + 1);
          console.warn(`[OpenRouter] Received ${res.status}, retrying in ${waitTime}ms (attempt ${attempt + 1}/${retries})...`);
          await new Promise((r) => setTimeout(r, waitTime));
          continue;
        }
      }
      return res;
    } catch (err: any) {
      lastError = err;
      if (attempt < retries) {
        const waitTime = delayMs * (attempt + 1);
        console.warn(`[OpenRouter] Network error (${err.message}), retrying in ${waitTime}ms...`);
        await new Promise((r) => setTimeout(r, waitTime));
        continue;
      }
    }
  }
  throw lastError || new Error(`Fetch failed after ${retries} retries`);
}

export async function callJevDecision(snapshotData: any, apiKey?: string) {
  const key = openRouterKey(apiKey);
  const coinLabel = snapshotData.coin_label || snapshotData.coin || 'Crypto';

  const payload = {
    model: 'typesafe/jev-1.13',
    state: {
      et_time: snapshotData.et_time,
      coin: snapshotData.coin,
      coin_label: coinLabel,
      cards: snapshotData.cards,
      fair_values: snapshotData.fair_values,
    },
    questions: {
      one_hour_score: {
        type: 'score',
        instructions:
          `Predict the 1-hour ${coinLabel} outcome score on an ordered scale (0 to 4) from Strong Down to Strong Up based on current market probabilities and fair values.`,
        criteria: [
          'Strong Down',
          'Lean Down',
          'Neutral',
          'Lean Up',
          'Strong Up',
        ],
      },
      one_hour_direction: {
        type: 'choice',
        instructions:
          `Which direction is more probable for ${coinLabel} 1-hour market close?`,
        criteria: {
          UP: `${coinLabel} is more likely to close above the hour open price.`,
          DOWN: `${coinLabel} is more likely to close below the hour open price.`,
        },
      },
    },
  };

  const res = await fetchWithRetry('https://openrouter.ai/api/alpha/decisions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenRouter Jev error (${res.status}): ${errText}`);
  }

  const decision = await res.json();
  const answers = decision.answers || {};
  const scoreRaw = answers.one_hour_score?.score;
  const score = scoreRaw != null ? Number(Number(scoreRaw).toFixed(2)) : null;

  let scoreInterpretation = 'نامشخص';
  if (score != null) {
    if (score >= 3.0) scoreInterpretation = 'Strong Up (صعودی قوی) 🚀';
    else if (score >= 2.2) scoreInterpretation = 'Lean Up (تمایل به صعود) ↗';
    else if (score >= 1.8) scoreInterpretation = 'Neutral (خنثی / تعادل) ⚖';
    else if (score >= 1.0) scoreInterpretation = 'Lean Down (تمایل به نزول) ↘';
    else scoreInterpretation = 'Strong Down (نزولی قوی) 🔻';
  }

  return {
    model: decision.model || 'typesafe/jev-1.13',
    coin: snapshotData.coin,
    score,
    score_interpretation: scoreInterpretation,
    score_confidence: answers.one_hour_score?.confidence ?? null,
    score_probabilities: answers.one_hour_score?.probabilities ?? null,
    direction: answers.one_hour_direction?.choice ?? null,
    direction_confidence: answers.one_hour_direction?.confidence ?? null,
    direction_probabilities: answers.one_hour_direction?.probabilities ?? null,
    prob_up: answers.one_hour_direction?.probabilities?.UP != null ? Number((answers.one_hour_direction.probabilities.UP * 100).toFixed(1)) : null,
    prob_down: answers.one_hour_direction?.probabilities?.DOWN != null ? Number((answers.one_hour_direction.probabilities.DOWN * 100).toFixed(1)) : null,
    tokens: decision.usage?.input_tokens ?? null,
    cost: decision.usage?.cost ?? null,
    raw_decision: decision,
  };
}

export const KEV_MODEL = 'jaredpalmer/kev-4b';
export const SOLAR_MODEL = 'upstage/solar-decide';
export const TEV_MODEL = 'togethercomputer/tev1-4b-experimental';
export const MERCURY_MODEL = 'inception/mercury-decide:free';

export const callKevDecision = (snapshotData: any, apiKey?: string) => callStandardDecision(KEV_MODEL, 'Kev', snapshotData, apiKey);
export const callSolarDecision = (snapshotData: any, apiKey?: string) => callStandardDecision(SOLAR_MODEL, 'Solar', snapshotData, apiKey);
export const callTevDecision = (snapshotData: any, apiKey?: string) => callStandardDecision(TEV_MODEL, 'Tev', snapshotData, apiKey);
export const callMercuryDecision = (snapshotData: any, apiKey?: string) => callStandardDecision(MERCURY_MODEL, 'Mercury', snapshotData, apiKey);

/** Kev, Solar, Tev and Mercury take the same score + direction questions and return the same answer shape. */
async function callStandardDecision(modelId: string, label: string, snapshotData: any, apiKey?: string) {
  const key = openRouterKey(apiKey);
  const coinLabel = snapshotData.coin_label || snapshotData.coin || 'Crypto';

  const payload = {
    model: modelId,
    state: {
      et_time: snapshotData.et_time,
      coin: snapshotData.coin,
      coin_label: coinLabel,
      cards: snapshotData.cards,
      fair_values: snapshotData.fair_values,
    },
    questions: {
      one_hour_score: {
        type: 'score',
        instructions:
          `Predict the 1-hour ${coinLabel} outcome score on an ordered scale (0 to 4) from Strong Down to Strong Up based on current market probabilities and fair values.`,
        criteria: [
          'Strong Down',
          'Lean Down',
          'Neutral',
          'Lean Up',
          'Strong Up',
        ],
      },
      one_hour_direction: {
        type: 'choice',
        instructions:
          `Which direction is more probable for ${coinLabel} 1-hour market close?`,
        criteria: {
          UP: `${coinLabel} is more likely to close above the hour open price.`,
          DOWN: `${coinLabel} is more likely to close below the hour open price.`,
        },
      },
    },
  };

  const res = await fetchWithRetry('https://openrouter.ai/api/alpha/decisions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenRouter ${label} error (${res.status}): ${errText}`);
  }

  const decision = await res.json();
  const answers = decision.answers || {};
  const scoreRaw = answers.one_hour_score?.score;
  const score = scoreRaw != null ? Number(Number(scoreRaw).toFixed(2)) : null;

  let scoreInterpretation = 'نامشخص';
  if (score != null) {
    if (score >= 3.0) scoreInterpretation = 'Strong Up (صعودی قوی) 🚀';
    else if (score >= 2.2) scoreInterpretation = 'Lean Up (تمایل به صعود) ↗';
    else if (score >= 1.8) scoreInterpretation = 'Neutral (خنثی / تعادل) ⚖';
    else if (score >= 1.0) scoreInterpretation = 'Lean Down (تمایل به نزول) ↘';
    else scoreInterpretation = 'Strong Down (نزولی قوی) 🔻';
  }

  const upProb = answers.one_hour_direction?.probabilities?.UP;
  const downProb = answers.one_hour_direction?.probabilities?.DOWN;

  return {
    model: decision.model || modelId,
    coin: snapshotData.coin,
    score,
    score_interpretation: scoreInterpretation,
    score_confidence: answers.one_hour_score?.confidence != null ? Number(answers.one_hour_score.confidence.toFixed(4)) : null,
    score_probabilities: answers.one_hour_score?.probabilities ?? null,
    direction: answers.one_hour_direction?.choice ?? null,
    direction_confidence: answers.one_hour_direction?.confidence != null ? Number(answers.one_hour_direction.confidence.toFixed(4)) : null,
    direction_probabilities: answers.one_hour_direction?.probabilities ?? null,
    prob_up: upProb != null ? Number((upProb * 100).toFixed(1)) : null,
    prob_down: downProb != null ? Number((downProb * 100).toFixed(1)) : null,
    tokens: decision.usage?.input_tokens ?? null,
    cost: decision.usage?.cost ?? null,
    raw_decision: decision,
  };
}

export async function callSpanDecision(snapshotData: any, apiKey?: string) {
  const key = openRouterKey(apiKey);
  const coinLabel = snapshotData.coin_label || snapshotData.coin || 'Crypto';
  const coin = (snapshotData.coin || 'Crypto').toUpperCase();

  const c1h = snapshotData.cards?.['1h'];
  const c15m = snapshotData.cards?.['15m'];
  const c5m = snapshotData.cards?.['5m'];
  const fv = snapshotData.fair_values || {};

  const stateObj = {
    market: 'Crypto Binary Up/Down Outcome',
    asset: `${coinLabel} (${coin})`,
    et_time: snapshotData.et_time,
    spot_price: snapshotData.spot_price != null ? `$${snapshotData.spot_price}` : 'N/A',
    open_price: snapshotData.open_price != null ? `$${snapshotData.open_price}` : 'N/A',
    polymarket_odds: {
      '1h_up': c1h?.up_display || 'N/A',
      '15m_up': c15m?.up_display || 'N/A',
      '5m_up': c5m?.up_display || 'N/A',
    },
    fair_value_model: {
      model_15m: fv.model_15m != null ? (fv.model_15m * 100).toFixed(1) + '%' : 'N/A',
      model_5m: fv.model_5m != null ? (fv.model_5m * 100).toFixed(1) + '%' : 'N/A',
    },
  };

  const payload = {
    model: 'respan/span-01',
    state: JSON.stringify(stateObj, null, 2),
    questions: {
      will_close_up: {
        type: 'noul',
        instructions: `Will ${coinLabel} (${coin}) close above its hour open price (closing UP) at the end of the 1-hour interval?`,
        criteria: {
          true: `${coinLabel} closes above hour open price (UP wins).`,
          false: `${coinLabel} closes equal to or below hour open price.`,
        },
      },
      will_close_down: {
        type: 'noul',
        instructions: `Will ${coinLabel} (${coin}) close below its hour open price (closing DOWN) at the end of the 1-hour interval?`,
        criteria: {
          true: `${coinLabel} closes below hour open price (DOWN wins).`,
          false: `${coinLabel} closes equal to or above hour open price.`,
        },
      },
    },
  };

  const res = await fetchWithRetry('https://openrouter.ai/api/alpha/decisions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenRouter Span error (${res.status}): ${errText}`);
  }

  const decision = await res.json();
  const upNoul = decision.answers?.will_close_up?.noul ?? decision.answers?.one_hour_up?.noul;
  const downNoul = decision.answers?.will_close_down?.noul;

  let probUp: number | null = null;
  let probDown: number | null = null;
  let direction: 'UP' | 'DOWN' | null = null;
  let score: number | null = null;
  let confidence: number | null = null;

  if (upNoul != null && downNoul != null) {
    const total = upNoul + downNoul;
    const rawRatioUp = total > 0 ? upNoul / total : 0.5;
    // Calibrate around empirical baseline (~0.58 raw ratio is neutral)
    const normRatio = Math.max(0.02, Math.min(0.98, 0.5 + (rawRatioUp - 0.58) * 1.5));
    probUp = Number((normRatio * 100).toFixed(1));
    probDown = Number((100 - probUp).toFixed(1));
    direction = probUp >= 50 ? 'UP' : 'DOWN';
    score = Number(((probUp / 100) * 4.0).toFixed(2));
    confidence = Number((Math.max(probUp, probDown) / 100).toFixed(4));
  } else if (upNoul != null) {
    // Single-question fallback (calibrated against 0.085 empirical baseline)
    const baseline = 0.085;
    let ratioUp = 0.5;
    if (upNoul >= baseline) {
      ratioUp = 0.5 + Math.min(0.48, ((upNoul - baseline) / (0.30 - baseline)) * 0.5);
    } else {
      ratioUp = 0.5 - Math.min(0.48, ((baseline - upNoul) / baseline) * 0.5);
    }
    probUp = Number((ratioUp * 100).toFixed(1));
    probDown = Number((100 - probUp).toFixed(1));
    direction = probUp >= 50 ? 'UP' : 'DOWN';
    score = Number((ratioUp * 4.0).toFixed(2));
    confidence = Number((Math.max(probUp, probDown) / 100).toFixed(4));
  }

  let scoreInterpretation = 'نامشخص';
  if (score != null) {
    if (score >= 3.0) scoreInterpretation = 'Strong Up (صعودی قوی) 🚀';
    else if (score >= 2.2) scoreInterpretation = 'Lean Up (تمایل به صعود) ↗';
    else if (score >= 1.8) scoreInterpretation = 'Neutral (خنثی / تعادل) ⚖';
    else if (score >= 1.0) scoreInterpretation = 'Lean Down (تمایل به نزول) ↘';
    else scoreInterpretation = 'Strong Down (نزولی قوی) 🔻';
  }

  return {
    model: decision.model || 'respan/span-01',
    coin: snapshotData.coin,
    score,
    score_interpretation: scoreInterpretation,
    score_confidence: confidence,
    direction,
    direction_confidence: confidence,
    prob_up: probUp,
    prob_down: probDown,
    tokens: decision.usage?.input_tokens ?? null,
    cost: decision.usage?.cost ?? null,
    raw_decision: decision,
  };
}

export async function callMultiModelDecisions(snapshotData: any, apiKey?: string) {
  const enabled = getSetting('jev.models');
  const off = Promise.resolve(null);
  const [jevRes, kevRes, spanRes, solarRes, tevRes, mercuryRes] = await Promise.allSettled([
    enabled.jev ? callJevDecision(snapshotData, apiKey) : off,
    enabled.kev ? callKevDecision(snapshotData, apiKey) : off,
    enabled.span ? callSpanDecision(snapshotData, apiKey) : off,
    enabled.solar ? callSolarDecision(snapshotData, apiKey) : off,
    enabled.tev ? callTevDecision(snapshotData, apiKey) : off,
    enabled.mercury ? callMercuryDecision(snapshotData, apiKey) : off,
  ]);

  const jev = jevRes.status === 'fulfilled' ? jevRes.value : null;
  const kev = kevRes.status === 'fulfilled' ? kevRes.value : null;
  const span = spanRes.status === 'fulfilled' ? spanRes.value : null;
  // Solar is recorded next to the others but is NOT one of the consensus votes: the frozen forward
  // strategies count Jev/Kev/Span only, and changing that would rewrite their history.
  const solar = solarRes.status === 'fulfilled' ? solarRes.value : null;
  if (solarRes.status === 'rejected') {
    console.error('[MultiModel] Solar error:', solarRes.reason?.message || solarRes.reason);
  }
  // Tev and Mercury follow Solar: recorded for analysis, never a consensus vote.
  const tev = tevRes.status === 'fulfilled' ? tevRes.value : null;
  if (tevRes.status === 'rejected') {
    console.error('[MultiModel] Tev error:', tevRes.reason?.message || tevRes.reason);
  }
  const mercury = mercuryRes.status === 'fulfilled' ? mercuryRes.value : null;
  if (mercuryRes.status === 'rejected') {
    console.error('[MultiModel] Mercury error:', mercuryRes.reason?.message || mercuryRes.reason);
  }

  if (jevRes.status === 'rejected') {
    console.error('[MultiModel] Jev error:', jevRes.reason?.message || jevRes.reason);
  }
  if (kevRes.status === 'rejected') {
    console.error('[MultiModel] Kev error:', kevRes.reason?.message || kevRes.reason);
  }
  if (spanRes.status === 'rejected') {
    console.error('[MultiModel] Span error:', spanRes.reason?.message || spanRes.reason);
  }

  const votes = [jev?.direction, kev?.direction, span?.direction].filter(Boolean) as ('UP' | 'DOWN')[];
  const upVotes = votes.filter(v => v === 'UP').length;
  const downVotes = votes.filter(v => v === 'DOWN').length;
  const totalVotes = votes.length;

  let consensusDirection: 'UP' | 'DOWN' | 'SPLIT' | null = null;
  if (upVotes > downVotes) consensusDirection = 'UP';
  else if (downVotes > upVotes) consensusDirection = 'DOWN';
  else if (totalVotes > 0) consensusDirection = 'SPLIT';

  const consensus = {
    direction: consensusDirection,
    up_votes: upVotes,
    down_votes: downVotes,
    total_models: totalVotes,
    summary: totalVotes > 0 ? `${upVotes}/${totalVotes} UP (${downVotes} DOWN)` : null,
    agreement: totalVotes > 0 ? Number(((Math.max(upVotes, downVotes) / totalVotes) * 100).toFixed(0)) : null,
  };

  const primary = jev || kev || span;

  return {
    jev,
    kev,
    span,
    solar,
    tev,
    mercury,
    consensus,
    primary,
  };
}

export function getLatestHistoricalFile(coin?: string): { filename: string; timestamp: number } | null {
  try {
    const historyDir = path.join(process.cwd(), 'jev', 'history');
    if (!fs.existsSync(historyDir)) return null;
    const prefix = coin ? `${coin.toLowerCase()}_` : '';
    const files = fs
      .readdirSync(historyDir)
      .filter(f => f.endsWith('.json') && (!prefix || f.toLowerCase().startsWith(prefix)))
      .sort()
      .reverse();
    if (files.length === 0) return null;
    const latestFile = files[0];
    const stat = fs.statSync(path.join(historyDir, latestFile));
    try {
      const data = JSON.parse(fs.readFileSync(path.join(historyDir, latestFile), 'utf8'));
      if (data.timestamp) {
        const t = new Date(data.timestamp).getTime();
        if (!isNaN(t) && t > 0) {
          return { filename: latestFile, timestamp: t };
        }
      }
    } catch {}
    return { filename: latestFile, timestamp: stat.mtimeMs };
  } catch {
    return null;
  }
}

export function saveHistoricalJevRecord(
  snapshotData: any,
  predictionOrMulti: any,
  force = false,
  extraPredictions?: any
) {
  const coinKey = (snapshotData.coin || 'btc').toLowerCase();
  const safeTime = snapshotData.current_time_et_24h.replace(/:/g, '-');
  const filename = `${coinKey}_updown_${snapshotData.date_et}_${safeTime}_ET.json`;

  let primaryPrediction = predictionOrMulti;
  let predictionsObj: any = null;

  if (predictionOrMulti && (predictionOrMulti.jev !== undefined || predictionOrMulti.predictions !== undefined)) {
    predictionsObj = predictionOrMulti.predictions || {
      jev: predictionOrMulti.jev,
      kev: predictionOrMulti.kev,
      span: predictionOrMulti.span,
      solar: predictionOrMulti.solar,
      tev: predictionOrMulti.tev,
      mercury: predictionOrMulti.mercury,
      consensus: predictionOrMulti.consensus,
    };
    primaryPrediction = predictionOrMulti.primary || predictionOrMulti.jev || primaryPrediction;
  } else if (extraPredictions) {
    predictionsObj = extraPredictions;
  } else if (predictionOrMulti) {
    predictionsObj = { jev: predictionOrMulti };
  }

  const fullRecord = {
    et_time: snapshotData.et_time,
    date_et: snapshotData.date_et,
    current_time_et: snapshotData.current_time_et,
    current_time_et_24h: snapshotData.current_time_et_24h,
    timestamp: snapshotData.timestamp,
    coin: snapshotData.coin,
    coin_label: snapshotData.coin_label || snapshotData.coin,
    spot_price: snapshotData.spot_price != null ? Number(snapshotData.spot_price) : null,
    open_price: snapshotData.open_price != null ? Number(snapshotData.open_price) : null,
    price_to_beat: snapshotData.open_price != null ? Number(snapshotData.open_price) : null,
    cards: snapshotData.cards,
    fair_values: snapshotData.fair_values,
    model_inputs: snapshotData.model_inputs ?? null,
    books: snapshotData.books ?? null,
    prediction: primaryPrediction,
    predictions: predictionsObj,
  };

  const jsonStr = JSON.stringify(fullRecord, null, 2);

  const jevDir = path.join(process.cwd(), 'jev');
  const historyDir = path.join(jevDir, 'history');
  const publicJevDir = path.join(process.cwd(), 'public', 'jev');
  const publicHistoryDir = path.join(publicJevDir, 'history');

  for (const d of [jevDir, historyDir, publicJevDir, publicHistoryDir]) {
    try {
      if (!fs.existsSync(d)) {
        fs.mkdirSync(d, { recursive: true });
      }
    } catch {}
  }

  // DEBOUNCE GUARD: Check if a file was created for this specific coin within the last 4 minutes (240s)
  const latest = getLatestHistoricalFile(coinKey);
  if (!force && latest) {
    const elapsedMs = Date.now() - latest.timestamp;
    if (elapsedMs < 240000) { // 4 minutes
      try {
        fs.writeFileSync(path.join(jevDir, `${coinKey}_updown.json`), jsonStr, 'utf8');
        if (coinKey === 'btc') {
          fs.writeFileSync(path.join(jevDir, 'latest.json'), jsonStr, 'utf8');
        }
      } catch {}
      return { filename: latest.filename, fullRecord, skippedDuplicate: true };
    }
  }

  // 1. Save timestamped file in jev/ and jev/history/ (NEVER OVERWRITTEN - KEPT FOREVER)
  fs.writeFileSync(path.join(historyDir, filename), jsonStr, 'utf8');
  fs.writeFileSync(path.join(jevDir, filename), jsonStr, 'utf8');

  // Also in public for direct HTTP access if desired
  try {
    fs.writeFileSync(path.join(publicHistoryDir, filename), jsonStr, 'utf8');
    fs.writeFileSync(path.join(publicJevDir, filename), jsonStr, 'utf8');
  } catch {}

  // 2. Also update live cache so the latest state has prediction
  fs.writeFileSync(path.join(jevDir, `${coinKey}_updown.json`), jsonStr, 'utf8');
  if (coinKey === 'btc') {
    fs.writeFileSync(path.join(jevDir, 'latest.json'), jsonStr, 'utf8');
  }

  // 3. Check for Blue Tick (Bullish) or Red Tick (Bearish) and send Telegram alert
  try {
    checkAndSendJevSignalAlert(fullRecord, filename).catch(err => {
      console.error('[JEV ALERT] Background alert error:', err);
    });
  } catch (err) {
    console.error('[JEV ALERT] Error invoking alert check:', err);
  }

  return { filename, fullRecord, skippedDuplicate: false };
}
