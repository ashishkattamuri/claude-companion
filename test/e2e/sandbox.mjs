// A throwaway world for the live tests: its own Claude Code config folder (CLAUDE_CONFIG_DIR), so
// its transcripts, background sessions and settings never mix with yours; its own project folder
// for Claude to work in; and a fresh Companion database. `cleanup()` stops every session the run
// started and deletes the lot, so nothing it made is left in ~/.claude or in your Companion.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Claude Code's folder name for a project: the path with every non-alphanumeric turned into "-". */
const encode = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

export function liveSandbox(name) {
  // An empty config folder isn't logged in, so the run signs in with a token instead.
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
    console.error(
      'The live tests run Claude Code in a separate config folder, which has no login.\n' +
        'Create a token once with `claude setup-token`, then run with CLAUDE_CODE_OAUTH_TOKEN=<token> (or set ANTHROPIC_API_KEY).',
    );
    process.exit(2);
  }
  // realpath: macOS's tmpdir is a symlink, and Claude Code records the resolved folder.
  const root = realpathSync(mkdtempSync(join(tmpdir(), `companion-${name}-`)));
  const claudeDir = join(root, 'claude');
  const project = join(root, 'project');
  const data = join(root, 'data');
  for (const d of [claudeDir, project, data]) mkdirSync(d, { recursive: true });

  // Skip first-run onboarding and the folder-trust question for the project folder.
  writeFileSync(
    join(claudeDir, '.claude.json'),
    JSON.stringify({ hasCompletedOnboarding: true, projects: { [project]: { hasTrustDialogAccepted: true } } }),
  );
  // One finished chat in the project, so the new-session sheet lists the folder.
  const seed = randomUUID();
  mkdirSync(join(claudeDir, 'projects', encode(project)), { recursive: true });
  writeFileSync(
    join(claudeDir, 'projects', encode(project), `${seed}.jsonl`),
    `${JSON.stringify({ type: 'user', sessionId: seed, cwd: project, uuid: randomUUID(), parentUuid: null, isSidechain: false, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Sandbox seed chat' } })}\n`,
  );

  const config = join(root, 'config.toml');
  writeFileSync(config, `[sources]\nclaude_dir = "${claudeDir}"\n[data]\ndir = "${data}"\n`);

  /** For claude itself (terminals, `claude stop`): no Claude Code markers from the shell running the test. */
  const claudeEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ELECTRON_RUN_AS_NODE)/.test(k))),
    ...(process.env.CLAUDE_CODE_OAUTH_TOKEN ? { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN } : {}),
    CLAUDE_CONFIG_DIR: claudeDir,
  };
  /** For the Companion app under test. */
  const appEnv = { ...claudeEnv, COMPANION_CONFIG: config, COMPANION_DB: join(data, 'db.sqlite'), COMPANION_USER_DATA: join(root, 'user-data'), COMPANION_NO_ANALYSIS: '1' };

  const realProjects = join(homedir(), '.claude', 'projects');
  const realBefore = new Set(existsSync(realProjects) ? readdirSync(realProjects) : []);

  /** Stops every background session in the sandbox and deletes it. Returns anything that leaked into ~/.claude. */
  function cleanup() {
    try {
      for (const a of JSON.parse(execFileSync('claude', ['agents', '--json'], { env: claudeEnv, encoding: 'utf8', timeout: 15000 })))
        if (a.kind === 'background') try { execFileSync('claude', ['stop', a.id], { env: claudeEnv, stdio: 'ignore', timeout: 15000 }); } catch {}
    } catch {}
    rmSync(root, { recursive: true, force: true });
    const leaked = (existsSync(realProjects) ? readdirSync(realProjects) : []).filter((d) => !realBefore.has(d) && d.startsWith(encode(root)));
    if (leaked.length) console.error(`Sessions leaked into ~/.claude/projects: ${leaked.join(', ')}`);
    return leaked;
  }

  return { root, claudeDir, project, appEnv, claudeEnv, cleanup };
}
