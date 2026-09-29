const WALLET_RE = /^0x[a-f0-9]{40}$/;

/** Lowercased wallet address, or null when the input is not a 0x + 40 hex address. */
export function parseWallet(raw: string): string | null {
  const w = String(raw || '').trim().toLowerCase();
  return WALLET_RE.test(w) ? w : null;
}

/** True for 64 hex characters, with or without a 0x prefix (an ECDSA private key, format-only check). */
export function isPrivateKeyFormat(s: string): boolean {
  const hex = s.startsWith('0x') ? s.slice(2) : s;
  return /^[0-9a-fA-F]{64}$/.test(hex);
}

/** Always store private keys 0x-prefixed so downstream code (viem) never has to guess. */
export function normalizePrivateKey(s: string): string {
  return s.startsWith('0x') ? s : `0x${s}`;
}

export function isEthAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

export function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
