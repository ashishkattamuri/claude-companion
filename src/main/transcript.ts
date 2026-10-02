import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readCompleteLines } from '../ingest/scanner.js';

/** Finds `<sessionId>.jsonl` under any project folder. Cheap: one readdir per project. */
export function findTranscript(projectsDir: string, sessionId: string): string | null {
  if (!existsSync(projectsDir)) return null;
  for (const dir of readdirSync(projectsDir)) {
    const path = join(projectsDir, dir, `${sessionId}.jsonl`);
    if (existsSync(path)) return path;
  }
  return null;
}

/**
 * Follows a transcript as Claude Code appends to it. Claude Code writes one line per finished
 * content block, so polling a few times a second keeps the view within a step of the terminal.
 * The file may not exist yet for a session that is just starting.
 */
export class TranscriptTail {
  private path: string | null = null;
  private offset = 0;

  constructor(
    private projectsDir: string,
    private sessionId: string,
  ) {}

  /** Switch to another session id (Claude Code can mint a new one on resume). */
  follow(sessionId: string): void {
    if (sessionId === this.sessionId) return;
    this.sessionId = sessionId;
    this.path = null;
    this.offset = 0;
  }

  /** New complete lines since the last call. */
  poll(): string[] {
    this.path ??= findTranscript(this.projectsDir, this.sessionId);
    if (!this.path) return [];
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return [];
    }
    if (size < this.offset) this.offset = 0; // rewritten
    if (size === this.offset) return [];
    const { lines, consumed } = readCompleteLines(this.path, this.offset, size);
    this.offset += consumed;
    return lines;
  }
}
