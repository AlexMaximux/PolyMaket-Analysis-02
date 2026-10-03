// ET timestamps as the snapshots write them: "2026-09-26 14:43:16 ET" (or the file-name form with _ and -).
export function parseEtTime(et: string): { date: string; hour: number; minute: number } | null {
  const m = et?.match(/^(\d{4}-\d{2}-\d{2})[ _T](\d{2})[:-](\d{2})/);
  if (!m) return null;
  return { date: m[1], hour: parseInt(m[2], 10), minute: parseInt(m[3], 10) };
}
