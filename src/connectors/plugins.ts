import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Claude Code's plugins, through `claude plugin … --json`: the same catalog, installs and settings
 * as `/plugin` in a session. Companion keeps no copy; every call asks Claude Code.
 */

export const InstalledPlugin = z.looseObject({
  id: z.string(),
  version: z.string().nullish(),
  scope: z.string(),
  enabled: z.boolean(),
  installPath: z.string().nullish(),
  installedAt: z.string().nullish(),
  lastUpdated: z.string().nullish(),
});
export type InstalledPlugin = z.infer<typeof InstalledPlugin>;

const AvailablePlugin = z.looseObject({
  pluginId: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  marketplaceName: z.string(),
  version: z.string().nullish(),
  installCount: z.number().nullish(),
});

export const Marketplace = z.looseObject({
  name: z.string(),
  source: z.string().nullish(),
  repo: z.string().nullish(),
  url: z.string().nullish(),
  path: z.string().nullish(),
  installLocation: z.string().nullish(),
});
export type Marketplace = z.infer<typeof Marketplace>;

/** One plugin in the catalog, with what its marketplace says about it and whether it's installed. */
export interface CatalogPlugin {
  id: string;
  name: string;
  description: string;
  marketplace: string;
  version: string | null;
  installCount: number | null;
  category: string | null;
  author: string | null;
  homepage: string | null;
  installed: InstalledPlugin | null;
}

export interface PluginCatalog {
  plugins: CatalogPlugin[];
  marketplaces: Marketplace[];
}

/** The result line every `--json` action prints. */
export const ActionResult = z.looseObject({
  outcome: z.string(),
  message: z.string().nullish(),
  failureCode: z.string().nullish(),
  /** A plugin installed by running a command: shown to a person, then accepted by its hash. */
  shownCommand: z.looseObject({ sha256: z.string(), command: z.string().nullish() }).nullish(),
});
export type ActionResult = z.infer<typeof ActionResult>;

export const PluginOption = z.looseObject({
  type: z.string().nullish(),
  title: z.string().nullish(),
  description: z.string().nullish(),
  default: z.unknown().optional(),
  options: z.array(z.string()).nullish(),
  sensitive: z.boolean().nullish(),
});

export const PluginConfig = z.looseObject({
  pluginId: z.string(),
  displayName: z.string().nullish(),
  schema: z.record(z.string(), PluginOption),
  inputs: z.record(z.string(), z.string()),
  choices: z.record(z.string(), z.array(z.string())).default({}),
  configured: z.array(z.string()).default([]),
  unconfigured: z.array(z.string()).default([]),
});
export type PluginConfig = z.infer<typeof PluginConfig>;

export type PluginAction = 'install' | 'uninstall' | 'enable' | 'disable' | 'update';
export type MarketplaceAction = 'add' | 'remove' | 'update';

export class PluginCli {
  constructor(
    private bin: string,
    private env: () => Record<string, string>,
    private timeoutMs = 180_000,
  ) {}

  async catalog(): Promise<PluginCatalog> {
    const [list, marketplaces] = await Promise.all([
      this.json(['plugin', 'list', '--json', '--available'], z.object({ installed: z.array(InstalledPlugin), available: z.array(AvailablePlugin) })),
      this.json(['plugin', 'marketplace', 'list', '--json'], z.array(Marketplace)),
    ]);
    return { plugins: mergeCatalog(list.installed, list.available, marketplaces), marketplaces };
  }

  /** Installs, removes, turns on or off, or updates a plugin, for every session (user scope). */
  async plugin(action: PluginAction, id: string, acceptCommand?: string): Promise<ActionResult> {
    const args = ['plugin', action, id, '--json'];
    if (action === 'install' || action === 'uninstall') args.push('--scope', 'user');
    if (acceptCommand) args.push('--accept-command', acceptCommand);
    return this.action(args);
  }

  async marketplace(action: MarketplaceAction, target?: string): Promise<ActionResult> {
    return this.action(['plugin', 'marketplace', action, ...(target ? [target] : []), '--json']);
  }

  /** What a plugin adds to sessions (skills, agents, hooks, servers) and what it costs in context. */
  async details(id: string): Promise<string> {
    return (await this.run(['plugin', 'details', id])).stdout.trim();
  }

  async config(id: string): Promise<PluginConfig> {
    return this.json(['plugin', 'configure', id, '--json'], PluginConfig);
  }

  /** Saves option values; options left out keep theirs. */
  async saveConfig(id: string, values: Record<string, string>): Promise<{ saved: string[] }> {
    const { stdout } = await this.run(['plugin', 'configure', id, '--values-stdin', '--json'], JSON.stringify(values));
    const out = lastJson(stdout) as { saved?: string[]; refused?: { message?: string } } | null;
    if (!out) throw new Error(stdout.trim().split('\n')[0] || 'claude plugin configure failed');
    if (out.refused) throw new Error(out.refused.message ?? 'Refused');
    return { saved: out.saved ?? [] };
  }

  private async action(args: string[]): Promise<ActionResult> {
    const { stdout, stderr } = await this.run(args);
    const parsed = ActionResult.safeParse(lastJson(stdout));
    if (!parsed.success) throw new Error((stderr || stdout).trim().split('\n')[0] || `claude ${args.slice(0, 3).join(' ')} failed`);
    return parsed.data;
  }

  private async json<T>(args: string[], schema: z.ZodType<T>): Promise<T> {
    const { stdout, stderr, code } = await this.run(args);
    try {
      return schema.parse(JSON.parse(stdout));
    } catch {
      throw new Error((stderr || stdout).trim().split('\n')[0] || `claude ${args.slice(0, 3).join(' ')} exited with ${code}`);
    }
  }

  /** Resolves on any exit: `--json` actions report failures on stdout with a non-zero code. */
  private run(args: string[], input?: string): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
      const child = execFile(this.bin, args, { env: this.env(), timeout: this.timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err && typeof err.code !== 'number') return reject(new Error(`Could not run claude: ${err.message}`));
        resolve({ stdout, stderr, code: err ? Number(err.code) : 0 });
      });
      child.stdin?.end(input ?? '');
    });
  }
}

/** The last line of output that parses as JSON (human messages can follow or precede it). */
function lastJson(stdout: string): unknown {
  for (const line of stdout.trim().split('\n').reverse()) {
    try {
      return JSON.parse(line);
    } catch {}
  }
  return null;
}

/** The catalog, plus category, author and homepage from marketplaces that are on disk. */
export function mergeCatalog(
  installed: InstalledPlugin[],
  available: z.infer<typeof AvailablePlugin>[],
  marketplaces: Marketplace[],
): CatalogPlugin[] {
  const extra = new Map<string, { category: string | null; author: string | null; homepage: string | null; description: string | null }>();
  for (const m of marketplaces) {
    if (!m.installLocation) continue;
    try {
      const manifest = JSON.parse(readFileSync(join(m.installLocation, '.claude-plugin', 'marketplace.json'), 'utf8')) as {
        plugins?: { name: string; category?: string; homepage?: string; author?: { name?: string } | string; description?: string }[];
      };
      for (const p of manifest.plugins ?? []) {
        extra.set(`${p.name}@${m.name}`, {
          category: p.category ?? null,
          homepage: p.homepage ?? null,
          author: typeof p.author === 'string' ? p.author : (p.author?.name ?? null),
          description: p.description ?? null,
        });
      }
    } catch {}
  }
  const byId = new Map(installed.map((i) => [i.id, i]));
  const plugins: CatalogPlugin[] = available.map((a) => {
    const e = extra.get(a.pluginId);
    return {
      id: a.pluginId,
      name: a.name,
      description: a.description ?? e?.description ?? '',
      marketplace: a.marketplaceName,
      version: a.version ?? null,
      installCount: a.installCount ?? null,
      category: e?.category ?? null,
      author: e?.author ?? null,
      homepage: e?.homepage ?? null,
      installed: byId.get(a.pluginId) ?? null,
    };
  });
  // Installed plugins the catalog no longer lists (a removed marketplace, a local plugin) still show.
  const listed = new Set(plugins.map((p) => p.id));
  for (const i of installed) {
    if (listed.has(i.id)) continue;
    const [name, marketplace = ''] = i.id.split('@');
    plugins.push({ id: i.id, name: name!, description: '', marketplace, version: i.version ?? null, installCount: null, category: null, author: null, homepage: null, installed: i });
  }
  return plugins;
}
