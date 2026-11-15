<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Working in this fork

This repository is a personal fork of [LearnHarness](https://github.com/amosblomqvist/learnharness) (upstream remote: `upstream`). Coding agents write the code; the human owns the design. Read [docs/fork/README.md](docs/fork/README.md) before planning: it holds the fork's goals, settled decisions, and open questions. Upstream documentation under `docs/` still describes the code accurately unless a fork decision says otherwise.

## Decision authority

Ask the human, using the ask-user-question tool, before deciding anything that changes **what the product does**: behavior, UX, prompt or teaching wording, data and storage formats, settings, defaults, dependencies, and scope boundaries. One question per call, with your recommendation first. Investigate facts yourself; ask only for goals and preferences.

Decide **how** it is built yourself: internal names, module and refactor shape, test layout, and other implementation details that preserve the agreed behavior. Report those choices in your summary.

For non-trivial work: investigate, propose a plan, get it approved, then implement it mechanically. If implementation reveals a design question the plan did not settle, stop and ask instead of improvising. Record settled decisions in [docs/fork/README.md](docs/fork/README.md), and mark agent-selected choices as such.

## Environment

- Node comes from `mise` ([mise.toml](mise.toml), Node 26 like CI). **Agent shells are not mise-activated**: a bare `node` resolves to the global Node 24. Prefix every Node/npm/npx command with `mise exec --` (as below) unless `node --version` already prints v26.
- The package manager is **npm** with the committed `package-lock.json`. Do not switch to pnpm or yarn. Use `npm ci` for installs; add or upgrade dependencies only when the plan approves it.
- GitHub: `origin` is the fork (`phagmaier/learnharness`), `upstream` the original. Push, open PRs and run `gh` only against the fork. `gh` resolves to `upstream` unless a default is set; run `gh repo set-default phagmaier/learnharness` once per clone (it lives in `.git/config`). Pushes don't start CI on the fork until the human enables workflows on its Actions tab; until then, after pushing `main`, run `gh workflow run ci.yml --ref main` and check the result with `gh run watch`.
- The host is NixOS with nix-ld. The browser app needs nothing extra. Electron (`desktop:dev`, native renderer tests) must run inside `nix develop`. See [docs/fork/nixos.md](docs/fork/nixos.md).

## Commands

```sh
mise exec -- npm ci && mise exec -- npm run plugins:setup   # fresh checkout, or after lockfile/plugin API changes
mise exec -- npm run dev                        # browser app on http://localhost:3000
nix develop -c mise exec -- npm run desktop:dev # Electron window against the dev server
mise exec -- npm run typecheck                  # } the required gate
mise exec -- npm test                           # } (CI "quality" job)
mise exec -- npm run lint                       # }
mise exec -- npm run build                      # when touching build, routing, or server bundling
```

Never run raw `next dev`/`next build`: the npm scripts stage `core-plugins/` first. Plugins have no hot reload; restart the server after editing plugin sources. `npm test` takes about 4–5 minutes and has timing-sensitive tests that can fail under heavy machine load; rerun a failing file alone before treating it as a regression. Run focused files with `NODE_ENV=test mise exec -- npx tsx --test tests/<file>.test.ts`. Lint currently reports one inherited warning (`tests/source-name-ui.test.tsx`); zero errors is the bar.

## Where to look

- Code map and runtime flows: [docs/architecture.md](docs/architecture.md#code-boundaries). Layer import rules are enforced by [eslint.config.mjs](eslint.config.mjs).
- Commands, configuration, environment variables, debugging: [docs/development.md](docs/development.md).
- Teaching intent: [docs/teaching-methodology.md](docs/teaching-methodology.md). Agent prompts: [src/agent/prompts/README.md](src/agent/prompts/README.md).
- Plugins: [docs/plugin-authoring.md](docs/plugin-authoring.md), [docs/plugin-architecture.md](docs/plugin-architecture.md), sources in `plugins/`, templates in `examples/plugins/`.
- `docs/archive/` is historical. Do not follow its instructions.

## Safety rules

- **Never touch the human's real learning data.** The installed LearnHarness keeps data in `~/.config/LearnHarness/`; do not read or write it. For manual runs, use a scratch profile: `LH_DATA_DIR=<scratch>/data LH_AUTH_FILE=<scratch>/auth.json npm run dev -- --port 3001`. The repo's own `data/` and `auth.json` are the human's dev profile; leave them alone unless asked.
- Tests use fakes and fixtures. Do not call paid model providers, use real sign-ins, or commit credentials, `.env*`, or learning records.
- Do not hand-edit [golden fixtures](tests/fixtures/golden-data/README.md) to make tests pass; storage-format changes need an approved plan.
- Inspect `scripts/` before running them: some mutate data or call models.
- For UI changes, verify in a real browser (Playwright or the running app), not only by static render.
  - To see a transcript card without calling a model, write a session file shaped like those in `tests/fixtures/golden-data/chats/` into `<scratch>/data/chats/` and open `/chat/<id>`.
  - Start the dev server after `npm test` finishes: one left running during the suite keeps reloading open pages. The first request to a fresh dev server can take a minute or two to compile.
  - The Playwright MCP writes logs to `.playwright-mcp/` (git-ignored); delete it when done.

## Finishing work

Run the required gate (typecheck, tests, lint) and any focused or runtime checks the change needs. Update docs touched by the behavior change. Report what you verified, what you did not, and any agent-selected decisions. Commit only when asked; branch off `main` first.
