export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export const card = 'bg-white/[0.04] border border-[rgba(190,190,200,0.12)] rounded-2xl';
export const btn =
  'inline-flex items-center gap-1.5 bg-white/[0.06] hover:bg-white/[0.10] border border-[rgba(190,190,200,0.15)] text-[#e8e8e4] rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-35 disabled:cursor-not-allowed';
export const input =
  'w-full bg-white/[0.06] text-[#e8e8e4] border border-[rgba(190,190,200,0.15)] rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-[#9fb4ee] placeholder:text-[#73757c]';
