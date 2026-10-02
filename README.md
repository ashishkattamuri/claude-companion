# Claude Companion

Claude Code is powerful, but today it mostly works when you actively sit down and drive it.

This project asks a simple question:

What would it take to make Claude Code feel more like a personal engineering assistant?

Inspired by Muse, Claude Companion explores a wrapper around Claude Code that brings a more continuous, assistant-like experience to engineering work.

The coding agent already exists. The missing layer is the companion experience around it.

## Status

The first working version/demo is planned by this weekend. The MVP is built in milestones:

- [x] **M0 – Foundation:** ingest Claude Code transcripts from every project into a local SQLite store (incremental, survives Claude Code's 30-day cleanup, opt-out list), plus `doctor`
- [x] **M1 – Desktop app:** a session workspace where the conversation and a real Claude Code terminal show the same live session; drive it from either, approve tool calls from the UI, follow sessions running in other terminals
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

For development, `npm run dev` starts the app with hot reload. `npm test` runs the unit tests, `npm run test:e2e` drives the built app with Playwright and a fake `claude` (offline, free), and `npm run test:live` does the same against the real Claude Code CLI on Haiku (a few cents).

**Today** shows yesterday's work by project, blockers and action items. "Start session" opens a new Claude session on an item; "Continue where I left off" resumes the session it came from.

**Sessions** live in the sidebar: *Needs you* (waiting for an approval or answer), *Running*, and *Earlier*, with full-text search over everything you and Claude wrote. Opening one shows its whole conversation: your messages, Claude's replies, and its tool calls collapsed into steps you can expand to see diffs and command output.

Each session started or continued in Companion runs the real `claude` CLI in a terminal inside the app. The conversation view is rendered live from the transcript Claude Code writes, and messages you send are typed into that same terminal, so the two always agree. Switch between **Conversation**, **Split** and **Terminal**, and drive the session from whichever you like. When Claude asks for permission, the same prompt appears as a card in the conversation; answer it there or in the terminal. Sessions running in another terminal (iTerm, VS Code) are shown live, read-only. Sending a message to a session that isn't running continues it with `claude --resume`.

Shortcuts: `⌘N` new session, `Enter` send, `⇧Enter` new line, `Esc` interrupt Claude.

Summaries run in the background through `claude -p` on your own Claude login. They use Claude Code's own "away" recaps where available, Haiku for the rest of each session, and one Sonnet call for the daily recap. Model calls are isolated (no tools, no hooks, no MCP servers, nothing saved as a session) and capped per run. `companion doctor` shows how many calls were made.

Everything stays on your machine. To exclude projects, create `~/.config/claude-companion/config.toml`:

```toml
[sources]
opt_out = ["~/work/secret-project", "~/clients/*"]
```

## License

MIT License.
