---
name: live-runs
description: Run Companion against the real Claude Code CLI — the live tests (test:live, test:live-branch, test:live-side) and recorded live demo takes for reels or issue screenshots. Use when validating a feature live before pushing, when asked to "run the live tests", or when recording real app footage. Runs on the user's own subscription login; no token needed.
---

# Live tests and live demo takes

Live runs drive the real `claude` CLI on the user's **own subscription login**. No
`CLAUDE_CODE_OAUTH_TOKEN` or API key is needed and the cost (a few cents on Haiku) is fine:
just run them. Don't stop to ask for a token.

The one hard rule: **never touch the user's real chats or Companion data**. Every run uses its
own project folder and a fresh Companion DB that sees only that folder, and deletes every
session it created when it's done, pass or fail.

## Live tests

From the repo (or the worktree you're working in):

```sh
npm run build                 # the tests launch the built app (out/) and CLI (dist/)
npm run test:live-branch      # branching, notes, new-chat tool, earlier-conversation search
npm run test:live             # sessions, approvals, terminal, resume
npm run test:live-side        # side chats: fork, cache, follow-ups
```

Each takes a few minutes. Run them in the background with output to a file in the job's tmp
dir, and read the `✓`/`✗` lines and `N/M checks passed` at the end. Screenshots go to
`test/e2e/screenshots/`. Read them when a check fails: they usually show what happened.

How the sandbox works (`test/e2e/sandbox.mjs`, `liveSandbox(name)`):

- Without a token it uses the real login. The project goes in `~/workspace/.companion-live-<name>-*`
  because `~/workspace` is already trusted, so sessions don't stop at the folder-trust prompt.
  Companion's config sets `opt_out = ["/**", "!<project>"]`, so it lists none of the user's chats.
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, so test chats never write to the user's memory.
- With `CLAUDE_CODE_OAUTH_TOKEN` set, it also gets its own `CLAUDE_CONFIG_DIR` in a tmp folder.
- `cleanup()` stops only background sessions whose cwd is in the sandbox, deletes the sandbox
  and its `~/.claude/projects/-Users-…-companion-live-*` folders, and keeps sweeping until
  nothing reappears for 5s. Stopped sessions write their last records a few seconds later.

Writing a new live test:

- Use `liveSandbox(name)`. Never point a test at `~/.claude` or the real Companion DB directly.
- Pass `sandbox.appEnv` to the app and `sandbox.claudeEnv` to any `claude` you spawn.
- Find the run's transcripts with `sandbox.transcriptDirs()`, not by scanning `~/.claude/projects`.
- Any process the test starts itself (e.g. a `node-pty` `claude` standing in for iTerm) must
  have **exited** before `cleanup()`. Kill it and await `onExit`, also in `finally`. Otherwise
  it writes a transcript into `~/.claude/projects` after cleanup.
- Read values that can change (a chat's title is retitled after its first turn) right before
  you compare against them.
- Prompts that say "remember …" invite memory writes. Auto-memory is off in the sandbox, but
  phrase prompts so the answer is in the chat itself.

After a run, check that nothing was left behind:

```sh
ls ~/.claude/projects | grep -c companion-live    # expect 0
ls -a ~/workspace | grep -c companion-live        # expect 0
```

If something is left, it belongs to the run (the names are unique): find out what wrote it,
fix the test, then delete the folder.

## Live demo takes (reel footage, screenshots)

A take is a scripted, recorded run of the real app on a real chat, so the answers and numbers
are genuine. Start from `take-template.mjs` in this folder. Copy it to the job's tmp dir, fill
in the scenario, and run:

```sh
ELECTRON_RUN_AS_NODE=1 <repo>/node_modules/.bin/electron <tmp>/take.mjs <outDir>
```

- **Project:** the demo project `~/workspace/acme/checkout-service` (trusted, looks real on
  screen). Companion sees only `~/workspace/acme`; the rest of the user's chats stay hidden.
  A fresh DB lists no projects in the new-session sheet, so pick it with **Choose…**: the
  script stubs the folder dialog to answer with the demo project.
- **App:** a fresh DB and user-data in a tmp folder, `--force-device-scale-factor=2`, window
  1440×900. Recorded from Electron's paint stream (`beginFrameSubscription`) as timestamped
  JPEG frames in `<outDir>/frames`, plus `shots/` and a `log.txt` with `MARK <name>` lines
  for cutting.
- **Model:** pick it in the new-session sheet. Use Haiku for cheap retakes and Sonnet or Opus
  when answer quality shows on screen.
- **Pacing:** type with `pressSequentially` (about 32 ms per key) so typing reads on video.
  Wait until the head says `Ready` and the last reply has stopped changing before the next beat.
- **Cleanup:** stop the take's background sessions (cwd in the project and started after the
  take began), wait 5s, then delete only the transcripts the take created in that project's
  `~/.claude/projects` folder. The script records what was there before it started.

For reels, follow the promo-reel preferences in memory (dark launch style, captions, real
footage). For issue screenshots, the offline fake-claude setup (`npm run test:e2e`) is
usually enough and free. Use a live take only when real answers matter.
