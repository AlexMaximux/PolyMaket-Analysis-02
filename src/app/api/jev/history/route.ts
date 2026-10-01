import { NextResponse } from 'next/server';
import fs from 'fs';
import { forwardSnapshotRow } from '@/lib/forwardSnapshot';
import path from 'path';
import { updateMarketResolutions, getResolutionsMap } from '@/lib/marketResolver';

export const dynamic = 'force-dynamic';

// In-memory cache for historical JSON files (immutable once written)
const jsonFileCache = new Map<string, any>();

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const requestedFile = searchParams.get('file');

    const historyDir = path.join(process.cwd(), 'jev', 'history');
    if (!fs.existsSync(historyDir)) {
      return NextResponse.json({ files: [], count: 0 });
    }

    if (requestedFile) {
      // Prevent path traversal
      const safeName = path.basename(requestedFile);
      const filePath = path.join(historyDir, safeName);
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, 'utf8');
        return new Response(data, {
          headers: {
            'Content-Type': 'application/json',
            'Content-Disposition': `inline; filename="${safeName}"`,
          },
        });
      }
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    // Trigger automatic market resolution check:
    // If requested with refresh=true, wait for it; otherwise run throttled in background
    if (searchParams.get('refresh') === 'true') {
      try {
        await updateMarketResolutions(false);
      } catch {}
    } else {
      updateMarketResolutions(false).catch(() => {});
    }

    const coinFilter = searchParams.get('coin')?.toLowerCase();
    const resolutionsMap = getResolutionsMap();

    let fileNames = fs.readdirSync(historyDir).filter(f => f.endsWith('.json'));
    if (coinFilter && coinFilter !== 'all') {
      fileNames = fileNames.filter(f => f.toLowerCase().startsWith(coinFilter + '_'));
    }
    // Sort descending by time
    fileNames.sort().reverse();

    const limitParam = searchParams.get('limit');
    if (limitParam) {
      const limit = parseInt(limitParam, 10);
      if (Number.isFinite(limit) && limit > 0) {
        fileNames = fileNames.slice(0, limit);
      }
    }

    const files = fileNames.map(f => {
      try {
        let content = jsonFileCache.get(f);
        if (!content) {
          content = JSON.parse(fs.readFileSync(path.join(historyDir, f), 'utf8'));
          jsonFileCache.set(f, content);
        }
        const preds = content.predictions || {};
        const p = preds.jev || content.prediction || {};
        const pKev = preds.kev || null;
        const pSpan = preds.span || null;
        const pSolar = preds.solar || null;
        const pTev = preds.tev || null;
        const pMercury = preds.mercury || null;
        const pct = (x: unknown) => (x != null ? Number((Number(x) * 100).toFixed(0)) : null);
        const consensus = preds.consensus || null;
        const cards = content.cards || {};
        const fv = content.fair_values || {};
        const detectedCoin = content.coin || (f.toLowerCase().startsWith('btc') ? 'BTC' : f.split('_')[0].toUpperCase());

        return {
          coin: detectedCoin,
          coin_label: content.coin_label || null,
          current_time_et: content.current_time_et || null,
          timestamp: content.timestamp || null,
          score: p.score != null ? Number(p.score) : null,
          score_label: p.score_interpretation || null,
          direction: p.direction || null,
          score_confidence:
            p.score_confidence != null
              ? Number((p.score_confidence * 100).toFixed(0))
              : p.raw_decision?.answers?.one_hour_score?.confidence != null
              ? Number((p.raw_decision.answers.one_hour_score.confidence * 100).toFixed(0))
              : null,
          direction_confidence:
            p.direction_confidence != null
              ? Number((p.direction_confidence * 100).toFixed(0))
              : p.raw_decision?.answers?.one_hour_direction?.confidence != null
              ? Number((p.raw_decision.answers.one_hour_direction.confidence * 100).toFixed(0))
              : null,
          confidence:
            p.score_confidence != null
              ? Number((p.score_confidence * 100).toFixed(0))
              : p.direction_confidence != null
              ? Number((p.direction_confidence * 100).toFixed(0))
              : null,
          prob_up: p.prob_up ?? (p.direction_probabilities?.UP != null ? Number((p.direction_probabilities.UP * 100).toFixed(1)) : null),
          prob_down: p.prob_down ?? (p.direction_probabilities?.DOWN != null ? Number((p.direction_probabilities.DOWN * 100).toFixed(1)) : null),
          
          // Kev-4b predictions
          kev_direction: pKev?.direction ?? null,
          kev_score: pKev?.score != null ? Number(pKev.score) : null,
          kev_score_label: pKev?.score_interpretation ?? null,
          kev_score_confidence:
            pKev?.score_confidence != null
              ? Number((pKev.score_confidence * 100).toFixed(0))
              : pKev?.raw_decision?.answers?.one_hour_score?.confidence != null
              ? Number((pKev.raw_decision.answers.one_hour_score.confidence * 100).toFixed(0))
              : null,
          kev_direction_confidence:
            pKev?.direction_confidence != null
              ? Number((pKev.direction_confidence * 100).toFixed(0))
              : pKev?.raw_decision?.answers?.one_hour_direction?.confidence != null
              ? Number((pKev.raw_decision.answers.one_hour_direction.confidence * 100).toFixed(0))
              : null,
          kev_confidence:
            pKev?.score_confidence != null
              ? Number((pKev.score_confidence * 100).toFixed(0))
              : pKev?.direction_confidence != null
              ? Number((pKev.direction_confidence * 100).toFixed(0))
              : null,
          kev_prob_up: pKev?.prob_up ?? (pKev?.direction_probabilities?.UP != null ? Number((pKev.direction_probabilities.UP * 100).toFixed(1)) : null),

          // Respan / Span-01 predictions
          span_direction: pSpan?.direction ?? null,
          span_score: pSpan?.score != null ? Number(pSpan.score) : null,
          span_score_label: pSpan?.score_interpretation ?? null,
          span_confidence: pSpan?.score_confidence != null ? Number((pSpan.score_confidence * 100).toFixed(0)) : null,
          span_prob_up: pSpan?.prob_up ?? null,
          span_prob_down: pSpan?.prob_down ?? null,

          // Upstage Solar-Decide predictions (extra filter, not part of the consensus)
          solar_direction: pSolar?.direction ?? null,
          solar_score: pSolar?.score != null ? Number(pSolar.score) : null,
          solar_score_label: pSolar?.score_interpretation ?? null,
          solar_score_confidence: pct(pSolar?.score_confidence ?? pSolar?.raw_decision?.answers?.one_hour_score?.confidence),
          solar_direction_confidence: pct(pSolar?.direction_confidence ?? pSolar?.raw_decision?.answers?.one_hour_direction?.confidence),
          solar_confidence: pct(pSolar?.score_confidence ?? pSolar?.direction_confidence),
          solar_prob_up: pSolar?.prob_up ?? null,

          // Together Tev-4b and Inception Mercury-Decide predictions (extras, not part of the consensus)
          tev_direction: pTev?.direction ?? null,
          tev_score: pTev?.score != null ? Number(pTev.score) : null,
          tev_score_label: pTev?.score_interpretation ?? null,
          tev_score_confidence: pct(pTev?.score_confidence ?? pTev?.raw_decision?.answers?.one_hour_score?.confidence),
          tev_direction_confidence: pct(pTev?.direction_confidence ?? pTev?.raw_decision?.answers?.one_hour_direction?.confidence),
          tev_confidence: pct(pTev?.score_confidence ?? pTev?.direction_confidence),
          tev_prob_up: pTev?.prob_up ?? null,

          mercury_direction: pMercury?.direction ?? null,
          mercury_score: pMercury?.score != null ? Number(pMercury.score) : null,
          mercury_score_label: pMercury?.score_interpretation ?? null,
          mercury_score_confidence: pct(pMercury?.score_confidence ?? pMercury?.raw_decision?.answers?.one_hour_score?.confidence),
          mercury_direction_confidence: pct(pMercury?.direction_confidence ?? pMercury?.raw_decision?.answers?.one_hour_direction?.confidence),
          mercury_confidence: pct(pMercury?.score_confidence ?? pMercury?.direction_confidence),
          mercury_prob_up: pMercury?.prob_up ?? null,

          // Consensus
          consensus_direction: consensus?.direction ?? null,
          consensus_summary: consensus?.summary ?? null,
          consensus_agreement: consensus?.agreement ?? null,

          // Multi-model object
          predictions: preds,

          up_1h: cards['1h']?.up_display ?? null,
          down_1h: cards['1h']?.down_display ?? null,
          up_1h_num: cards['1h']?.up != null ? Number((cards['1h'].up * 100).toFixed(1)) : null,
          up_15m: cards['15m']?.up_display ?? null,
          up_15m_num: cards['15m']?.up != null ? Number((cards['15m'].up * 100).toFixed(1)) : null,
          up_5m: cards['5m']?.up_display ?? null,
          up_5m_num: cards['5m']?.up != null ? Number((cards['5m'].up * 100).toFixed(1)) : null,
          fair_15m: fv.model_15m != null ? Number((fv.model_15m * 100).toFixed(2)) : null,
          fair_5m: fv.model_5m != null ? Number((fv.model_5m * 100).toFixed(2)) : null,
          fair_base: fv.base_no_drift != null ? Number((fv.base_no_drift * 100).toFixed(2)) : null,
          fair_joint: fv.joint_solve != null ? Number((fv.joint_solve * 100).toFixed(2)) : null,
          spot_price: content.spot_price != null ? Number(content.spot_price) : null,
          open_price: content.open_price != null ? Number(content.open_price) : null,
          price_to_beat: content.price_to_beat != null ? Number(content.price_to_beat) : (content.open_price != null ? Number(content.open_price) : null),
          market_slug: cards['1h']?.slug || null,
          ...forwardSnapshotRow(f, content),
          market_outcome: (cards['1h']?.slug && resolutionsMap[cards['1h'].slug]) ? resolutionsMap[cards['1h'].slug] : null,
          tokens: p.tokens ?? null,
          cost: p.cost != null ? Number(p.cost.toFixed(6)) : null,
        };
      } catch {
        return null;
      }
    }).filter((f): f is NonNullable<typeof f> => f !== null && typeof (f as any).et_time === 'string');

    return NextResponse.json({ count: files.length, files });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
