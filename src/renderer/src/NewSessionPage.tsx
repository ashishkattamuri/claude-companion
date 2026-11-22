import { useEffect, useMemo, useRef, useState } from 'react';
import type { NewSessionRequest, ProjectRow, SessionListItem } from '../../shared/api';
import { api } from './api';
import { shortPath, timeAgo } from './format';
import { withContext } from './newSession';

interface Props {
  initial?: { cwd?: string; prompt?: string };
  /** Recent sessions, used for the project's branch and for "Bring session context". */
  sessions: SessionListItem[];
  onStart: (req: NewSessionRequest) => void;
  onCancel: () => void;
}

const MODES: Record<NonNullable<NewSessionRequest['permissionMode']>, string> = {
  default: 'Ask before edits',
  acceptEdits: 'Auto-accept edits',
  plan: 'Plan first',
};
const MODELS: Record<string, string> = { '': 'Your default model', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };
/** The project list's last entry, which opens a folder picker instead of selecting. */
const CHOOSE = '__choose_folder__';
const SETTINGS_KEY = 'companion.newSession.settingsOpen';

function readSettingsOpen(): boolean {
  try {
    return localStorage.getItem(SETTINGS_KEY) !== '0';
  } catch {
    return true;
  }
}

export function NewSessionPage({ initial, sessions, onStart, onCancel }: Props) {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [cwd, setCwd] = useState(initial?.cwd ?? '');
  const [prompt, setPrompt] = useState(initial?.prompt ?? '');
  const [permissionMode, setPermissionMode] = useState<NonNullable<NewSessionRequest['permissionMode']>>('default');
  const [worktree, setWorktree] = useState(false);
  const [model, setModel] = useState('');
  const [contextId, setContextId] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(readSettingsOpen);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void api.listProjects().then((ps) => {
      setProjects(ps);
      setCwd((c) => c || ps[0]?.cwd || '');
    });
    promptRef.current?.focus();
  }, []);

  // Context belongs to a project: switching projects drops it.
  useEffect(() => {
    setContextId(null);
    setPicking(false);
  }, [cwd]);

  // A folder picked from disk that isn't a known project still needs to show in the list.
  const options = cwd && !projects.some((p) => p.cwd === cwd) ? [{ cwd, name: cwd.split('/').pop() ?? cwd }, ...projects] : projects;
  const inProject = useMemo(() => sessions.filter((s) => s.cwd === cwd).slice(0, 8), [sessions, cwd]);
  const branch = inProject.find((s) => s.gitBranch)?.gitBranch ?? null;
  const context = inProject.find((s) => s.id === contextId) ?? null;

  const submit = () => {
    if (!cwd || (!prompt.trim() && !context)) return;
    const text = withContext(prompt, context);
    onStart({ cwd, prompt: text, permissionMode, worktree, model: model || undefined });
  };
  const submitRef = useRef(submit);
  submitRef.current = submit;

  // Shortcuts work wherever focus is on the page, even after the focused control goes away.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (picking) setPicking(false);
        else onCancel();
      } else if (e.key === 'Enter' && e.metaKey) {
        e.preventDefault();
        submitRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [picking, onCancel]);

  const canSend = !!cwd && (!!prompt.trim() || !!context);

  return (
    <div className="page ns-page">
      <div className="ns-drag" />

      <div className="ns-body">
        <h1 className="ns-title">New session</h1>

        <div className="ns-project">
          <label htmlFor="ns-project" className="ns-label">
            Project
          </label>
          <select
            id="ns-project"
            className="ns-pill"
            value={cwd}
            title={shortPath(cwd)}
            onChange={async (e) => {
              if (e.target.value !== CHOOSE) return setCwd(e.target.value);
              const picked = await api.pickFolder();
              if (picked) setCwd(picked);
            }}
          >
            {options.map((p) => (
              <option key={p.cwd} value={p.cwd}>
                {p.name}
              </option>
            ))}
            <option disabled>──────────</option>
            <option value={CHOOSE}>Choose folder…</option>
          </select>
          {branch && (
            <span className="ns-branch mono" title="Git branch of the latest session here">
              <BranchIcon /> {branch}
            </span>
          )}
        </div>

        <form
          className="ns-composer"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <textarea
            id="ns-prompt"
            ref={promptRef}
            rows={4}
            aria-label="What should Claude work on?"
            placeholder="What should Claude work on?"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              // Like the chat composer: Enter sends, Shift+Enter adds a line.
              if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
          />
          {context && (
            <div className="ns-context">
              <span className="ns-context-tag">Context</span>
              <span className="ns-context-title">{context.title}</span>
              <button type="button" className="ns-context-x" aria-label="Remove context" onClick={() => setContextId(null)}>
                ×
              </button>
            </div>
          )}
          <div className="ns-composer-foot">
            <div className="ns-context-picker">
              {inProject.length > 0 && (
                <button type="button" className="btn quiet ns-bring" aria-expanded={picking} onClick={() => setPicking((p) => !p)}>
                  + Bring session context…
                </button>
              )}
              {picking && (
                <ul className="ns-menu" role="listbox" aria-label="Earlier sessions in this project">
                  {inProject.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={s.id === contextId}
                        onClick={() => {
                          setContextId(s.id);
                          setPicking(false);
                          promptRef.current?.focus();
                        }}
                      >
                        <span className="ns-menu-title">{s.title}</span>
                        <span className="ns-menu-meta">
                          {s.gitBranch && <span className="mono">{s.gitBranch}</span>}
                          {s.lastTs && <span>{timeAgo(s.lastTs)}</span>}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <button type="submit" className="send ns-go" disabled={!canSend}>
              Send ↵
            </button>
          </div>
        </form>

        <details
          className="ns-settings"
          open={settingsOpen}
          onToggle={(e) => {
            const open = (e.target as HTMLDetailsElement).open;
            setSettingsOpen(open);
            try {
              localStorage.setItem(SETTINGS_KEY, open ? '1' : '0');
            } catch {
              /* per-viewer convenience only */
            }
          }}
        >
          <summary>
            <span className="ns-settings-name">Session settings</span>
            <span className="ns-settings-sum">
              {worktree ? 'New git worktree' : 'Current checkout'} · {MODES[permissionMode]} · {MODELS[model]}
            </span>
          </summary>
          <div className="row3 ns-settings-grid">
            <label className="field" htmlFor="ns-worktree">
              Work on
              <select id="ns-worktree" value={worktree ? 'worktree' : 'current'} onChange={(e) => setWorktree(e.target.value === 'worktree')}>
                <option value="current">Current checkout</option>
                <option value="worktree">New git worktree</option>
              </select>
            </label>
            <label className="field" htmlFor="ns-mode">
              Permissions
              <select id="ns-mode" value={permissionMode} onChange={(e) => setPermissionMode(e.target.value as typeof permissionMode)}>
                {Object.entries(MODES).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label className="field" htmlFor="ns-model">
              Model
              <select id="ns-model" value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="">Your default</option>
                <option value="opus">Opus</option>
                <option value="sonnet">Sonnet</option>
                <option value="haiku">Haiku</option>
              </select>
            </label>
          </div>
        </details>

        {cwd && (
          <p className="ns-folder">
            Working folder · <span className="mono">{shortPath(cwd)}</span>
            {worktree && <span> (in a new git worktree)</span>}
          </p>
        )}
      </div>
    </div>
  );
}

function BranchIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm0 2.122a2.25 2.25 0 1 0-1.5 0v5.256a2.25 2.25 0 1 0 1.5 0V9.25c0-.69.56-1.25 1.25-1.25h3.5a2.75 2.75 0 0 0 2.73-2.42 2.25 2.25 0 1 0-1.52-.03A1.25 1.25 0 0 1 9.75 6.5h-3.5c-.45 0-.87.1-1.25.27V5.372ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm7.5-9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"
      />
    </svg>
  );
}
