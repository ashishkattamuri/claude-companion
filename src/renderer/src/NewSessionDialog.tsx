import { useEffect, useRef, useState } from 'react';
import type { ProjectRow } from '../../shared/api';
import { api } from './api';
import { shortPath } from './format';

interface Props {
  initialCwd?: string;
  onStart: (cwd: string, prompt: string) => void;
  onCancel: () => void;
}

export function NewSessionDialog({ initialCwd, onStart, onCancel }: Props) {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [cwd, setCwd] = useState(initialCwd ?? '');
  const [prompt, setPrompt] = useState('');
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
  const submit = () => cwd && onStart(cwd, prompt);

  return (
    <div className="overlay" onMouseDown={onCancel}>
      <form
        className="dialog"
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
        <h2>New Claude session</h2>
        <label className="field">
          <span>Folder</span>
          <div className="row gap">
            <select className="input grow" value={cwd} onChange={(e) => setCwd(e.target.value)}>
              {options.map((p) => (
                <option key={p.cwd} value={p.cwd}>
                  {p.name} · {shortPath(p.cwd)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn ghost"
              onClick={async () => {
                const picked = await api.pickFolder();
                if (picked) setCwd(picked);
              }}
            >
              Choose…
            </button>
          </div>
        </label>
        <label className="field">
          <span>First prompt (optional)</span>
          <textarea
            ref={promptRef}
            className="input"
            rows={5}
            value={prompt}
            placeholder="What should Claude work on?"
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>
        <div className="row gap end">
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!cwd}>
            Start <span className="kbd">⌘↵</span>
          </button>
        </div>
      </form>
    </div>
  );
}
