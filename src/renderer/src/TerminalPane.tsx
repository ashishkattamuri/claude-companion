import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';
import type { TermInfo } from '../../shared/api';
import { api } from './api';
import { shortPath } from './format';

const THEME = {
  background: '#0f1115',
  foreground: '#e6e8ee',
  cursor: '#7c9cff',
  selectionBackground: '#7c9cff55',
  black: '#1b1e25',
  brightBlack: '#5c6370',
};

/**
 * One xterm per open session. Panes stay mounted while hidden so scrollback survives tab switches.
 * On mount it replays what the process already printed, then follows live output; stream offsets
 * from the main process let the two join without gaps or repeats.
 */
export function TerminalPane({ term, active, onClose }: { term: TermInfo; active: boolean; onClose: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const xterm = useRef<{ xt: Terminal; fit: FitAddon } | null>(null);

  useEffect(() => {
    const xt = new Terminal({
      fontFamily: '"SF Mono", Menlo, Monaco, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      macOptionIsMeta: true,
      scrollback: 5000,
      theme: THEME,
    });
    const fit = new FitAddon();
    xt.loadAddon(fit);
    xt.open(host.current!);
    xterm.current = { xt, fit };

    let shownUpTo = 0;
    let replayed = false;
    const early: [string, number][] = [];
    const write = (data: string, end: number) => {
      if (end <= shownUpTo) return;
      const start = end - data.length;
      xt.write(start < shownUpTo ? data.slice(shownUpTo - start) : data);
      shownUpTo = end;
    };
    const offData = api.onTerminalData((id, data, end) => {
      if (id !== term.id) return;
      if (replayed) write(data, end);
      else early.push([data, end]);
    });
    void api.replayTerminal(term.id).then((r) => {
      xt.write(r.data);
      shownUpTo = r.end;
      replayed = true;
      for (const [d, e] of early) write(d, e);
    });

    xt.onData((d) => api.writeTerminal(term.id, d));
    xt.onResize(({ cols, rows }) => api.resizeTerminal(term.id, cols, rows));
    const ro = new ResizeObserver(() => {
      if (host.current?.offsetParent) fit.fit();
    });
    ro.observe(host.current!);

    return () => {
      offData();
      ro.disconnect();
      xt.dispose();
      xterm.current = null;
    };
  }, [term.id]);

  useEffect(() => {
    if (!active || !xterm.current) return;
    xterm.current.fit.fit();
    api.resizeTerminal(term.id, xterm.current.xt.cols, xterm.current.xt.rows);
    xterm.current.xt.focus();
  }, [active, term.id]);

  return (
    <div className="term-view" style={{ display: active ? 'flex' : 'none' }}>
      <header className="term-header">
        <div>
          <div className="term-title">{term.title}</div>
          <div className="muted mono small">{shortPath(term.cwd)}</div>
        </div>
        <div className="row gap">
          {term.exited && <span className="chip">exited{term.exitCode ? ` (${term.exitCode})` : ''}</span>}
          <button className="btn ghost" onClick={onClose} title="Close tab (⌘W)">
            {term.exited ? 'Close' : 'End session'}
          </button>
        </div>
      </header>
      <div className="term-host" ref={host} />
    </div>
  );
}
