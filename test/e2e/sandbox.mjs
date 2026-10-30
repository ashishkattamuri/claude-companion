// A throwaway world for the live tests: its own project folder for Claude to work in, a fresh
// Companion database that sees only that folder, and `cleanup()`, which stops every session the run
// started and deletes everything it made, so nothing is left in ~/.claude or in your Companion.
//
// With CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) or ANTHROPIC_API_KEY set, Claude Code
// also gets its own config folder (CLAUDE_CONFIG_DIR), so its transcripts and background sessions
// never mix with yours. Without one, it runs on your own login (your subscription): transcripts go
// to ~/.claude/projects under the sandbox's folder name, and only those are stopped and deleted.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Claude Code's folder name for a project: the path with every non-alphanumeric turned into "-". */
const encode = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

export function liveSandbox(name) {
  const ownConfig = !!(process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY);
  // On your own login the project folder goes under ~/workspace, which Claude Code already trusts,
  // so sessions don't stop at the folder-trust question. realpath: macOS's tmpdir is a symlink, and
  // Claude Code records the resolved folder.
  const parent = ownConfig ? tmpdir() : join(homedir(), 'workspace');
  const root = realpathSync(mkdtempSync(join(parent, ownConfig ? `companion-${name}-` : `.companion-live-${name}-`)));
  const claudeDir = ownConfig ? join(root, 'claude') : join(homedir(), '.claude');
  const project = join(root, 'project');
  const data = join(root, 'data');
  for (const d of [claudeDir, project, data]) mkdirSync(d, { recursive: true });

  // Skip first-run onboarding and the folder-trust question for the project folder.
  if (ownConfig) {
    writeFileSync(
      join(claudeDir, '.claude.json'),
      JSON.stringify({ hasCompletedOnboarding: true, projects: { [project]: { hasTrustDialogAccepted: true } } }),
    );
  }
  // One finished chat in the project, so the new-session sheet lists the folder.
  const seed = randomUUID();
  mkdirSync(join(claudeDir, 'projects', encode(project)), { recursive: true });
  writeFileSync(
    join(claudeDir, 'projects', encode(project), `${seed}.jsonl`),
    `${JSON.stringify({ type: 'user', sessionId: seed, cwd: project, uuid: randomUUID(), parentUuid: null, isSidechain: false, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Sandbox seed chat' } })}\n`,
  );

  // On your own login Companion would see all your chats; it is told to look only at the sandbox's.
  const config = join(root, 'config.toml');
  const optOut = ownConfig ? '' : `opt_out = ["/**", "!${project}"]\n`;
  writeFileSync(config, `[sources]\nclaude_dir = "${claudeDir}"\n${optOut}[data]\ndir = "${data}"\n`);

  /** For claude itself (terminals, `claude stop`): no Claude Code markers from the shell running the test. */
  const claudeEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ELECTRON_RUN_AS_NODE)/.test(k))),
    ...(process.env.CLAUDE_CODE_OAUTH_TOKEN ? { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN } : {}),
    // On your own login, sandbox sessions mustn't write to your auto-memory either.
    ...(ownConfig ? { CLAUDE_CONFIG_DIR: claudeDir } : { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }),
  };
  /** For the Companion app under test. */
  const appEnv = { ...claudeEnv, COMPANION_CONFIG: config, COMPANION_DB: join(data, 'db.sqlite'), COMPANION_USER_DATA: join(root, 'user-data'), COMPANION_NO_ANALYSIS: '1' };

  const realProjects = join(homedir(), '.claude', 'projects');
  /** The sandbox's transcript folders in ~/.claude/projects (its project, and any worktrees in it); its folder name is unique. */
  const ours = () => (existsSync(realProjects) ? readdirSync(realProjects) : []).filter((d) => d.startsWith(encode(root)));

  /** Stops every background session in the sandbox and deletes it. Returns anything that leaked into ~/.claude. */
  function cleanup() {
    try {
      for (const a of JSON.parse(execFileSync('claude', ['agents', '--json'], { env: claudeEnv, encoding: 'utf8', timeout: 15000 }))) {
        // On your own login, only the sandbox's sessions: never yours.
        if (a.kind !== 'background' || (!ownConfig && !String(a.cwd ?? '').startsWith(root))) continue;
        try { execFileSync('claude', ['stop', a.id], { env: claudeEnv, stdio: 'ignore', timeout: 15000 }); } catch {}
      }
    } catch {}
    rmSync(root, { recursive: true, force: true });
    // A session that was just stopped or killed can still write its last records several seconds
    // later: keep sweeping until nothing has reappeared for 5 seconds (at most 30).
    for (let quiet = 0, i = 0; !ownConfig && quiet < 5 && i < 30; i++) {
      const found = ours();
      for (const d of found) rmSync(join(realProjects, d), { recursive: true, force: true });
      quiet = found.length ? 0 : quiet + 1;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
    const leaked = ours();
    if (leaked.length) console.error(`Sessions leaked into ~/.claude/projects: ${leaked.join(', ')}`);
    return leaked;
  }

  return { root, claudeDir, project, appEnv, claudeEnv, cleanup, transcriptDirs: () => readdirSync(join(claudeDir, 'projects')).filter((d) => d.startsWith(encode(root))).map((d) => join(claudeDir, 'projects', d)) };
}
