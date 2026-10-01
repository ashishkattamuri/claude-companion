import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import { useCallback, useEffect, useState } from 'react';
import type { Config } from '../config.js';
import { readLiveSessions, type LiveSession } from '../ingest/live.js';
import { scan } from '../ingest/scanner.js';
import { runInteractive, type LaunchRequest, type LaunchResult } from '../launcher/claude.js';
import type { DB } from '../store/db.js';
import { listProjects, listSessions, type ProjectRow, type SessionRow } from '../store/queries.js';
import { SessionsTab, type SessionItem } from './SessionsTab.js';

const TABS = [
  { key: '1', name: 'Sessions' },
  { key: '2', name: 'Recap', soon: 'M2: what you did yesterday and action items for today.' },
  { key: '3', name: 'Ideas', soon: 'M3: follow-ups and directions from your conversations, one keypress to run.' },
  { key: '4', name: 'Goals', soon: 'Later: long-running goals checked on a schedule that report back only when something changes.' },
  { key: '5', name: 'Feed', soon: 'Later: news related to what you are working on.' },
  { key: '6', name: 'Connectors', soon: 'Later: GitHub, Linear, Slack and calendar via MCP, enabled when first needed.' },
] as const;

const REFRESH_MS = 5000;

export interface AppProps {
  db: DB;
  cfg: Config;
  /** Injected so tests can render without touching the real terminal or Claude Code. */
  loadLive?: () => LiveSession[];
  launch?: (req: LaunchRequest) => LaunchResult | Promise<LaunchResult>;
}

export function App({ db, cfg, loadLive = () => readLiveSessions(cfg.claudeDir), launch }: AppProps) {
  const { exit, suspendTerminal } = useApp();
  const { columns, rows } = useWindowSize();
  const [tab, setTab] = useState(0);
  const [inputLocked, setInputLocked] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [projectFilter, setProjectFilter] = useState<ProjectRow | null>(null);
  const [data, setData] = useState(() => load(db, loadLive, search, projectFilter));

  const refresh = useCallback(
    (rescan = true) => {
      if (rescan) scan(db, cfg);
      setData(load(db, loadLive, search, projectFilter));
    },
    [db, cfg, loadLive, search, projectFilter],
  );

  useEffect(() => refresh(false), [search, projectFilter]);
  useEffect(() => {
    const t = setInterval(() => refresh(), REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  // Messages fade after a while so stale errors don't linger.
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), 6000);
    return () => clearTimeout(t);
  }, [message]);

  const onLaunch = useCallback(
    async (req: LaunchRequest) => {
      let result: LaunchResult = { code: null };
      await suspendTerminal(async () => {
        result = await (launch ?? runInteractive)(req);
      });
      setMessage(result.error ? `Could not start claude: ${result.error}` : 'Back from claude.');
      refresh();
    },
    [suspendTerminal, launch, refresh],
  );

  useInput(
    (input) => {
      if (input === 'q') exit();
      else if (input === 'r') {
        refresh();
        setMessage('Refreshed.');
      } else {
        const i = TABS.findIndex((t) => t.key === input);
        if (i >= 0) setTab(i);
      }
    },
    { isActive: !inputLocked },
  );

  const bodyHeight = Math.max(5, rows - 4);
  const current = TABS[tab]!;
  const liveCount = data.items.filter((s) => s.live).length;

  return (
    <Box flexDirection="column" height={rows}>
      <Box paddingX={1} gap={2}>
        <Text bold color="cyan">
          companion
        </Text>
        {TABS.map((t, i) => (
          <Text key={t.key} inverse={i === tab} dimColor={i !== tab && 'soon' in t}>
            {` ${t.key} ${t.name} `}
          </Text>
        ))}
      </Box>
      <Box height={bodyHeight} marginTop={1}>
        {'soon' in current ? (
          <Box paddingX={2} flexDirection="column">
            <Text bold>{current.name}</Text>
            <Text dimColor>Coming in {current.soon}</Text>
          </Box>
        ) : (
          <SessionsTab
            items={data.items}
            projects={data.projects}
            search={search}
            projectFilter={projectFilter}
            onSearch={setSearch}
            onFilter={setProjectFilter}
            onLaunch={onLaunch}
            onMessage={setMessage}
            onInputLock={setInputLocked}
            height={bodyHeight}
            width={columns}
          />
        )}
      </Box>
      <Box paddingX={1} justifyContent="space-between" height={1}>
        {message ? (
          <Text color="yellow" wrap="truncate">
            {message}
          </Text>
        ) : (
          <>
            <Text dimColor wrap="truncate">
              {inputLocked
                ? 'enter confirm · esc cancel'
                : '↑↓ move · enter resume · n new · / search · f project · r refresh · q quit'}
            </Text>
            <Text color="green">{` ${liveCount} live`}</Text>
          </>
        )}
      </Box>
    </Box>
  );
}

function load(db: DB, loadLive: () => LiveSession[], search: string, filter: ProjectRow | null) {
  const live = new Map(loadLive().map((l) => [l.sessionId, l]));
  const rows = listSessions(db, { search, projectId: filter?.id });
  const items: SessionItem[] = rows.map((r) => ({ ...r, live: live.get(r.id) ?? null }));

  // A session that just started may be live before its transcript has any messages.
  if (!search) {
    const known = new Set(rows.map((r) => r.id));
    for (const l of live.values()) {
      if (known.has(l.sessionId) || (filter && filter.cwd !== l.cwd)) continue;
      items.push(liveOnly(l));
    }
  }
  items.sort((a, b) => Number(!!b.live) - Number(!!a.live) || (b.lastTs ?? '').localeCompare(a.lastTs ?? ''));
  return { items, projects: listProjects(db) };
}

function liveOnly(l: LiveSession): SessionItem {
  const row: SessionRow = {
    id: l.sessionId,
    cwd: l.cwd,
    project: l.cwd.split('/').pop() ?? null,
    projectId: null,
    gitBranch: null,
    title: l.name ?? '(new session)',
    lastPrompt: null,
    firstTs: null,
    lastTs: null,
    prompts: 0,
    messages: 0,
    costUsd: null,
    transcriptGone: false,
  };
  return { ...row, live: l };
}
