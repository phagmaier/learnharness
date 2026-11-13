# Plan 02: fork identity and packaging (roadmap step 2)

**Status:** approved by the human 2026-11-12. Items 1–5 are done and merged. Items 6–7 (release and Hermes) were moved to roadmap step 8, the last step (human, 2026-11-12). The first release and the Hermes branch were made and then removed; re-check items 6–7 against the code when step 8 starts.

Designs: [fork README](../README.md), "Fork identity, packaging, and CI" and "Desktop PATH under mise". Choices made in the 2026-11-12 interview are marked **Decided (human)**. Agent-selected implementation details are marked as such and reported again at completion.

**Order (decided, human):** app changes first (items 1–4), each tested, then packaging (items 5–7). Nothing is published or installed until items 1–4 pass. One commit per item.

**Safety:** no step reads or writes `~/.config/LearnHarness`. Every Electron run of the fork, packaged or not, sets `XDG_CONFIG_HOME=<scratch>/config`, so both the copy source and the destination are scratch folders seeded from fake fixtures.

## Facts this plan relies on (verified 2026-11-12)

- `electron/main.cjs` sets `app.setName("LearnHarness")`, so userData is `~/.config/LearnHarness`. It holds `data/`, `auth.json`, `chatgpt-credentials.json`, `github-copilot-credentials.json`, `xai-credentials.json`, `logs/`, and Chromium's profile (lock files, cookies, Local Storage, spelling dictionary, caches). Dev (`LH_DEV_URL`) appends `-dev`.
- No record stores an absolute path under userData or `data/`; every location is rebuilt from `LH_DATA_DIR` at runtime. Stores write by temp file and rename. A copied folder therefore works as-is. Exception: a community plugin could save its absolute `dataDirectory` in its own data. No core code does.
- Electron's single-instance lock lives in userData, so two apps with different userData folders don't block each other. Chromium's `SingletonLock` there is a symlink to `<hostname>-<pid>`. The installed app's bubblewrap wrapper does not isolate process IDs, so the fork can see whether that process is alive.
- The installed upstream app comes from `~/Hermes/home/phagmaier/learnharness.nix`: `appimageTools.wrapType2` around upstream's GitHub-release AppImage, listed in `home/phagmaier/apps.nix`. Hermes serves the `nix-desktop` and `nix-laptop` hosts.
- Settings → General already hides "Check for updates" and "Automatic updates" when the updater reports `disabled`. "Release notes" links to `<package.json homepage>/releases/tag/v<version>`.
- The Claude CLI runs with `--strict-mcp-config` and restricted setting sources, so PATH matters only for finding `claude` itself (and `node`, for an npm-installed CLI).

## 1. Name, data folder, and launcher identity

**Change:**
- `electron/main.cjs`: the display name becomes **LearnHarness Fork** (`app.setName`, used in menus and dialogs). userData is set explicitly to `<appData>/LearnHarness-Fork`; dev becomes `LearnHarness-Fork-dev` through the existing suffix.
- `electron-builder.yml`: `productName: LearnHarness Fork`, `appId: com.learnharness.fork`, `linux.executableName: learnharness-fork`, `artifactName: LearnHarness-Fork-${version}-${arch}.${ext}`.
- `package.json`: `desktopName: learnharness-fork.desktop` (sets the window class and launcher match), `homepage: https://github.com/phagmaier/learnharness`.
- **Decided (human):** version scheme is upstream base plus a fork counter. The first release is `0.6.1-fork.1`.
- **Decided (human):** keep upstream's icon.
- *Agent-selected:* `package.json` `name` and `author` stay upstream's to limit merge conflicts.

**Tests:** update the identity pins in `tests/desktop-platform.test.ts` (desktop name, homepage, Linux target), plus a check that userData resolves to `LearnHarness-Fork`, and `-Fork-dev` in dev.

**Docs:** `docs/fork/nixos.md` table (installed fork row, new dev profile name).

## 2. Updater off

**Decided (human):** remove "Check for Updates…" from the app menu. Point `homepage` at the fork, so "Release notes" opens the fork's GitHub release for the installed version. The version row stays.

**Change:**
- `setupAutoUpdater` reports `disabled` in packaged builds and never loads `electron-updater`, so no check, download, or timer ever runs. The menu item is omitted.
- Remove the `publish` block from `electron-builder.yml`, so no upstream feed (`app-update.yml`) is baked into the package.
- *Agent-selected:* keep upstream's updater code and the `electron-updater` dependency behind a single fork switch, rather than deleting them, to keep upstream merges small.

**Tests:** in `tests/automatic-updates.test.ts` (fake Electron, real `main.cjs`), a packaged boot never requires `electron-updater`, reports `disabled`, schedules no check, and builds a menu without "Check for Updates…". *Upstream tests changed on purpose:* the enabled-path cases there no longer apply and are replaced. The existing `render-update-settings` test already covers the hidden controls.

## 3. One-time copy of upstream data on first launch

**Decided (human):**
- Copy **everything except logs**, also leaving out caches and Chromium's lock files. That includes `data/`, `auth.json`, subscription sign-ins, and the Chromium profile (cookies, spelling dictionary). Caveat accepted: OpenAI rotates refresh tokens, so if both apps stay in use, one of them may later need a new ChatGPT sign-in.
- If upstream is running, ask the human to quit it first. Nothing is copied and the fork doesn't start until upstream is closed.
- After a successful copy, show a one-time dialog. When there was nothing to copy, show nothing.

**Flow (packaged builds only; dev and the browser-service helper skip it):**
1. After the fork takes its own single-instance lock and before Chromium opens the profile: if the fork's copy marker exists, skip the copy.
2. If `<appData>/LearnHarness` doesn't exist, write the marker and start empty.
3. If upstream's `SingletonLock` points to a live process, show the "upstream running" dialog once the app is ready. **Retry** checks again. Once upstream is closed, the fork relaunches itself, so the copy happens before Chromium opens the profile. **Quit** exits.
4. Otherwise, copy into a staging folder inside the fork's userData, move the entries into place, and write the marker last. The source is only ever opened for reading, and file modes are kept (`auth.json` stays 0600).
5. On failure, remove the staging folder, write no marker, show the failure dialog, and quit. The next launch tries again, so a failed copy never turns into an empty start.

**Proposed wording (approve or edit):**
- *Upstream running*, title "LearnHarness is running": "Quit LearnHarness so LearnHarness Fork can copy your learning data. Your original data stays untouched." Buttons: **Retry**, **Quit**.
- *Copied*: "Copied your LearnHarness data into LearnHarness Fork. The original in ~/.config/LearnHarness is untouched." Button: **OK**.
- *Failed*: "LearnHarness Fork couldn't copy your data from ~/.config/LearnHarness: <reason>. Nothing in the original was changed. The fork will try again the next time it starts." Button: **Quit**.

**Implementation (agent-selected):** a pure helper, `electron/upstream-copy.cjs`, takes the two folder paths and an injected liveness check and returns `copied`, `nothing-to-copy`, `already-done`, `upstream-running`, or `failed`. `main.cjs` maps the result to the dialogs above. The marker is a small JSON file in the fork's userData (`upstream-copy.json`) recording the time and source. Log lines go to the fork's `logs/main.log`.

**Tests** (`tests/upstream-copy.test.ts`, temp folders with fake files):
- full copy, with the exclusions honored
- the source tree is byte-for-byte unchanged afterwards
- `auth.json` mode is kept
- a second run is `already-done`
- a missing source writes the marker
- a live-PID lock gives `upstream-running`; a stale lock (dead PID) copies
- an injected mid-copy failure leaves no marker and no staging folder, and the next run succeeds

## 4. Verify items 1–3 in a real packaged build

- Build with `npm run desktop:dist:linux` (item 5), then run the unpacked app with `XDG_CONFIG_HOME=<scratch>/config`, seeded with a fake `LearnHarness` folder.
- **Agent checks:** the copy result on disk, the marker, log lines, a second launch skipping the copy, a fake upstream lock (a live `sleep` process) blocking the copy, Settings → General showing only the version and fork release link, and the window title and class.
- **Human checks:** the three dialogs and their buttons. The agent can't click native dialogs. Commands are given at that point.

## 5. Local Linux build

**Decided (human):** build locally and publish to a GitHub release on the fork.

**Change:** a new npm script, `desktop:dist:linux`. It clears `dist` and `.next/standalone`, runs `build`, `smoke-provider-runtime.mjs`, `build-server.mjs`, and `smoke-server.mjs --electron`, then `electron-builder --linux AppImage --x64 --publish never`. It runs inside `nix develop`. *Agent-selected:* `linux.target` becomes AppImage only (no `.deb`).

**Risk:** electron-builder downloads its own `appimagetool` and `mksquashfs` binaries, which must run through nix-ld. This is checked first. If it fails and a fix needs a new dependency or a different method, the agent stops and asks.

**Docs:** a packaging section in `docs/fork/nixos.md` (build, release, bump Hermes) replacing "Not set up: Linux packaging".

## 6. Release on the fork (outward-facing; the agent asks before publishing)

`gh release create v0.6.1-fork.1 dist/LearnHarness-Fork-0.6.1-fork.1-x86_64.AppImage --repo phagmaier/learnharness` with short notes listing the fork's changes since upstream 0.6.1. The AppImage is public. The agent shows the exact command and notes and waits for a yes.

## 7. Hermes package (agent edits on a Hermes branch; the human merges and activates)

**Decided (human):** the agent edits Hermes on a new branch there, following Hermes's own AGENTS.md. Upstream's `learnharness.nix` stays installed until the human removes it.

**Change:**
- `home/phagmaier/learnharness-fork.nix`: `appimageTools.wrapType2` around the fork release's AppImage (fetchurl with hash), installing `learnharness-fork.desktop` (with `Exec=learnharness-fork`) and the icon.
- **Decided (human), desktop PATH:** the wrapper's `profile` appends mise's shims folder to PATH: `${MISE_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/mise}/shims`. Every program the app or the Claude CLI starts then finds mise tools as in a terminal. No shell variables are imported.
- List it in `home/phagmaier/apps.nix`.

**Verify (Hermes's workflow):**
- `nix flake check`
- build both hosts with `--no-link`
- `nix store diff-closures` against the running system
- run the built wrapper with a scratch `XDG_CONFIG_HOME` and a minimal desktop-like PATH, and confirm the app finds `claude` (Settings → Providers → External CLI)

The agent does not run `nixos-rebuild switch` unless asked. Hermes's docs are updated where they list apps.

## Finishing

- Required gate after each item, `npm run build` for items 1 and 5, and CI's Electron native tests inside `nix develop`.
- Update `docs/fork/README.md`: roadmap step 2 done, and the desktop PATH open question closed.
- Completion report per item: what changed, checks and results, human checks still owed, agent-selected choices.

## Outcome (2026-11-12, items 1–5)

- **Item 1.** *Decided (human), in place of the planned version field:* `package.json` `version` stays `0.6.1`, because the plugin loader (`src/core/plugins.ts`) and the plugin-authoring build accept only `x.y.z`, and `0.6.1-fork.1` would have stopped every plugin from loading. A new `forkRelease` field counts fork releases. `scripts/fork-version.mjs` and `next.config.ts` build the shown version from the two fields, and the Linux build passes it to electron-builder as `extraMetadata.version`.
- *Agent-selected:* `scripts/verify-release.ts` and its test were deleted. They verified upstream's 11-asset release drafts for the `release.yml` removed in step 1, had no other callers, and failed on the new product name.
- **Item 2.** *Agent-selected:* `UPDATER_ENABLED = false` in `main.cjs`. Upstream's updater tests still run against the kept code, with only that line flipped in the test's copy of the source. New fork tests cover the shipped, disabled path. `publish: null`, not an absent block, stops electron-builder from inferring a GitHub feed; the built package contains no `app-update.yml`.
- **Item 3.** As planned, plus `tests/upstream-copy-shell.test.ts`, which drives the dialog flow (Retry loop, relaunch, Quit, failure, confirmation, wording) through the real `main.cjs` with a fake Electron. An AppImage relaunches through `$APPIMAGE`, since its mount disappears when the app exits.
- **Item 4, packaged run** (`dist/linux-unpacked`, `XDG_CONFIG_HOME` scratch, fake files):
  - With a live fake upstream lock: logged `upstream-running`, copied nothing, and showed the "LearnHarness is running" dialog. The window class is `learnharness-fork`.
  - With a stale lock: copied, with logs excluded, `auth.json` kept at 0600, and the marker written. The "LearnHarness Fork" confirmation dialog appeared, and the upstream folder was unchanged.
  - On the next launch: logged `already-done`, opened the window, and logged that the updater is off. Settings → General showed "Version 0.6.1-fork.1", a Release notes link to `phagmaier/learnharness/releases/tag/v0.6.1-fork.1`, and no update controls.
  - *Not driven by the agent* (no key-sending tool on this Hyprland): clicking Retry, Quit, and OK. Retry's relaunch is covered by unit tests only.
- **Item 5.** `desktop:dist:linux` built `dist/LearnHarness-Fork-0.6.1-fork.1-x86_64.AppImage` inside `nix develop` on the first try. electron-builder's downloaded AppImage tools run through nix-ld.
- Full gate after item 3: typecheck, lint (1 inherited warning), and tests (5316 pass, 0 fail, 4 skipped).

## Not in this plan

- **Browser storage resets on every packaged launch (found 2026-11-12, inherited from upstream; confirmed in item 4).** The packaged app serves its window from `127.0.0.1` on a random port, and browser storage is keyed by origin. A value stored before a restart was gone after it (the port changed from 42733 to 40117), so per-device preferences such as step 1's "Show all models" toggle reset on every launch, and the copied Local Storage is effectively unused. A fix needs its own decision.
- Uninstalling upstream: the human does it when ready, by removing `learnharness.nix` from Hermes.
- GitHub repository settings (open question in the README).
