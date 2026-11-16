import type { ReviewView, TestRun, Verification } from '../../shared/api';
import { timeAgo } from './format';
import { clip } from './ReviewPanel';

const VERIFY: Record<Verification['state'], { label: string; tone: string; title: string }> = {
  passed: { label: 'Tested after edit', tone: 'green', title: 'A test or check passed after the last edit. What it covered is not recorded.' },
  failed: { label: 'Failing', tone: 'red', title: 'The latest test or check after the last edit failed.' },
  unknown: { label: 'Outcome unknown', tone: 'amber', title: 'A test or check ran after the last edit, but its outcome could not be read.' },
  stale: { label: 'Edited after tests', tone: 'amber', title: 'Tests ran, but only before the last edit, so they say nothing about it.' },
  none: { label: 'Not verified', tone: 'muted', title: 'No test or check ran in this session.' },
};

/** Where a file's test evidence stands, as recorded: never more than what ran and how it came out. */
export function VerifyChip({ v, compact }: { v: Verification; compact?: boolean }) {
  const s = VERIFY[v.state];
  return (
    <span className={`vchip ${s.tone} ${compact ? 'compact' : ''}`} title={s.title}>
      {s.label}
    </span>
  );
}

/** The strongest claim a set of files supports: one unverified file makes the set unverified. */
export function combined(vs: Verification[]): Verification['state'] {
  const order: Verification['state'][] = ['failed', 'none', 'stale', 'unknown', 'passed'];
  return order.find((s) => vs.some((v) => v.state === s)) ?? 'none';
}

export function verifyLabel(state: Verification['state']) {
  return VERIFY[state];
}

const OUTCOME: Record<TestRun['outcome'], string> = { passed: 'Passed', failed: 'Failed', unknown: 'Outcome unknown' };

/**
 * What was verified, from the transcript: every test and check Claude ran with its outcome, which
 * files were edited after it (so its evidence is stale for them), and the files nothing verified.
 */
export function ReviewVerifyPane({ view, onJump, onShowFile }: { view: ReviewView; onJump: (id: string) => void; onShowFile: (path: string) => void }) {
  const { files, tests, failures } = view;
  const unverified = files.filter((f) => f.verification.state !== 'passed');
  const editedAfter = (t: TestRun) => files.filter((f) => (f.lastSeq ?? -1) > t.seq);
  return (
    <div className="review-pane verify">
      <p className="verify-lede muted">
        What ran and how it came out, from the session's transcript. Companion doesn't know what each run covered, and never counts a summary or an
        acknowledgement as a test.
      </p>

      <section className="vsec" aria-labelledby="v-files">
        <h3 id="v-files">Files</h3>
        <table className="vtable">
          <thead>
            <tr>
              <th>File</th>
              <th>Last edited</th>
              <th>Evidence</th>
              <th>Latest run after the edit</th>
            </tr>
          </thead>
          <tbody>
            {files.map((f) => {
              const v = f.verification;
              return (
                <tr key={f.hash}>
                  <td>
                    <button className="link mono" onClick={() => onShowFile(f.path)}>
                      {f.path}
                    </button>
                  </td>
                  <td className="muted small">{f.stepTs.at(-1) ? timeAgo(f.stepTs.at(-1)!) : 'unknown'}</td>
                  <td>
                    <VerifyChip v={v} />
                  </td>
                  <td className="small">
                    {v.state === 'none' ? (
                      <span className="muted">No test or check ran</span>
                    ) : v.state === 'stale' ? (
                      <span className="muted">Only before the edit: {clip(v.run.command, 60)}</span>
                    ) : (
                      <button className="link mono" onClick={() => onJump(v.run.stepId)} title={v.run.command}>
                        {clip(v.run.command, 60)}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {unverified.length > 0 && (
          <p className="vnote">
            <b>Not verified:</b> {unverified.length === files.length ? 'none of the changes' : `${unverified.length} of ${files.length} files`} have a passing test or check
            after their last edit.
          </p>
        )}
      </section>

      <section className="vsec" aria-labelledby="v-runs">
        <h3 id="v-runs">Tests and checks that ran</h3>
        {tests.length === 0 ? (
          <p className="muted">None. Claude didn't run a test or check in this session.</p>
        ) : (
          <ol className="vruns">
            {tests.map((t) => {
              const after = editedAfter(t);
              return (
                <li key={t.stepId} className={t.outcome}>
                  <span className={`vchip ${t.outcome === 'passed' ? 'green' : t.outcome === 'failed' ? 'red' : 'amber'}`}>{OUTCOME[t.outcome]}</span>
                  <span className="vrun-main">
                    <code className="vrun-cmd" title={t.command}>
                      {clip(t.command, 140)}
                    </code>
                    <span className="muted small">
                      {t.kind === 'check' ? 'Check' : 'Test'} · {timeAgo(t.ts)}
                      {t.summary ? ` · ${t.summary}` : ''}
                      {t.kind === 'test' ? (t.scope ? ` · ran ${t.scope.join(', ')}` : ' · scope as configured, not recorded') : ''}
                    </span>
                    {after.length > 0 && (
                      <span className="vstale small">
                        Edited since: {after.map((f) => f.path).slice(0, 4).join(', ')}
                        {after.length > 4 ? ` and ${after.length - 4} more` : ''}
                      </span>
                    )}
                  </span>
                  <button className="link" onClick={() => onJump(t.stepId)}>
                    Show in chat
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {failures.length > 0 && (
        <section className="vsec" aria-labelledby="v-fails">
          <h3 id="v-fails">Failed or denied steps</h3>
          <ul className="vfails">
            {failures.slice(-12).map((f) => (
              <li key={f.stepId}>
                <span className={`vchip ${f.denied ? 'amber' : 'red'}`}>{f.denied ? 'Denied' : 'Error'}</span>
                <span className="vrun-main">
                  <span className="mono small">
                    {f.tool} {clip(f.target, 100)}
                  </span>
                  <span className="muted small">{clip(f.text.replace(/\s+/g, ' '), 180)}</span>
                </span>
                <button className="link" onClick={() => onJump(f.stepId)}>
                  Show in chat
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
