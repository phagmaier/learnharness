# Development setup on NixOS

This fork is developed on NixOS with `mise` managing language runtimes. The upstream [development guide](../development.md) still applies; this page covers only what differs on this machine.

## Prerequisites

- **mise** with Node pinned by [mise.toml](../../mise.toml) (Node 26.13.0, matching CI's Node 26). Run `mise trust` once in a fresh clone. `mise install` fetches Node if it is missing. Interactive zsh picks up the pin automatically; non-interactive shells (coding agents, scripts) do not and fall back to the global Node 24, so they must use `mise exec --`.
- **nix-ld** enabled in the NixOS configuration (`programs.nix-ld.enable = true`). Prebuilt binaries from npm, including mise's Node, load through it.
- **Flakes** enabled, for `nix develop`.

## First-time setup

```sh
mise install
npm ci
npm run plugins:setup
```

Verified on 2026-11-12: `npm ci`, `plugins:setup`, `typecheck`, `lint` (1 existing warning), and the full `npm test` (5323 pass, 4 skipped) succeed with no Nix shell.

## Browser development

`npm run dev` serves on http://localhost:3000 and needs nothing beyond mise.

## Electron development

npm's prebuilt Electron needs GTK, NSS, X11 and other libraries that NixOS does not provide globally. [flake.nix](../../flake.nix) defines a dev shell that adds them to `NIX_LD_LIBRARY_PATH`, which only nix-ld-loaded binaries read, so Nix-built tools in the shell are unaffected. The shell does not provide Node; it inherits the mise-activated `PATH`.

```sh
nix develop -c npm run desktop:dev
```

Or enter the shell with `nix develop` and run commands as usual. CI's Electron native-renderer tests also run inside the shell:

```sh
nix develop -c env NODE_ENV=test ELECTRON_RUN_AS_NODE=1 \
  npx electron --import tsx --test tests/pdf-native-render.test.ts tests/pdf-ops.test.ts \
  tests/svg-native-render.test.ts tests/browser-service.test.ts
```

`desktop:dev` gives the dev server 30 seconds to answer. A cold first start (plugin builds plus first route compile) can exceed that and exit with "did not respond within 30000ms"; run it again.

If Electron starts failing with a missing `lib*.so`, add the providing package to `electronLibs` in `flake.nix`. Note that `ldd` ignores nix-ld and reports every library as missing even when it loads; test by running the binary.

## Installed apps vs this checkout

The system-installed upstream LearnHarness (a Nix FHS wrapper of upstream's release) keeps its data under `~/.config/LearnHarness/`. The packaged fork, **LearnHarness Fork**, uses `~/.config/LearnHarness-Fork/` and never writes upstream's folder; on its first launch it copies upstream's folder once (see [plan 02](plans/02-fork-identity-packaging.md)). This checkout uses separate locations:

| Run mode | Data | Keys |
| --- | --- | --- |
| Installed upstream app | `~/.config/LearnHarness/data` | `~/.config/LearnHarness/auth.json` |
| Installed fork | `~/.config/LearnHarness-Fork/data` | `~/.config/LearnHarness-Fork/auth.json` |
| `npm run dev` / `desktop:dev` | repo `data/` | repo `auth.json` (+ subscription credential files beside it) |
| `desktop:dev` Electron profile | `~/.config/LearnHarness-Fork-dev/` (window state, browser storage) | — |

Each installed app picks a free port, so it does not collide with dev's port 3000. Shared between them: API keys from environment variables (which override saved keys) and the Claude Code CLI's own profile. Both can run at once.

## Not set up

- **Chrome/Chromium.** Demo verification falls back to `CHROME_PATH` when Electron's browser helper is unavailable. None is installed; the test suite passes without it.
- **Linux packaging.** `npm run desktop:dist` is upstream's signed macOS release path. See [desktop-release.md](../desktop-release.md) for other platforms.
