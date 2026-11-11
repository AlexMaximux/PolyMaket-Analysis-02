export const TFM_MODELS = {
  'timesfm-3.0': 'google/timesfm-3.0-pytorch',
  'timesfm-2.5': 'google/timesfm-2.5-200m-pytorch',
} as const;

export type TfmModelKey = keyof typeof TFM_MODELS;

export const DEFAULT_TFM_MODEL: TfmModelKey = 'timesfm-3.0';

/** Accepts a key or a Hugging Face id, returns the model key or null if unknown. */
export function tfmModelKeyOf(idOrKey: string | null | undefined): TfmModelKey | null {
  if (!idOrKey || typeof idOrKey !== 'string') return null;
  const trimmed = idOrKey.trim();
  if (trimmed in TFM_MODELS) return trimmed as TfmModelKey;
  for (const [key, id] of Object.entries(TFM_MODELS)) {
    if (id === trimmed) return key as TfmModelKey;
  }
  return null;
}

/** process.env.TFM_MODEL (key or id), else DEFAULT_TFM_MODEL; unknown value -> default. */
export function activeTfmModelKey(): TfmModelKey {
  const envVal = process.env.TFM_MODEL;
  const key = tfmModelKeyOf(envVal);
  return key ?? DEFAULT_TFM_MODEL;
}
