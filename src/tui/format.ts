import { homedir } from 'node:os';

export function timeAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return '';
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  return `${Math.floor(s / (86400 * 30))}mo`;
}

export function truncate(s: string, width: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  if (width <= 1) return flat.slice(0, Math.max(0, width));
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
}

export function shortPath(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}
