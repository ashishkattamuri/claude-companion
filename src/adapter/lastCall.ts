/**
 * A chat's context size and prompt cache as of its last model call, from the end of its transcript:
 * enough for a chat Companion hasn't opened, without parsing the whole file.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { ConversationParser, type CacheFacts } from './conversation.js';

const TAIL_BYTES = 512 * 1024;

export function lastCall(path: string): { tokens: number; cache: CacheFacts | null } | null {
  let text: string;
  try {
    const fd = openSync(path, 'r');
    try {
      const size = fstatSync(fd).size;
      const len = Math.min(size, TAIL_BYTES);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
      // Starting mid-file: the first line is cut off.
      if (len < size) text = text.slice(text.indexOf('\n') + 1);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  const p = new ConversationParser();
  p.push(text.split('\n').filter(Boolean));
  return p.facts.contextTokens ? { tokens: p.facts.contextTokens, cache: p.facts.cache } : null;
}
