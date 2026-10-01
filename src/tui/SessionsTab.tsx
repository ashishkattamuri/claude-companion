import { existsSync } from 'node:fs';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useEffect, useMemo, useState } from 'react';
import type { LiveSession } from '../ingest/live.js';
import { newSession, resumeSession, type LaunchRequest } from '../launcher/claude.js';
import type { ProjectRow, SessionRow } from '../store/queries.js';
import { shortPath, timeAgo, truncate } from './format.js';

export interface SessionItem extends SessionRow {
  live: LiveSession | null;
}

type Mode =
  | { kind: 'list' }
  | { kind: 'search'; draft: string }
  | { kind: 'pick-project'; purpose: 'filter' | 'new' }
  | { kind: 'new-prompt'; cwd: string; draft: string };

interface Props {
  items: SessionItem[];
  projects: ProjectRow[];
  search: string;
  projectFilter: ProjectRow | null;
  onSearch: (q: string) => void;
  onFilter: (p: ProjectRow | null) => void;
  onLaunch: (req: LaunchRequest) => void;
  onMessage: (msg: string) => void;
  onInputLock: (locked: boolean) => void;
  height: number;
  width: number;
}

export function SessionsTab(props: Props) {
  const { items, height, width } = props;
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const [index, setIndex] = useState(0);
  const [offset, setOffset] = useState(0);

  const typing = mode.kind === 'search' || mode.kind === 'new-prompt';
  useEffect(() => props.onInputLock(mode.kind !== 'list'), [mode.kind]);

  const listHeight = Math.max(3, height - 2);
  const selected = items[Math.min(index, items.length - 1)];

  // Keep the selection on screen and inside the list when the list changes.
  useEffect(() => {
    const i = Math.min(index, Math.max(0, items.length - 1));
    if (i !== index) setIndex(i);
    if (i < offset) setOffset(i);
    else if (i >= offset + listHeight) setOffset(i - listHeight + 1);
  }, [index, items.length, listHeight]);

  const move = (delta: number) => setIndex((i) => Math.max(0, Math.min(items.length - 1, i + delta)));

  useInput(
    (input, key) => {
      if (key.upArrow || input === 'k') move(-1);
      else if (key.downArrow || input === 'j') move(1);
      else if (key.pageUp) move(-listHeight);
      else if (key.pageDown) move(listHeight);
      else if (input === 'g') setIndex(0);
      else if (input === 'G') setIndex(items.length - 1);
      else if (key.return && selected) resume(selected);
      else if (input === '/') setMode({ kind: 'search', draft: props.search });
      else if (input === 'f') setMode({ kind: 'pick-project', purpose: 'filter' });
      else if (input === 'n') setMode({ kind: 'pick-project', purpose: 'new' });
      else if (key.escape) {
        props.onSearch('');
        props.onFilter(null);
      }
    },
    { isActive: mode.kind === 'list' },
  );

  useInput((_, key) => key.escape && setMode({ kind: 'list' }), { isActive: typing });

  function resume(s: SessionItem) {
    if (s.live) return props.onMessage(`Already running in another terminal (pid ${s.live.pid}).`);
    if (s.transcriptGone) return props.onMessage('Claude Code deleted this transcript, so it can no longer be resumed.');
    if (!s.cwd || !existsSync(s.cwd)) return props.onMessage(`Project folder not found: ${s.cwd ?? 'unknown'}`);
    props.onLaunch(resumeSession(s.cwd, s.id));
  }

  if (mode.kind === 'pick-project') {
    return (
      <ProjectPicker
        projects={props.projects}
        purpose={mode.purpose}
        height={height}
        onCancel={() => setMode({ kind: 'list' })}
        onPick={(p) => {
          if (mode.purpose === 'filter') {
            props.onFilter(p);
            setIndex(0);
            setMode({ kind: 'list' });
          } else {
            setMode({ kind: 'new-prompt', cwd: p?.cwd ?? process.cwd(), draft: '' });
          }
        }}
      />
    );
  }

  if (mode.kind === 'new-prompt') {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text>
          New session in <Text color="cyan">{shortPath(mode.cwd)}</Text>
        </Text>
        <Text dimColor>First prompt (optional). Enter to start, Esc to cancel.</Text>
        <Box marginTop={1}>
          <Text color="green">› </Text>
          <TextInput
            value={mode.draft}
            onChange={(draft) => setMode({ ...mode, draft })}
            onSubmit={(prompt) => {
              setMode({ kind: 'list' });
              if (!existsSync(mode.cwd)) return props.onMessage(`Folder not found: ${mode.cwd}`);
              props.onLaunch(newSession(mode.cwd, prompt));
            }}
          />
        </Box>
      </Box>
    );
  }

  const listWidth = Math.max(40, Math.floor(width * 0.6));
  const visible = items.slice(offset, offset + listHeight);
  const titleWidth = Math.max(10, listWidth - 34);

  return (
    <Box flexDirection="column">
      <Box paddingX={1} height={1}>
        {mode.kind === 'search' ? (
          <>
            <Text color="yellow">search: </Text>
            <TextInput
              value={mode.draft}
              onChange={(draft) => setMode({ kind: 'search', draft })}
              onSubmit={(q) => {
                props.onSearch(q);
                setIndex(0);
                setMode({ kind: 'list' });
              }}
            />
          </>
        ) : (
          <Text dimColor>
            {items.length} sessions
            {props.projectFilter ? ` in ${props.projectFilter.name}` : ''}
            {props.search ? ` matching "${props.search}"` : ''}
            {props.search || props.projectFilter ? '  (esc to clear)' : ''}
          </Text>
        )}
      </Box>
      <Box>
        <Box flexDirection="column" width={listWidth} height={listHeight} paddingX={1}>
          {items.length === 0 && <Text dimColor>No sessions. Press n to start one.</Text>}
          {visible.map((s, i) => {
            const isSel = offset + i === index;
            const marker = s.live ? (s.live.status === 'busy' ? '●' : '○') : ' ';
            return (
              <Box key={s.id}>
                <Text color={s.live?.status === 'busy' ? 'green' : 'cyan'}>{marker} </Text>
                <Box width={titleWidth}>
                  <Text inverse={isSel} dimColor={s.transcriptGone && !isSel} wrap="truncate">
                    {truncate(s.title, titleWidth)}
                  </Text>
                </Box>
                <Box width={20} marginLeft={1}>
                  <Text color="magenta" wrap="truncate">
                    {truncate(s.project ?? '?', 20)}
                  </Text>
                </Box>
                <Box width={5} justifyContent="flex-end">
                  <Text dimColor>{s.live ? 'live' : timeAgo(s.lastTs)}</Text>
                </Box>
              </Box>
            );
          })}
        </Box>
        <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor="gray" paddingX={1} height={listHeight}>
          {selected ? <Preview s={selected} width={width - listWidth - 4} /> : <Text dimColor>Nothing selected</Text>}
        </Box>
      </Box>
    </Box>
  );
}

function Preview({ s, width }: { s: SessionItem; width: number }) {
  const w = Math.max(10, width);
  return (
    <>
      <Text bold wrap="wrap">
        {s.title}
      </Text>
      <Text dimColor>{truncate(shortPath(s.cwd ?? ''), w)}</Text>
      {s.gitBranch && <Text color="yellow">⎇ {s.gitBranch}</Text>}
      <Box marginTop={1} flexDirection="column">
        {s.live && (
          <Text color="green">
            {s.live.status === 'busy' ? '● working' : '○ idle'} in pid {s.live.pid}
          </Text>
        )}
        <Text>
          {s.prompts} prompts · {s.messages} messages
          {s.costUsd != null ? ` · $${s.costUsd.toFixed(2)}` : ''}
        </Text>
        {s.lastTs && <Text dimColor>last active {new Date(s.lastTs).toLocaleString()}</Text>}
        {s.transcriptGone && <Text color="yellow">Transcript deleted by Claude Code; kept here as history.</Text>}
      </Box>
      {s.lastPrompt && (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>last prompt</Text>
          <Text wrap="wrap">{truncate(s.lastPrompt, w * 6)}</Text>
        </Box>
      )}
    </>
  );
}

function ProjectPicker(props: {
  projects: ProjectRow[];
  purpose: 'filter' | 'new';
  height: number;
  onPick: (p: ProjectRow | null) => void;
  onCancel: () => void;
}) {
  const here = process.cwd();
  // `null` means "all projects" when filtering and "current directory" when starting a session.
  const options = useMemo<(ProjectRow | null)[]>(
    () => [null, ...props.projects.filter((p) => props.purpose === 'filter' || (p.cwd !== here && existsSync(p.cwd)))],
    [props.projects, props.purpose],
  );
  const [index, setIndex] = useState(0);
  const visibleCount = Math.max(3, props.height - 2);
  const offset = Math.max(0, index - visibleCount + 1);

  useInput((input, key) => {
    if (key.upArrow || input === 'k') setIndex((i) => Math.max(0, i - 1));
    else if (key.downArrow || input === 'j') setIndex((i) => Math.min(options.length - 1, i + 1));
    else if (key.return) props.onPick(options[index] ?? null);
    else if (key.escape) props.onCancel();
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>{props.purpose === 'filter' ? 'Filter by project' : 'Start a new session in…'}</Text>
      {options.slice(offset, offset + visibleCount).map((p, i) => {
        const label = p
          ? `${p.name}  ${shortPath(p.cwd)}`
          : props.purpose === 'filter'
            ? 'All projects'
            : `Current directory  ${shortPath(here)}`;
        return (
          <Text key={p?.id ?? 'none'} inverse={offset + i === index}>
            {label}
          </Text>
        );
      })}
    </Box>
  );
}
