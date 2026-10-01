export function timeAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return '';
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
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
