/**
 * Which Jev dataset the analysis pages show: the original records (default) or the CL copies (?set=cl on the
 * page URL): the same snapshots, asked again with the Claude fair value added. Reads the URL when called,
 * so use it in fetch code and handlers, not while rendering.
 */
export function historyIsCl(): boolean {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('set') === 'cl';
}

/** Adds set=cl to a /api/jev/history URL when the CL dataset is selected. */
export function withHistorySet(url: string): string {
  return historyIsCl() ? `${url}${url.includes('?') ? '&' : '?'}set=cl` : url;
}
