import type { SessionListItem } from '../../shared/api.js';

/** What an earlier session hands a new one: its title and summary, ahead of the new prompt. */
export function withContext(prompt: string, ctx: Pick<SessionListItem, 'id' | 'title' | 'summary' | 'lastPrompt'> | null): string {
  if (!ctx) return prompt;
  const about = ctx.summary?.trim() || (ctx.lastPrompt ? `Its last request was: ${ctx.lastPrompt.trim()}` : '');
  const block = [`Context from an earlier session, "${ctx.title}" (${ctx.id}):`, about].filter(Boolean).join('\n');
  return prompt.trim() ? `${block}\n\n${prompt}` : block;
}
