import type { SnapshotRow } from './signalAnalysis';
// Shared normalization for the analysis page's API and the execution worker.
type Prediction = { score?: number; direction?: 'UP' | 'DOWN'; score_confidence?: number; direction_confidence?: number; raw_decision?: { answers?: { one_hour_score?: { confidence?: number } } } };
export interface ForwardSnapshot {
  coin?: string; et_time?: string; timestamp?: string;
  prediction?: Prediction;
  predictions?: { jev?: Prediction; kev?: Prediction; span?: Prediction; solar?: Prediction };
  cards?: { '1h'?: { up?: number; slug?: string } };
}
export function forwardSnapshotRow(filename: string, content: ForwardSnapshot): SnapshotRow {
  const p = content.predictions?.jev || content.prediction || {};
  const kev = content.predictions?.kev, span = content.predictions?.span;
  const confidence = p.score_confidence ?? p.raw_decision?.answers?.one_hour_score?.confidence;
  return {
    filename, coin: content.coin || filename.split('_')[0].toUpperCase(),
    et_time: content.et_time || filename, timestamp: content.timestamp || null,
    score: p.score != null ? Number(p.score) : null, direction: p.direction || null,
    score_confidence: confidence != null ? Number((confidence * 100).toFixed(0)) : null,
    kev_direction: kev?.direction ?? null, span_direction: span?.direction ?? null, solar_direction: content.predictions?.solar?.direction ?? null,
    up_1h_num: content.cards?.['1h']?.up != null ? Number((content.cards['1h'].up * 100).toFixed(1)) : null,
    market_slug: content.cards?.['1h']?.slug || null,
  };
}
