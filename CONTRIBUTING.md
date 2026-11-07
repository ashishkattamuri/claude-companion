# Contributing

Thanks for your interest in contributing to Companion for Claude.

## Project direction

Companion for Claude is context and session management for Claude Code, built to improve developer productivity and engineering workflows. It doesn't replace Claude Code. It adds the layer around it that long, real-world work needs:

- **Context and session management** (the core): seeing what fills a session's context, session notes, hand-offs, linked sub-sessions (branching), side threads, and audits of where a session's tokens went.
- **Developer productivity**: every session in one window grouped by what it needs (Needs you, Running, Earlier), search, and the morning recap. Ideas and Goals are planned.
- **Engineering workflows**: reviewing a session's changes like a pull request, approvals and connectors today; always-on agentic workflows are planned.

New features should fit one of these, and ideally make context easier to see, keep focused or carry forward.

## Useful contributions

- Bug reports with steps to reproduce (`companion doctor` output helps)
- Context and memory design: notes, hand-offs, branching, what a new session should start from
- Workflow examples and design notes for the planned Ideas, Goals and agentic workflows
- README and documentation improvements
- Small, focused pull requests with tests

## Principles

- Keep the user in control: nothing runs, edits or sends without a clear way to see and stop it
- Make behavior easy to understand
- Prefer practical workflows over complex abstractions
- Avoid unnecessary infrastructure; everything stays on the user's machine
- Do not store secrets by default

## How to contribute

1. Open an issue for ideas, bugs or proposed changes.
2. Keep pull requests small and focused, and explain why the change is useful.
3. Run `npm run typecheck`, `npm test` and `npm run test:e2e` before opening a pull request. Use `npm run test:live` when a change depends on the real Claude Code CLI.
4. Include screenshots for visible changes.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
