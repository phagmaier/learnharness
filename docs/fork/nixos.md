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

## Packaging the fork

The installed fork is an AppImage built here, published as a GitHub release on the fork, and wrapped in Hermes (`home/phagmaier/learnharness-fork.nix`) with `appimageTools.wrapType2`, like upstream's. Decisions: [README](README.md#fork-identity-packaging-and-ci--2026-11-12); plan: [plan 02](plans/02-fork-identity-packaging.md).

**Versions.** `package.json` `version` stays upstream's numeric base (plugin manifests are checked against it); `forkRelease` counts fork releases on that base. `node scripts/fork-version.mjs` prints the shown version, e.g. `0.6.1-fork.1`. Bump `forkRelease` for each release; reset it to 1 after merging a new upstream version.

**Release steps:**

1. Bump `forkRelease`, commit, and run the required gate.
2. Build: `nix develop -c mise exec -- npm run desktop:dist:linux`. It clears `dist/` and `.next/standalone`, builds, runs the provider and server smokes (the server smoke under Electron, hence `nix develop`), and writes `dist/LearnHarness-Fork-<version>-x86_64.AppImage`.
3. Publish (outward-facing): `gh release create v<version> dist/LearnHarness-Fork-<version>-x86_64.AppImage --repo phagmaier/learnharness --title "LearnHarness Fork <version>" --notes "<changes>"`.
4. In Hermes, set `version` and `hash` in `home/phagmaier/learnharness-fork.nix` (`nix store prefetch-file --hash-type sha256 <release URL>` prints the hash), then follow Hermes's verify-and-activate steps.

The wrapper appends mise's shims folder to `PATH`, so the app and the Claude CLI find mise-installed tools as a terminal does. The updater is off; a new version only arrives through these steps.

To try a build without installing it, run the unpacked app against a scratch profile so neither real folder is touched: `XDG_CONFIG_HOME=<scratch>/config nix develop -c dist/linux-unpacked/learnharness-fork`.

## Not set up

- **Chrome/Chromium.** Demo verification falls back to `CHROME_PATH` when Electron's browser helper is unavailable. None is installed; the test suite passes without it.
