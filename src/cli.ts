#!/usr/bin/env node
import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ClaudeCliClient } from './analyze/llm.js';
import { recapDay, getRecap } from './analyze/recap.js';
import { analysisNeeded, readStatus, runJobs, spawnDetachedRun } from './analyze/runner.js';
import { CONFIG_PATH, loadConfig } from './config.js';
import { hookCommand, hookStatus, installHook, settingsPath, uninstallHook } from './hooks/install.js';
import { readLiveSessions } from './ingest/live.js';
import { scan } from './ingest/scanner.js';
import { openDb } from './store/db.js';

const program = new Command()
  .name('companion')
  .description('A chief of staff for your engineering work, built on Claude Code')
  .action(async () => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error('companion needs an interactive terminal. Try `companion doctor` or `companion scan`.');
      process.exit(1);
    }
    const cfg = loadConfig();
    const db = openDb(cfg.dbPath);
    scan(db, cfg);
    if (analysisNeeded(db, cfg)) spawnDetachedRun(cfg);
    const [{ render }, { createElement }, { App }] = await Promise.all([
      import('ink'),
      import('react'),
      import('./tui/App.js'),
    ]);
    await render(createElement(App, { db, cfg }), { alternateScreen: true }).waitUntilExit();
  });

program
  .command('scan')
  .description('Ingest Claude Code transcripts into the companion database')
  .option('--json', 'print the result as JSON')
  .action((opts: { json?: boolean }) => {
    const cfg = loadConfig();
    const db = openDb(cfg.dbPath);
    const started = performance.now();
    const r = scan(db, cfg);
    const ms = Math.round(performance.now() - started);
    if (opts.json) return console.log(JSON.stringify({ ...r, ms }, null, 2));
    console.log(
      `Scanned ${r.filesSeen} transcripts in ${ms}ms: ${r.filesChanged} changed, ` +
        `${r.messagesAdded} new messages, ${r.filesOptedOut} opted out.`,
    );
    if (r.sessionsGone) console.log(`${r.sessionsGone} sessions no longer have a transcript on disk (history kept).`);
    if (r.subagentFiles) console.log(`${r.subagentFiles} subagent transcripts skipped (not ingested yet).`);
    if (r.invalidLines) console.log(`${r.invalidLines} lines could not be parsed.`);
    const unknown = Object.entries(r.unknownTypes);
    if (unknown.length) console.log(`Unknown record types: ${unknown.map(([t, n]) => `${t}×${n}`).join(', ')}`);
  });

program
  .command('doctor')
  .description('Check paths, database contents and Claude Code format compatibility')
  .action(() => {
    const cfg = loadConfig();
    const ok = (b: boolean) => (b ? '✓' : '✗');
    console.log(`${ok(existsSync(CONFIG_PATH))} config        ${CONFIG_PATH}${existsSync(CONFIG_PATH) ? '' : ' (using defaults)'}`);
    console.log(`${ok(existsSync(cfg.projectsDir))} transcripts   ${cfg.projectsDir}`);
    console.log(`${ok(existsSync(cfg.dbPath))} database      ${cfg.dbPath}`);
    if (cfg.sources.opt_out.length) console.log(`  opt-out       ${cfg.sources.opt_out.join(', ')}`);

    const db = openDb(cfg.dbPath);
    const one = <T>(sql: string) => db.prepare(sql).get() as T;
    const counts = one<{ p: number; s: number; m: number; gone: number }>(
      `SELECT (SELECT COUNT(*) FROM projects) p, (SELECT COUNT(*) FROM sessions) s,
              (SELECT COUNT(*) FROM messages) m, (SELECT COUNT(*) FROM sessions WHERE transcript_gone = 1) gone`,
    );
    console.log(`\n${counts.p} projects · ${counts.s} sessions (${counts.gone} archived only here) · ${counts.m} messages`);
    const lastScan = one<{ value: string } | undefined>(`SELECT value FROM meta WHERE key = 'last_scan'`);
    console.log(`last scan: ${lastScan?.value ?? 'never — run `companion scan`'}`);

    const versions = db
      .prepare(`SELECT cc_version v, COUNT(*) n FROM sessions WHERE cc_version IS NOT NULL GROUP BY v ORDER BY v DESC LIMIT 5`)
      .all() as { v: string; n: number }[];
    if (versions.length) console.log(`Claude Code versions seen: ${versions.map((r) => `${r.v} (${r.n})`).join(', ')}`);

    const unknown = one<{ value: string } | undefined>(`SELECT value FROM meta WHERE key = 'unknown_record_types'`);
    const types = unknown ? Object.entries(JSON.parse(unknown.value) as Record<string, number>) : [];
    console.log(
      types.length
        ? `⚠ unknown record types (format may have changed): ${types.map(([t, n]) => `${t}×${n}`).join(', ')}`
        : '✓ no unknown record types',
    );

    const usage = one<{ calls: number; failed: number; cost: number | null; today: number | null }>(
      `SELECT COUNT(*) calls, SUM(1 - ok) failed, SUM(cost_usd) cost,
              SUM(CASE WHEN ts >= date('now', 'start of day') THEN cost_usd END) today FROM llm_calls`,
    );
    const digests = one<{ n: number; away: number }>(
      `SELECT COUNT(*) n, SUM(source = 'away_summary') away FROM session_digests`,
    );
    console.log(
      `\n${digests.n} session summaries (${digests.away ?? 0} from Claude Code's own recaps) · ` +
        `${usage.calls} model calls (${usage.failed ?? 0} failed), ~$${(usage.cost ?? 0).toFixed(2)} total, ` +
        `~$${(usage.today ?? 0).toFixed(2)} today (API-equivalent; billed to your Claude plan)`,
    );
    const status = readStatus(db);
    if (status) console.log(`analyzer: ${status.state}${status.error ? ` (${status.error})` : ''} at ${status.updatedAt}`);
    const hook = hookStatus(cfg.claudeDir);
    console.log(`SessionEnd hook: ${hook.installed ? 'installed' : 'not installed (optional: `companion hooks install`)'}`);

    const live = readLiveSessions(cfg.claudeDir);
    console.log(`\n${live.length} live Claude Code session(s)`);
    for (const s of live) console.log(`  ${s.status === 'busy' ? '●' : '○'} ${s.name ?? s.sessionId}  ${s.cwd}`);
  });

program
  .command('run-jobs')
  .description('Summarise changed sessions and write today\'s recap (normally runs in the background)')
  .option('--force-recap', 'rewrite today\'s recap even if it exists')
  .option('--ended <sessionId...>', 'sessions known to have ended (skips the quiet period)')
  .action(async (opts: { forceRecap?: boolean; ended?: string[] }) => {
    const cfg = loadConfig();
    const db = openDb(cfg.dbPath);
    const llm = new ClaudeCliClient(db, join(dirname(cfg.dbPath), 'run'));
    const started = new Date();
    try {
      const r = await runJobs(db, cfg, llm, { forceRecap: opts.forceRecap, endedSessionIds: opts.ended });
      if (!r.ran) return console.log(`${started.toISOString()} another run is in progress; skipped.`);
      console.log(
        `${started.toISOString()} summarised ${r.digested} sessions with ${r.llmCalls} model calls` +
          `${r.recapWritten ? '; wrote today\'s recap' : ''}.`,
      );
    } catch (err) {
      console.error(`${started.toISOString()} run failed: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

program
  .command('recap')
  .description('Print today\'s recap')
  .action(() => {
    const cfg = loadConfig();
    const db = openDb(cfg.dbPath);
    const row = getRecap(db, recapDay(cfg).day);
    if (!row) {
      const status = readStatus(db);
      return console.log(
        status?.state === 'running' ? `Recap in progress (${status.step}).` : 'No recap yet. Run `companion run-jobs`.',
      );
    }
    const { recap } = row;
    console.log(`${recap.headline}\n`);
    for (const a of recap.action_items) console.log(`  [${a.priority}] ${a.text}  (${a.project})`);
    if (recap.blockers.length) console.log(`\nBlocked:\n${recap.blockers.map((b) => `  - ${b}`).join('\n')}`);
    console.log('');
    for (const p of recap.projects) console.log(`${p.project}: ${p.summary}\n`);
  });

const hooks = program.command('hooks').description('Manage the optional Claude Code SessionEnd hook');

hooks
  .command('install')
  .description('Refresh summaries whenever a Claude Code session ends')
  .action(() => {
    const cli = resolve(process.argv[1]!);
    if (!cli.endsWith('.js')) {
      console.error('Install hooks from the built CLI: run `npm run build`, then `node dist/cli.js hooks install`.');
      process.exit(1);
    }
    const cfg = loadConfig();
    const { backup } = installHook(cfg.claudeDir, hookCommand(process.execPath, cli));
    console.log(`Installed SessionEnd hook in ${settingsPath(cfg.claudeDir)}`);
    if (backup) console.log(`Backup of your previous settings: ${backup}`);
  });

hooks
  .command('uninstall')
  .description('Remove the SessionEnd hook')
  .action(() => {
    const cfg = loadConfig();
    console.log(uninstallHook(cfg.claudeDir) ? 'Removed the SessionEnd hook.' : 'No companion hook was installed.');
  });

hooks
  .command('status')
  .action(() => {
    const s = hookStatus(loadConfig().claudeDir);
    console.log(s.installed ? `Installed: ${s.command}` : 'Not installed. Run `companion hooks install`.');
  });

// Called by Claude Code's SessionEnd hook. Must return quickly and never fail the user's session.
program
  .command('hook', { hidden: true })
  .argument('<event>')
  .action((event: string) => {
    try {
      if (event !== 'session-end' || process.env.COMPANION_INTERNAL) return;
      const input = JSON.parse(readFileSync(0, 'utf8') || '{}') as { session_id?: string };
      spawnDetachedRun(loadConfig(), input.session_id ? ['--ended', input.session_id] : []);
    } catch {
      // Swallow everything: a broken companion must not break Claude Code.
    }
  });

await program.parseAsync();
