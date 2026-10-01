# Claude Companion

Claude Code is powerful, but today it mostly works when you actively sit down and drive it.

This project asks a simple question:

What would it take to make Claude Code feel more like a personal engineering assistant?

Inspired by Muse, Claude Companion explores a wrapper around Claude Code that brings a more continuous, assistant-like experience to engineering work.

The coding agent already exists. The missing layer is the companion experience around it.

## Status

The first working version/demo is planned by this weekend. The MVP is built in milestones:

- [x] **M0 – Foundation:** ingest Claude Code transcripts from every project into a local SQLite store (incremental, survives Claude Code's 30-day cleanup, opt-out list), plus `doctor`
- [ ] **M1 – Sessions:** TUI listing live and recent sessions across projects; resume or start a session
- [ ] **M2 – Morning recap:** what you did yesterday and action items for today
- [ ] **M3 – Ideas:** follow-ups and directions from your conversations, run interactively or in the background
- [ ] **M4 – Hardening:** SessionEnd hook, secret redaction, scheduled recap

## Usage

Requires Node 20+ and Claude Code.

```sh
npm install
npm run dev -- scan     # ingest transcripts into ~/.local/share/claude-companion/db.sqlite
npm run dev -- doctor   # check paths, data, live sessions and transcript-format compatibility
```

Everything stays on your machine. To exclude projects, create `~/.config/claude-companion/config.toml`:

```toml
[sources]
opt_out = ["~/work/secret-project", "~/clients/*"]
```

## License

MIT License.
