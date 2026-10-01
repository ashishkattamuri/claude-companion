import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'smol-toml';
import { z } from 'zod';

export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p;
}

const xdg = (envVar: string, fallback: string) => process.env[envVar] ?? join(homedir(), fallback);

export const CONFIG_PATH =
  process.env.COMPANION_CONFIG ?? join(xdg('XDG_CONFIG_HOME', '.config'), 'claude-companion', 'config.toml');

const ConfigSchema = z.object({
  sources: z
    .object({
      claude_dir: z.string().default('~/.claude'),
      opt_out: z.array(z.string()).default([]),
    })
    .prefault({}),
  data: z
    .object({
      dir: z.string().default(join(xdg('XDG_DATA_HOME', '.local/share'), 'claude-companion')),
    })
    .prefault({}),
  models: z
    .object({
      digest: z.string().default('haiku'),
      recap: z.string().default('sonnet'),
      ideas: z.string().default('sonnet'),
    })
    .prefault({}),
  limits: z
    .object({
      max_llm_calls_per_run: z.number().int().positive().default(30),
      min_user_prompts: z.number().int().nonnegative().default(3),
    })
    .prefault({}),
  recap: z.object({ day_starts_at: z.string().regex(/^\d\d:\d\d$/).default('04:00') }).prefault({}),
});

export type Config = z.infer<typeof ConfigSchema> & {
  claudeDir: string;
  projectsDir: string;
  dbPath: string;
  isOptedOut: (cwd: string) => boolean;
};

export function loadConfig(path = CONFIG_PATH): Config {
  const raw = existsSync(path) ? parse(readFileSync(path, 'utf8')) : {};
  const cfg = ConfigSchema.parse(raw);
  const claudeDir = resolve(expandHome(cfg.sources.claude_dir));
  const dataDir = resolve(expandHome(cfg.data.dir));
  const optOut = cfg.sources.opt_out.map(globToRegExp);
  return {
    ...cfg,
    claudeDir,
    projectsDir: join(claudeDir, 'projects'),
    dbPath: process.env.COMPANION_DB ?? join(dataDir, 'db.sqlite'),
    isOptedOut: (cwd) => optOut.some((re) => re.test(cwd)),
  };
}

/** `*` matches within a path segment, `**` across segments. A pattern also matches everything beneath it. */
export function globToRegExp(pattern: string): RegExp {
  const src = resolve(expandHome(pattern))
    .split(/(\*\*|\*)/)
    .map((part) => (part === '**' ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${src}(?:/.*)?$`);
}
