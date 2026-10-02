import xtermHeadless from '@xterm/headless';
import type { ScreenPrompt } from '../shared/api.js';

const { Terminal } = xtermHeadless;

/**
 * A terminal emulator with no display, fed the same bytes as the visible terminal. Claude Code
 * draws with cursor movement, so reading its dialogs needs the rendered screen, not the raw stream.
 */
export class Screen {
  private term: InstanceType<typeof Terminal>;

  constructor(cols: number, rows: number) {
    this.term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });
  }

  write(data: string): void {
    this.term.write(data);
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
  }

  lines(): string[] {
    const buf = this.term.buffer.active;
    const out: string[] = [];
    for (let i = 0; i < this.term.rows; i++) out.push(buf.getLine(buf.viewportY + i)?.translateToString(true) ?? '');
    return out;
  }

  dispose(): void {
    this.term.dispose();
  }
}

const OPTION = /^\s*(❯)?\s*(\d+)\.\s+(.+?)\s*$/;

/**
 * Recognises the dialogs Claude Code shows at the bottom of the screen, so the UI can offer the
 * same choices. Answers are sent back as the keys a person would press.
 */
export function detectPrompt(lines: string[]): ScreenPrompt | null {
  const text = lines.join('\n');

  if (/trust this folder/i.test(text) && /No, exit/.test(text)) {
    const yesSelected = lines.some((l) => /❯\s*Yes, I trust this folder/.test(l));
    return { kind: 'trust', question: 'Do you trust the files in this folder?', options: [], yesSelected };
  }

  // Numbered menus: tool permissions, plan approval, questions Claude asks.
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (OPTION.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  if (end === -1) return null;
  let start = end;
  while (start > 0 && OPTION.test(lines[start - 1]!)) start--;
  const options = lines.slice(start, end + 1).map((l) => {
    const m = l.match(OPTION)!;
    return { key: m[2]!, label: m[3]!, selected: !!m[1] };
  });
  if (options.length < 2 || options[0]!.key !== '1') return null;

  // The question is the nearest non-empty line above the options.
  let q = start - 1;
  while (q >= 0 && !lines[q]!.trim()) q--;
  const question = q >= 0 ? lines[q]!.trim() : '';
  const header = findHeader(lines, q);
  const kind = /proceed\?/i.test(question) ? 'permission' : 'choice';
  return { kind, question, options, header };
}

/** The dialog title Claude Code draws above a permission prompt, e.g. "Bash command". */
function findHeader(lines: string[], from: number): string | null {
  for (let i = from - 1; i >= Math.max(0, from - 14); i--) {
    const l = lines[i]!.trim();
    if (/^(Bash command|Edit file|Create file|Write file|Read file|Fetch|Web search|Tool use|Use skill|.* tool)$/i.test(l)) return l;
    if (/^─{10,}/.test(l)) break;
  }
  return null;
}
