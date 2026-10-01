import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import { useCallback, useEffect, useState } from 'react';
import { getRecap, recapDay } from '../analyze/recap.js';
import { analysisNeeded, currentStatus, spawnDetachedRun } from '../analyze/runner.js';
import type { Config } from '../config.js';
import { readLiveSessions, type LiveSession } from '../ingest/live.js';
import { scan } from '../ingest/scanner.js';
import { runInteractive, type LaunchRequest, type LaunchResult } from '../launcher/claude.js';
import type { DB } from '../store/db.js';
import { listProjects, listSessions, type ProjectRow, type SessionRow } from '../store/queries.js';
import { RecapTab } from './RecapTab.js';
import { SessionsTab, type SessionItem } from './SessionsTab.js';

const TABS = [
  { key: '1', name: 'Sessions', hints: '↑↓ move · enter resume · n new · / search · f project · r refresh · q quit' },
  { key: '2', name: 'Recap', hints: '↑↓ move · enter start on it · c continue its session · R rewrite · q quit' },
  { key: '3', name: 'Ideas', soon: 'M3: follow-ups and directions from your conversations, one keypress to run.' },
  { key: '4', name: 'Goals', soon: 'Later: long-running goals checked on a schedule that report back only when something changes.' },
  { key: '5', name: 'Feed', soon: 'Later: news related to what you are working on.' },
  { key: '6', name: 'Connectors', soon: 'Later: GitHub, Linear, Slack and calendar via MCP, enabled when first needed.' },
] as const;

const REFRESH_MS = 5000;
/** Poll faster while a background run is writing, so progress shows up promptly. */
const REFRESH_WHILE_RUNNING_MS = 1500;
const RECAP_TAB = 1;

export interface AppProps {
  db: DB;
  cfg: Config;
  /** Injected so tests can render without touching the real terminal or Claude Code. */
  loadLive?: () => LiveSession[];
  launch?: (req: LaunchRequest) => LaunchResult | Promise<LaunchResult>;
  startAnalysis?: (args: string[]) => void;
}

export function App({
  db,
  cfg,
  loadLive = () => readLiveSessions(cfg.claudeDir),
  launch,
  startAnalysis = (args) => spawnDetachedRun(cfg, args),
}: AppProps) {
  const { exit, suspendTerminal } = useApp();
  const { columns, rows } = useWindowSize();
  // The first time you open the companion each day, it opens on the recap.
  const [tab, setTab] = useState(() => (claimFirstOpenToday(db, cfg) ? RECAP_TAB : 0));
  const [inputLocked, setInputLocked] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [projectFilter, setProjectFilter] = useState<ProjectRow | null>(null);
  const [data, setData] = useState(() => load(db, cfg, loadLive, search, projectFilter));
  const running = data.status?.state === 'running';

  const refresh = useCallback(
    (rescan = true) => {
      if (rescan) scan(db, cfg);
      setData(load(db, cfg, loadLive, search, projectFilter));
    },
    [db, cfg, loadLive, search, projectFilter],
  );

  useEffect(() => refresh(false), [search, projectFilter]);
  useEffect(() => {
    const t = setInterval(() => refresh(), running ? REFRESH_WHILE_RUNNING_MS : REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh, running]);

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
      if (analysisNeeded(db, cfg)) startAnalysis([]);
    },
    [suspendTerminal, launch, refresh, db, cfg, startAnalysis],
  );

  const regenerateRecap = useCallback(() => {
    startAnalysis(['--force-recap']);
    setMessage('Rewriting the recap in the background…');
    setTimeout(() => refresh(false), 300);
  }, [startAnalysis, refresh]);

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
        {tab === RECAP_TAB ? (
          <RecapTab
            db={db}
            recap={data.recap}
            status={data.status}
            onLaunch={onLaunch}
            onRegenerate={regenerateRecap}
            onMessage={setMessage}
            height={bodyHeight}
          />
        ) : 'soon' in current ? (
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
              {inputLocked ? 'enter confirm · esc cancel' : 'hints' in current ? current.hints : '1-6 switch tabs · q quit'}
            </Text>
            {running ? (
              <Text color="cyan">{` ⟳ ${data.status!.step ?? 'working'}${data.status!.total ? ` ${data.status!.done}/${data.status!.total}` : ''}`}</Text>
            ) : (
              <Text color="green">{` ${liveCount} live`}</Text>
            )}
          </>
        )}
      </Box>
    </Box>
  );
}

function claimFirstOpenToday(db: DB, cfg: Config): boolean {
  const { day } = recapDay(cfg);
  const seen = db.prepare(`SELECT value FROM meta WHERE key = 'recap_shown_day'`).get() as { value: string } | undefined;
  if (seen?.value === day) return false;
  db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('recap_shown_day', ?)`).run(day);
  return true;
}

function load(db: DB, cfg: Config, loadLive: () => LiveSession[], search: string, filter: ProjectRow | null) {
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
  return {
    items,
    projects: listProjects(db),
    recap: getRecap(db, recapDay(cfg).day),
    status: currentStatus(db, cfg),
  };
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
