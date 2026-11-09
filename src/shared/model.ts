/** "claude-haiku-5-5" → "Haiku 5.5", "claude-sonnet-4-5-20250929" → "Sonnet 4.5"; anything else as is. */
export function shortModel(model: string | null): string {
  if (!model) return 'Model';
  const m = model.match(/claude-(opus|sonnet|haiku|fable|mythos)-([\d-]+)/);
  if (!m) return model;
  return `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]!.replace(/-\d{8}$/, '').replace('-', '.')}`;
}
