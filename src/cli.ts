#!/usr/bin/env node
import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { CONFIG_PATH, loadConfig } from './config.js';
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

    const live = readLiveSessions(cfg.claudeDir);
    console.log(`\n${live.length} live Claude Code session(s)`);
    for (const s of live) console.log(`  ${s.status === 'busy' ? '●' : '○'} ${s.name ?? s.sessionId}  ${s.cwd}`);
  });

await program.parseAsync();
