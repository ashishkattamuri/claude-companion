#!/usr/bin/env node
// The companion's native modules are built for Electron, so the CLI runs on Electron's bundled
// Node rather than whichever Node is on your PATH. This launcher only hands off; it loads nothing.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const electron = createRequire(import.meta.url)('electron');
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const r = spawnSync(electron, [cli, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
process.exit(r.status ?? 1);
