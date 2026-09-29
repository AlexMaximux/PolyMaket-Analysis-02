/** Display form of a secret: never more than the last 4 characters, and only for long values. */
export function maskSecret(v: string | null | undefined): string | null {
  if (!v) return null;
  return v.length >= 12 ? `…${v.slice(-4)}` : '…';
}
