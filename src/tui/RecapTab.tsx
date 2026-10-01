import { existsSync } from 'node:fs';
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import type { RecapRow } from '../analyze/recap.js';
import type { AnalyzerStatus } from '../analyze/runner.js';
import { newSession, resumeSession, type LaunchRequest } from '../launcher/claude.js';
import type { DB } from '../store/db.js';

interface Props {
  db: DB;
  recap: RecapRow | null;
  status: AnalyzerStatus | null;
  onLaunch: (req: LaunchRequest) => void;
  onRegenerate: () => void;
  onMessage: (msg: string) => void;
  height: number;
}

const PRIORITY_COLOR = { high: 'red', medium: 'yellow', low: 'gray' } as const;

export function RecapTab({ db, recap, status, onLaunch, onRegenerate, onMessage, height }: Props) {
  const items = recap?.recap.action_items ?? [];
  const [index, setIndex] = useState(0);
  const selected = items[Math.min(index, items.length - 1)];
  const running = status?.state === 'running';

  useInput((input, key) => {
    if (key.upArrow || input === 'k') setIndex((i) => Math.max(0, i - 1));
    else if (key.downArrow || input === 'j') setIndex((i) => Math.min(items.length - 1, i + 1));
    else if (input === 'R') {
      if (running) onMessage('Already working on it.');
      else onRegenerate();
    } else if ((key.return || input === 'c') && selected) {
      const where = locate(db, selected.session_id, selected.project);
      if (!where) return onMessage(`Can't find the folder for ${selected.project}.`);
      // enter: start fresh on the action item. c: continue the session it came from.
      if (input === 'c') {
        if (!selected.session_id || !where.sessionResumable)
          return onMessage('That session can no longer be resumed; press enter to start a new one.');
        onLaunch(resumeSession(where.cwd, selected.session_id));
      } else {
        onLaunch(newSession(where.cwd, selected.text));
      }
    }
  });

  if (!recap) {
    return (
      <Box flexDirection="column" paddingX={2}>
        <Text bold>Morning recap</Text>
        {running ? (
          <Text color="cyan">
            Preparing your recap… {status.step}
            {status.total ? ` (${status.done}/${status.total})` : ''}
          </Text>
        ) : status?.state === 'error' || status?.state === 'paused' ? (
          <>
            <Text color="red">{status.error}</Text>
            <Text dimColor>Press R to try again.</Text>
          </>
        ) : (
          <Text dimColor>No recap yet: no Claude Code activity in the past week. Press R to check again.</Text>
        )}
      </Box>
    );
  }

  const { recap: r } = recap;
  const covered = new Date(recap.windowStart).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });

  return (
    <Box flexDirection="column" paddingX={2} height={height} overflow="hidden">
      <Text dimColor>
        Covering {covered} · {recap.sessionIds.length} sessions · written{' '}
        {new Date(recap.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
        {running ? ' · updating…' : ''}
      </Text>
      <Text bold wrap="wrap">
        {r.headline}
      </Text>

      <Box marginTop={1} flexDirection="column">
        <Text bold color="cyan">
          Today
        </Text>
        {items.length === 0 && <Text dimColor>Nothing pending.</Text>}
        {items.map((a, i) => (
          <Box key={i} flexDirection="column">
            <Text inverse={i === index} wrap="truncate">
              <Text color={PRIORITY_COLOR[a.priority]}>{` ${a.priority.padEnd(6)} `}</Text>
              {a.text} <Text dimColor>({a.project})</Text>
            </Text>
            {i === index && (
              <Text dimColor wrap="wrap">
                {'         '}
                {a.why}
              </Text>
            )}
          </Box>
        ))}
      </Box>

      {r.blockers.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text bold color="red">
            Blocked
          </Text>
          {r.blockers.map((b, i) => (
            <Text key={i} wrap="wrap">
              {' '}• {b}
            </Text>
          ))}
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text bold color="cyan">
          By project
        </Text>
        {r.projects.map((p) => (
          <Text key={p.project} wrap="wrap">
            <Text color="magenta">{p.project}</Text> {p.summary}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

/** Where to run an action item: its source session's folder, else the project's. */
function locate(db: DB, sessionId: string, project: string): { cwd: string; sessionResumable: boolean } | null {
  const s = sessionId
    ? (db.prepare(`SELECT cwd, transcript_gone FROM sessions WHERE id = ?`).get(sessionId) as
        | { cwd: string | null; transcript_gone: number }
        | undefined)
    : undefined;
  if (s?.cwd && existsSync(s.cwd)) return { cwd: s.cwd, sessionResumable: !s.transcript_gone };
  const p = db.prepare(`SELECT cwd FROM projects WHERE name = ? ORDER BY id DESC LIMIT 1`).get(project) as
    | { cwd: string }
    | undefined;
  return p && existsSync(p.cwd) ? { cwd: p.cwd, sessionResumable: false } : null;
}
