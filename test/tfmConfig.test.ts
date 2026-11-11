import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  TFM_MODELS,
  DEFAULT_TFM_MODEL,
  tfmModelKeyOf,
  activeTfmModelKey,
} from '@/lib/tfm/config';

describe('tfmConfig', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  describe('tfmModelKeyOf', () => {
    it('resolves huggingface id and model keys', () => {
      expect(tfmModelKeyOf('google/timesfm-3.0-pytorch')).toBe('timesfm-3.0');
      expect(tfmModelKeyOf('timesfm-3.0')).toBe('timesfm-3.0');
      expect(tfmModelKeyOf('google/timesfm-2.5-200m-pytorch')).toBe('timesfm-2.5');
      expect(tfmModelKeyOf('timesfm-2.5')).toBe('timesfm-2.5');
      expect(tfmModelKeyOf('x')).toBeNull();
      expect(tfmModelKeyOf(null)).toBeNull();
      expect(tfmModelKeyOf(undefined)).toBeNull();
    });
  });

  describe('activeTfmModelKey', () => {
    it('returns default timesfm-3.0 without TFM_MODEL', () => {
      vi.stubEnv('TFM_MODEL', '');
      delete process.env.TFM_MODEL;
      expect(activeTfmModelKey()).toBe('timesfm-3.0');
      expect(DEFAULT_TFM_MODEL).toBe('timesfm-3.0');
      expect(TFM_MODELS['timesfm-3.0']).toBe('google/timesfm-3.0-pytorch');
      expect(TFM_MODELS['timesfm-2.5']).toBe('google/timesfm-2.5-200m-pytorch');
    });

    it('returns timesfm-2.5 when TFM_MODEL is set to id or key', () => {
      vi.stubEnv('TFM_MODEL', 'google/timesfm-2.5-200m-pytorch');
      expect(activeTfmModelKey()).toBe('timesfm-2.5');

      vi.stubEnv('TFM_MODEL', 'timesfm-2.5');
      expect(activeTfmModelKey()).toBe('timesfm-2.5');
    });

    it('returns default timesfm-3.0 when TFM_MODEL is garbage', () => {
      vi.stubEnv('TFM_MODEL', 'garbage');
      expect(activeTfmModelKey()).toBe('timesfm-3.0');
    });
  });
});
