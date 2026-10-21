// `claude plugin …` for the fake CLI: a small catalog, installs and options kept in
// <claude dir>/fake-plugins.json, and the files Claude Code writes on install
// (plugins/installed_plugins.json, enabledPlugins in settings.json, the plugin's .mcp.json).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIRECTORY = 'anthropic-plugin-directory';
const MODERNIZE_OPTIONS = {
  track: { type: 'string', title: 'Track to follow', description: 'Which way the commands work.', default: 'auto', options: ['auto', 'transform', 'uplift'] },
  legacyDir: { type: 'string', title: 'Legacy directory', description: 'Where the legacy code lives.', default: 'legacy' },
};

function catalog(state) {
  const plugins = [
    { name: 'github', description: 'Official GitHub MCP server for repository management.', installCount: 345391 },
    { name: 'code-modernization', description: 'Modernize legacy codebases with a structured workflow.', installCount: 2100 },
    { name: 'frontend-design', description: 'Distinctive, production-grade frontend interfaces.', installCount: 500000 },
    { name: 'runs-a-command', description: 'Installed by running a command from its marketplace.' },
    // Enough to need "Show more".
    ...Array.from({ length: 70 }, (_, i) => ({ name: `tool-${String(i).padStart(2, '0')}`, description: `Filler plugin number ${i}.` })),
  ].map((p) => ({ pluginId: `${p.name}@${DIRECTORY}`, marketplaceName: DIRECTORY, source: 'x', ...p }));
  for (const m of state.marketplaces) plugins.push({ pluginId: `${m.name}-lint@${m.name}`, name: `${m.name}-lint`, description: `Lint rules from ${m.name}.`, marketplaceName: m.name, source: 'x' });
  return plugins;
}

export function plugin(claudeDir, args, stdin) {
  const file = join(claudeDir, 'fake-plugins.json');
  const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { installed: {}, marketplaces: [] };
  const save = () => {
    writeFileSync(file, JSON.stringify(state));
    // What Claude Code itself keeps on disk, which Companion reads for plugins' MCP servers.
    const installed = Object.fromEntries(Object.keys(state.installed).map((id) => [id, [{ scope: 'user', installPath: pathOf(id) }]]));
    mkdirSync(join(claudeDir, 'plugins'), { recursive: true });
    writeFileSync(join(claudeDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: installed }));
    const settingsFile = join(claudeDir, 'settings.json');
    const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {};
    settings.enabledPlugins = Object.fromEntries(Object.entries(state.installed).map(([id, p]) => [id, p.enabled]));
    writeFileSync(settingsFile, JSON.stringify(settings));
  };
  const pathOf = (id) => join(claudeDir, 'plugins', 'cache', id.replace('@', '-'));
  const out = (o, code = 0) => {
    console.log(JSON.stringify(o));
    process.exitCode = code;
  };
  const result = (command, id, ok, message, extra = {}) => out({ command, outcome: ok ? 'ok' : 'failed', plugin: id, message, ...extra }, ok ? 0 : 1);
  const [sub, ...rest] = args;
  const id = rest.find((a) => !a.startsWith('-') && rest[rest.indexOf(a) - 1] !== '--scope' && rest[rest.indexOf(a) - 1] !== '--accept-command');
  const list = () => Object.entries(state.installed).map(([pid, p]) => ({ id: pid, version: '1.0.0', scope: 'user', enabled: p.enabled, installPath: pathOf(pid) }));

  if (sub === 'list') return out(rest.includes('--available') ? { installed: list(), available: catalog(state) } : list());
  if (sub === 'marketplace') {
    const [action, ...margs] = rest;
    const target = margs.find((a) => !a.startsWith('-'));
    if (action === 'list') return out(state.marketplaces);
    if (action === 'add') {
      const name = target.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      state.marketplaces.push({ name, source: 'github', repo: target });
      save();
      return out({ command: 'marketplace-add', outcome: 'ok', marketplace: name, message: `Successfully added marketplace: ${name}` });
    }
    if (action === 'remove') {
      state.marketplaces = state.marketplaces.filter((m) => m.name !== target);
      for (const pid of Object.keys(state.installed)) if (pid.endsWith(`@${target}`)) delete state.installed[pid];
      save();
      return out({ command: 'marketplace-remove', outcome: 'ok', marketplace: target, message: `Successfully removed marketplace: ${target}` });
    }
    return out({ command: 'marketplace-update', outcome: 'ok', marketplace: target, message: 'Updated' });
  }

  const known = catalog(state).some((p) => p.pluginId === id);
  const p = state.installed[id];
  if (sub === 'install') {
    if (!known) return result('install', id, false, `Plugin "${id}" not found`, { failureCode: 'not_found' });
    const sha = 'a'.repeat(64);
    if (id.startsWith('runs-a-command@') && !rest.includes(sha)) {
      return out({ command: 'install', outcome: 'needs_confirmation', plugin: id, message: 'Shows a command', shownCommand: { command: 'npx some-installer --yes', sha256: sha } }, 1);
    }
    state.installed[id] = { enabled: true, config: {} };
    mkdirSync(pathOf(id), { recursive: true });
    if (id.startsWith('github@')) {
      writeFileSync(join(pathOf(id), '.mcp.json'), JSON.stringify({ github: { type: 'stdio', command: process.execPath, args: [process.env.FAKE_GITHUB_SERVER ?? ''], env: { FAKE_GH_LOG: process.env.FAKE_GH_LOG ?? '' } } }));
    }
    save();
    return result('install', id, true, `Successfully installed plugin: ${id} (scope: user)`, { pluginId: id, scope: 'user' });
  }
  if (!p && sub !== 'details' && sub !== 'configure') return result(sub, id, false, `Plugin "${id}" not found in installed plugins`, { failureCode: 'not_installed' });
  if (sub === 'uninstall') {
    delete state.installed[id];
    rmSync(pathOf(id), { recursive: true, force: true });
    save();
    return result('uninstall', id, true, `Successfully uninstalled plugin: ${id}`);
  }
  if (sub === 'enable' || sub === 'disable') {
    if (p.enabled === (sub === 'enable')) return result(sub, id, false, `Plugin "${id}" is already ${sub}d`, { failureCode: 'already_in_goal_state' });
    p.enabled = sub === 'enable';
    save();
    return result(sub, id, true, `Successfully ${sub}d plugin: ${id}`);
  }
  if (sub === 'update') return result('update', id, true, `${id} is already at the latest version`, { updateOutcome: 'up_to_date' });
  if (sub === 'details') {
    if (!p) {
      console.log(`Plugin "${id}" not found.`);
      process.exitCode = 1;
      return;
    }
    console.log(`${id.split('@')[0]} 1.0.0\n\nComponent inventory\n  Skills (1)  ${id.split('@')[0]}\n  MCP servers (${id.startsWith('github@') ? 1 : 0})\n\nProjected token cost\n  Always-on:   ~120 tok   added to every session`);
    return;
  }
  if (sub === 'configure') {
    if (!p) {
      console.log(`No installed plugin has the id "${id}".`);
      process.exitCode = 1;
      return;
    }
    const schema = id.startsWith('code-modernization@') ? MODERNIZE_OPTIONS : {};
    if (rest.includes('--values-stdin')) {
      const values = JSON.parse(stdin || '{}');
      const unknown = Object.keys(values).find((k) => !schema[k]);
      if (unknown) return out({ pluginId: id, refused: { message: `This plugin has no option "${unknown}".` } }, 1);
      Object.assign(p.config, values);
      save();
      return out({ pluginId: id, saved: Object.keys(values), unconfigured: Object.keys(schema).filter((k) => !(k in p.config)) });
    }
    const inputs = Object.fromEntries(Object.entries(schema).map(([k, o]) => [k, p.config[k] ?? (k === 'track' ? o.default : '')]));
    const choices = Object.fromEntries(Object.entries(schema).filter(([, o]) => o.options).map(([k, o]) => [k, o.options]));
    return out({
      pluginId: id,
      displayName: id.split('@')[0],
      schema,
      inputs,
      choices,
      configured: Object.keys(p.config),
      unconfigured: Object.keys(schema).filter((k) => !(k in p.config)),
    });
  }
  console.error(`fake claude: unsupported plugin arguments: ${args.join(' ')}`);
  process.exitCode = 2;
}
