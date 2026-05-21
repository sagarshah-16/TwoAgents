# Two Agents

Two Agents is a local-first desktop app that runs OpenAI Codex CLI and Claude Code together as a worker/reviewer pair. One agent drafts a solution, the other reviews it, and the loop continues until the result is approved, blocked, or needs your input.

The app is built for software work where you want another model in the room before changes are applied, shipped, or handed back to a user.

## Project Status

Two Agents is early open source software. It runs locally, has automated tests, and can build unsigned desktop artifacts. Signed releases, notarization, auto-updates, and release CI are still on the roadmap.

## Features

- Local Electron desktop app built with React, Vite, and TypeScript.
- Worker/reviewer orchestration between OpenAI Codex CLI and Claude Code.
- Provider role selection, login checks, and automatic fallback behavior when a provider times out or is unavailable.
- Read-only mode for reviewable proposed diffs.
- Workspace-write mode for direct edits in a selected local workspace.
- Live agent logs, iteration timing, chat history, patch application, and PDF chat export.
- Main-process validation and log redaction for safer local operation.

## Requirements

- Node.js 22 or newer.
- npm.
- OpenAI Codex CLI installed and authenticated.
- Claude Code installed and authenticated.

Two Agents shells out to your locally installed CLI tools. Provider credentials stay with those tools; this app does not proxy them through a hosted service.

## Getting Started

Install dependencies:

```sh
npm install
```

Start the development app:

```sh
npm run dev
```

The dev command compiles the Electron main process, starts Vite on `127.0.0.1`, watches Electron TypeScript files, and launches Electron after the dev server is ready.

## Usage

1. Launch the app with `npm run dev`.
2. Confirm both providers are installed and logged in.
3. Select a local workspace.
4. Choose read-only mode for proposed diffs or workspace-write mode for direct edits.
5. Send a task and let the worker/reviewer loop run.
6. Review the final answer, logs, changed files, and any generated patch before committing work.

Read-only mode is the safer default. Workspace-write mode gives the agents the ability to change files and run commands inside the selected workspace, so review the resulting changes carefully.

## Scripts

```sh
npm run dev            # Start the Electron app in development mode
npm run typecheck      # Type-check renderer and Electron TypeScript projects
npm test               # Run Vitest tests
npm run build          # Build renderer and Electron output
npm run security:scan  # Run the repository security scan
npm run ci             # Run typecheck, tests, build, and security scan
npm run dist:dir       # Build an unpacked desktop app
npm run dist           # Build distributable desktop artifacts
```

Current desktop artifacts are unsigned. Do not treat them as production releases until signing and notarization are in place.

## Architecture

- `src/` contains the React renderer UI and shared renderer-side helpers.
- `electron/` contains the Electron main process, preload bridge, provider checks, command runner, patch handling, orchestration, and log bus.
- `shared/` contains types and diff helpers shared by the main process and renderer.
- `test/` contains Vitest coverage for orchestration, command execution, provider handling, diff parsing, UI behavior, and safety checks.
- `scripts/` contains local maintenance and security tooling.

At runtime, the renderer communicates with the main process through the preload bridge. The main process validates requests, runs provider CLI commands, streams logs, tracks results, and applies patches when requested.

## Security Model

Two Agents is intentionally local-first, but it can run powerful CLI tools against your filesystem. Treat the selected workspace as the app's trust boundary.

- Read-only mode is the default.
- Workspace operations are scoped to directories selected through the app.
- IPC payloads are validated in the main process.
- Logs redact common secret and token patterns before being written.
- Patch application goes through the main process instead of arbitrary renderer filesystem access.

Use read-only mode when you want proposed changes without direct filesystem edits, and switch to workspace-write mode only for workspaces you are comfortable letting local agent CLIs modify.

## Troubleshooting

If provider checks fail, confirm the CLIs are available in the same shell environment used to start the app and that each provider is logged in.

If Electron does not launch, run `npm run typecheck` and `npm run build` to separate TypeScript issues from runtime startup issues.

If tests fail after dependency changes, remove generated build output, reinstall dependencies, and rerun `npm run ci`.

## Contributing

Contributions are welcome. Open an issue or pull request with a focused description of the problem, the proposed change, and any relevant test output.

## Roadmap

- Signed macOS, Windows, and Linux release artifacts.
- macOS notarization and Windows code signing.
- Auto-update channels.
- Packaged-app smoke tests.
- Opt-in crash and error reporting.
- Richer user controls for data retention and log clearing.

## License

MIT.
