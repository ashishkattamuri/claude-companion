/** "5m ago", or with `compact` the sidebar form: "5m", "3h", "Mon", "Sep 7". */
export function timeAgo(iso: string | null, now = Date.now(), compact = false): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  const s = Math.max(0, (now - t) / 1000);
  if (compact) {
    if (s < 60) return 'now';
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    if (s < 86400 * 6) return new Date(t).toLocaleDateString(undefined, { weekday: 'short' });
    return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return `${Math.floor(s / (86400 * 30))}mo ago`;
}

export const shortPath = (p: string | null) => (p ?? '').replace(/^\/Users\/[^/]+/, '~');

export function greeting(now = new Date()): string {
  const h = now.getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}
