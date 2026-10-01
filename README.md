# Claude Companion

Claude Code is powerful, but today it mostly works when you actively sit down and drive it.

This project asks a simple question:

What would it take to make Claude Code feel more like a personal engineering assistant?

Inspired by Muse, Claude Companion explores a wrapper around Claude Code that brings a more continuous, assistant-like experience to engineering work.

The coding agent already exists. The missing layer is the companion experience around it.

## Status

The first working version/demo is planned by this weekend. The MVP is built in milestones:

- [x] **M0 – Foundation:** ingest Claude Code transcripts from every project into a local SQLite store (incremental, survives Claude Code's 30-day cleanup, opt-out list), plus `doctor`
- [x] **M1 – Desktop app:** Electron app listing live and recent sessions across projects; search, resume or start sessions in embedded terminal tabs running the real Claude Code CLI
- [x] **M2 – Morning recap:** what you did yesterday and action items for today, built from Claude Code's own away summaries plus Haiku summaries where those are missing
- [ ] **M3 – Ideas:** follow-ups and directions from your conversations, run interactively or in the background
- [ ] **M4 – Hardening:** SessionEnd hook, secret redaction, scheduled recap

## Usage

Requires macOS, Node 20+ and Claude Code.

```sh
npm install                # also rebuilds native modules for Electron
npm run build && npm link  # puts `companion` on your PATH

companion          # open the desktop app
companion recap    # print today's recap
companion doctor   # check paths, data, live sessions, model usage and transcript-format compatibility
companion hooks install   # optional: refresh summaries whenever a Claude Code session ends
```

For development, `npm run dev` starts the app with hot reload. `npm test` runs the unit tests and `npm run test:e2e` drives the built app with Playwright.

**Today** shows yesterday's work by project, blockers and action items. "Start session" opens a new Claude session on an item; "Continue where I left off" resumes the session it came from.

**Sessions** lists running sessions first, then recent sessions from every project, with full-text search over everything you and Claude wrote. Sessions open as tabs in the app, each running the real `claude` CLI in an embedded terminal, so permissions, slash commands and plan mode all work as usual. Shortcuts: `⌘N` new session, `⌘W` close tab, `⌘1`–`⌘6` switch pages.

Summaries run in the background through `claude -p` on your own Claude login. They use Claude Code's own "away" recaps where available, Haiku for the rest of each session, and one Sonnet call for the daily recap. Model calls are isolated (no tools, no hooks, no MCP servers, nothing saved as a session) and capped per run. `companion doctor` shows how many calls were made.

Everything stays on your machine. To exclude projects, create `~/.config/claude-companion/config.toml`:

```toml
[sources]
opt_out = ["~/work/secret-project", "~/clients/*"]
```

## License

MIT License.
