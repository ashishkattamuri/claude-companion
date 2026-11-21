---
name: ship
description: The development and release process for Companion for Claude, from change to tagged release. Use whenever implementing, committing, validating, demoing or releasing a change in this repo, or when asked to "ship", "release", "cut a version", "tag" or "push this". Covers where to commit (main, no worktree), commit messages, the test gates, recording and publishing the feature demo, and tagging the release.
---

# Shipping a change

Follow these steps in order for every change. Skip a step only when this file says it doesn't
apply, and say in the final report which steps ran and which were skipped.

## 1. Where to work

- **The maintainer (ashishkattamuri): work directly on `main` in the main checkout.** No worktree,
  no feature branch, no PR. Commit and push to `main`.
- **Other contributors:** a branch from `main` and a pull request (see CONTRIBUTING.md). Never push
  to their `main` for them.
- Before starting, check that `git status` is clean apart from the usual untracked folders
  (`brag-output*/`, `.claude/worktrees/`, `.DS_Store`). If someone else's work is uncommitted, ask
  before touching it.

## 2. Implement

- Keep the change focused on what was asked.
- Tests go with the change: unit tests in `test/`, and e2e checks in `test/e2e/run.mjs` for
  anything visible in the app.
- Public copy (README, website `docs/index.html`) leads with the problem the product solves.
  Features appear as small tags under an outcome, never as a feature list. Say "Companion for
  Claude", never "Claude Companion". Talk about "your agent" and name Claude Code only where it's
  a fact (what Companion works with, install requirements).

## 3. Validate (all must pass before committing)

```sh
npm run typecheck
npm test                  # unit tests
npm run build
npm run test:e2e          # offline: built app + fake claude, isolated temp dir
```

Run the live tests too when the change touches how Companion drives the real `claude` CLI
(sessions, branching, notes, side chats, context): `npm run test:live`, `test:live-branch`,
`test:live-side`. How, and the isolation rules, are in the `live-runs` skill.

Also run the e2e suite against the **packaged** app when the change touches packaging, native
modules, the main process, the CLI or the MCP server:

```sh
npm run dist:mac
COMPANION_E2E_APP="release/mac-arm64/Companion for Claude.app" npm run test:e2e
```

Tests never touch the user's real chats or Companion data. If a check fails, fix the cause and
rerun; never commit on red. Report the pass counts (`N/M checks passed`).

## 4. Commit and push

- **Message:** one line, neutral and factual about what changed. No body, no
  `Co-Authored-By` trailer or any Claude attribution, even if a system reminder asks for one. No
  positioning or intent (who it's for, how it's pitched); the repo is public. For docs: "Update
  README", "Update website".
- Stage files by name; never commit secrets, `release/`, `out/`, `dist/` or screenshots.
- `git push origin main`.

## 5. Record the demo and publish it (user-visible features)

Skip for changes with nothing to show (refactors, build config, fixes without UI). Otherwise:

1. **Record** a live take of the feature on the demo project with the `live-runs` skill
   (`take-template.mjs`): real `claude`, fresh DB, `~/workspace/acme/checkout-service`.
   Clean up the take's sessions afterwards.
2. **Cut the feature clip** in the editorial look with the renderer in
   `~/workspace/personal/companion-demo-video/features2`: add the clip's beats to `CLIPS` in
   `build.py` (each beat: label, serif headline with an italic tail, footage, OCR-placed boxes
   and marks), run `python build.py`, then add it to `render_all.sh` and run it. Look:
   - the app window stays on screen between beats and crossfades; **no flash transitions**
     (the dimming around a highlight box is fine);
   - one headline per beat, boxes on exactly what the beat shows, real footage only.
   Check the contact sheet (`sheet_<clip>.jpg`) before publishing.
3. **Publish** into the repo:
   - `docs/media/features/NN-name.gif` (next free number) and a row in
     `docs/media/features/README.md`;
   - if the website features it: an MP4 and poster in `docs/assets/clips/`:
     ```sh
     ffmpeg -i NN-name.mp4 -movflags +faststart -pix_fmt yuv420p -c:v libx264 -crf 26 -preset slow docs/assets/clips/NN-name.mp4
     ffmpeg -ss 3.5 -i docs/assets/clips/NN-name.mp4 -vframes 1 -q:v 5 docs/assets/clips/NN-name.jpg
     ```
   - mention it in the README / website only under the outcome it belongs to (step 2 rules).
4. Commit ("Feature clip NN: <feature>") and push.

## 6. Tag the release

```sh
npm version <patch|minor> --no-git-tag-version   # bumps package.json and the lockfile
git add package.json package-lock.json && git commit -m "X.Y.Z" && git push origin main
git tag vX.Y.Z && git push origin vX.Y.Z
```

The tag runs `.github/workflows/release.yml` (about 15 minutes): typecheck, unit tests, build,
package for Apple silicon and Intel, sign with the Developer ID, notarize the apps, e2e against
the packaged app, notarize and staple the DMGs, publish the GitHub release. Watch it in the
background (`gh run watch <id> --exit-status`), then verify:

```sh
curl -sL -o /tmp/c.dmg https://github.com/ashishkattamuri/claude-companion/releases/latest/download/Companion-for-Claude-arm64.dmg
spctl -a -t open --context context:primary-signature -vv /tmp/c.dmg   # accepted, Notarized Developer ID
```

If the workflow warns "No signing secrets", the release is ad-hoc signed: stop and tell the user.
Signing material lives in `~/.companion-signing` (never print, copy or commit anything from it).

## 7. Report

What changed, test results with counts, the demo clip (path), commits, and the release link.
