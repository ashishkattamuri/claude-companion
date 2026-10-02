import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';
import { api } from './api';

const THEME = {
  background: '#0b0e13',
  foreground: '#d9dee7',
  cursor: '#8ba7ff',
  selectionBackground: '#8ba7ff44',
  black: '#1b1f27',
  brightBlack: '#5c6575',
};

/**
 * The session's real terminal. It replays what claude already printed, then follows live output;
 * stream offsets from the main process let the two join without gaps or repeats.
 */
export function TerminalView({ sessionId, interactive, visible }: { sessionId: string; interactive: boolean; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<{ xt: Terminal; fit: FitAddon } | null>(null);
  const [hasOutput, setHasOutput] = useState(true);

  useEffect(() => {
    const xt = new Terminal({
      fontFamily: '"IBM Plex Mono", "SF Mono", Menlo, monospace',
      fontSize: 12.5,
      lineHeight: 1.2,
      cursorBlink: true,
      macOptionIsMeta: true,
      scrollback: 5000,
      theme: THEME,
    });
    const fit = new FitAddon();
    xt.loadAddon(fit);
    xt.open(host.current!);
    term.current = { xt, fit };

    // Subscribe first and hold live chunks until the replay is written, then skip what it covered.
    let shownUpTo = 0;
    let replayed = false;
    const early: [string, number][] = [];
    const write = (data: string, end: number) => {
      if (end <= shownUpTo) return;
      const start = end - data.length;
      xt.write(start < shownUpTo ? data.slice(shownUpTo - start) : data);
      shownUpTo = end;
    };
    const off = api.onTerminalData((id, data, end) => {
      if (id !== sessionId) return;
      if (replayed) write(data, end);
      else early.push([data, end]);
    });
    void api.replayTerminal(sessionId).then((r) => {
      if (r) {
        xt.write(r.data);
        shownUpTo = r.end;
      }
      replayed = true;
      setHasOutput(!!r);
      for (const [d, e] of early) write(d, e);
    });
    const input = xt.onData((d) => api.writeTerminal(sessionId, d));
    const resize = xt.onResize(({ cols, rows }) => api.resizeTerminal(sessionId, cols, rows));
    const ro = new ResizeObserver(() => {
      if (host.current?.offsetParent) fit.fit();
    });
    ro.observe(host.current!);
    return () => {
      off();
      input.dispose();
      resize.dispose();
      ro.disconnect();
      xt.dispose();
      term.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!visible || !term.current) return;
    term.current.fit.fit();
    api.resizeTerminal(sessionId, term.current.xt.cols, term.current.xt.rows);
    if (interactive) term.current.xt.focus();
  }, [visible, interactive, sessionId]);

  return (
    <div className="term-pane">
      <div className="term-head">
        <span>claude · {sessionId.slice(0, 8)}</span>
        {interactive ? <span className="live">same session, live</span> : <span>not running here</span>}
      </div>
      <div className="term-host" ref={host} />
      {!hasOutput && !interactive && (
        <div className="term-empty">The terminal appears here while the session runs in Companion. Send a message to continue it.</div>
      )}
    </div>
  );
}
