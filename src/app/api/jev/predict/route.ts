import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { generateJevSnapshot, callMultiModelDecisions, saveHistoricalJevRecord } from '@/lib/jevSnapshot';
import { isJevCoin } from '@/lib/coins';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  return handlePredict(req);
}

export async function GET(req: Request) {
  return handlePredict(req);
}

async function handlePredict(req: Request) {
  try {
    // POST = manual refresh (forces a paid model call); GET only serves cache or refreshes a stale one.
    // The API key always comes from server settings, never from the request.
    const force = req.method === 'POST';
    const { searchParams } = new URL(req.url);
    let coin = (searchParams.get('coin') || 'btc').toLowerCase();
    if (req.method === 'POST') {
      const body = await req.json().catch(() => null);
      if (body && typeof body.coin === 'string') coin = body.coin.toLowerCase();
    }
    if (!isJevCoin(coin)) {
      return NextResponse.json({ error: `unknown coin: ${coin}` }, { status: 400 });
    }

    const coinPath = path.join(process.cwd(), 'jev', `${coin}_updown.json`);
    const latestPath = path.join(process.cwd(), 'jev', 'latest.json');
    let existingData: any = null;

    if (fs.existsSync(coinPath)) {
      try {
        existingData = JSON.parse(fs.readFileSync(coinPath, 'utf8'));
      } catch {}
    } else if (coin === 'btc' && fs.existsSync(latestPath)) {
      try {
        existingData = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
      } catch {}
    }

    // Check if we have a fresh prediction (< 5 minutes / 300,000 ms) and not forced
    if (!force && existingData && existingData.prediction && existingData.timestamp) {
      const ageMs = Date.now() - new Date(existingData.timestamp).getTime();
      const MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes
      if (ageMs >= 0 && ageMs < MAX_AGE_MS) {
        return NextResponse.json({
          success: true,
          cached: true,
          coin: coin.toUpperCase(),
          age_seconds: Math.round(ageMs / 1000),
          next_refresh_seconds: Math.max(0, Math.round((MAX_AGE_MS - ageMs) / 1000)),
          timestamp: existingData.timestamp,
          state: {
            et_time: existingData.et_time,
            coin: existingData.coin,
            coin_label: existingData.coin_label,
            cards: existingData.cards,
            fair_values: existingData.fair_values,
          },
          decision: existingData.prediction.raw_decision,
          prediction: existingData.prediction,
          fullRecord: existingData,
        });
      }
    }

    // Otherwise, generate fresh snapshot and query multi-models (Jev, Kev-4b, Span-01) automatically
    const data = await generateJevSnapshot(coin);
    const multiPredictions = await callMultiModelDecisions(data);
    const { filename, fullRecord } = saveHistoricalJevRecord(data, multiPredictions, force);

    return NextResponse.json({
      success: true,
      cached: false,
      coin: coin.toUpperCase(),
      filename,
      age_seconds: 0,
      next_refresh_seconds: 300,
      timestamp: fullRecord.timestamp || new Date().toISOString(),
      state: {
        et_time: data.et_time,
        coin: data.coin,
        coin_label: data.coin_label,
        cards: data.cards,
        fair_values: data.fair_values,
      },
      decision: multiPredictions.primary?.raw_decision,
      prediction: multiPredictions.primary,
      predictions: multiPredictions,
      fullRecord,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Internal server error while calling Jev' },
      { status: 500 }
    );
  }
}
