import { useEffect, useRef, useState } from 'react';
import type { NewSessionRequest, ProjectRow } from '../../shared/api';
import { api } from './api';
import { shortPath } from './format';

interface Props {
  initial?: { cwd?: string; prompt?: string };
  onStart: (req: NewSessionRequest) => void;
  onCancel: () => void;
}

export function NewSessionSheet({ initial, onStart, onCancel }: Props) {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [cwd, setCwd] = useState(initial?.cwd ?? '');
  const [prompt, setPrompt] = useState(initial?.prompt ?? '');
  const [permissionMode, setPermissionMode] = useState<NewSessionRequest['permissionMode']>('default');
  const [worktree, setWorktree] = useState(false);
  const [model, setModel] = useState('');
  const promptRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void api.listProjects().then((ps) => {
      setProjects(ps);
      setCwd((c) => c || ps[0]?.cwd || '');
    });
    promptRef.current?.focus();
  }, []);

  // A folder picked from disk that isn't a known project still needs to show in the list.
  const options = cwd && !projects.some((p) => p.cwd === cwd) ? [{ cwd, name: cwd.split('/').pop() ?? cwd }, ...projects] : projects;
  const submit = () => cwd && onStart({ cwd, prompt, permissionMode, worktree, model: model || undefined });

  return (
    <div className="sheet-bg" onMouseDown={onCancel}>
      <form
        className="sheet"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
          if (e.key === 'Enter' && e.metaKey) submit();
        }}
      >
        <h2>New session</h2>
        <label className="field" htmlFor="ns-project">
          Project
          <div className="row gap">
            <select id="ns-project" className="grow" value={cwd} onChange={(e) => setCwd(e.target.value)}>
              {options.map((p) => (
                <option key={p.cwd} value={p.cwd}>
                  {p.name} · {shortPath(p.cwd)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn quiet"
              onClick={async () => {
                const picked = await api.pickFolder();
                if (picked) setCwd(picked);
              }}
            >
              Choose…
            </button>
          </div>
        </label>
        <div className="row3">
          <label className="field" htmlFor="ns-model">
            Model
            <select id="ns-model" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">Your default</option>
              <option value="opus">Opus</option>
              <option value="sonnet">Sonnet</option>
              <option value="haiku">Haiku</option>
            </select>
          </label>
          <label className="field" htmlFor="ns-worktree">
            Work on
            <select id="ns-worktree" value={worktree ? 'worktree' : 'current'} onChange={(e) => setWorktree(e.target.value === 'worktree')}>
              <option value="current">Current checkout</option>
              <option value="worktree">New git worktree</option>
            </select>
          </label>
          <label className="field" htmlFor="ns-mode">
            Permissions
            <select id="ns-mode" value={permissionMode} onChange={(e) => setPermissionMode(e.target.value as NewSessionRequest['permissionMode'])}>
              <option value="default">Ask before edits</option>
              <option value="acceptEdits">Auto-accept edits</option>
              <option value="plan">Plan first</option>
            </select>
          </label>
        </div>
        <label className="field" htmlFor="ns-prompt">
          What should Claude work on? (optional)
          <textarea id="ns-prompt" ref={promptRef} rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </label>
        <div className="sheet-actions">
          <button type="button" className="btn quiet" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!cwd}>
            Start session <span className="kbd">⌘↵</span>
          </button>
        </div>
      </form>
    </div>
  );
}
