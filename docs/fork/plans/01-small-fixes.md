# Plan 01: small fixes (roadmap step 1)

**Status:** completed; approved by the human 2026-11-12, with open behavior choices settled the same day (marked **Decided**).

Designs: [fork README](../README.md) (identity and CI, model pickers, right-click menu). Work happens on one branch, with **one commit per item** in the order below, so each can be reviewed or reverted alone. Every item ends with the required gate (`typecheck`, `test`, `lint`) unless stated otherwise.

## 1. Trim CI

**Change:** in `.github/workflows/ci.yml`, keep the `quality` job and reduce the `standalone` matrix to the `ubuntu-24.04` / `linux-x64` entry. Delete `.github/workflows/release.yml` and `.github/workflows/notify-website.yml`.

**Out of scope:** `electron-builder.yml`'s `publish` block, which still points at upstream's releases. It is handled with the updater in roadmap step 2.

**Verify:** inspect the YAML; the result is checked on the next push.

## 2. Claude CLI discovery through mise

**Current behavior:** `src/agent/claude-code/binary.ts` searches `PATH`, then fixed folders. A desktop-launched app has no mise-activated `PATH`, so a mise-installed `claude` is not found (reproduced 2026-11-12).

**Change:** append mise's shims folder to the POSIX fixed folders, after the existing entries so explicit installs keep priority. The folder is `$MISE_DATA_DIR/shims` if set, else `$XDG_DATA_HOME/mise/shims`, else `~/.local/share/mise/shims`, matching mise's own data-dir rule. The shim is used as-is (no symlink resolution); it is a link to the `mise` binary and dispatches on its name. Verified 2026-11-12: `~/.local/share/mise/shims/claude --version` works from an empty directory with a minimal desktop `PATH` and prints `2.1.322 (Claude Code)`. The app already never resolves the CLI path's symlinks.

**Tests** (`tests/claude-code-binary.test.ts`, which already uses a fake executable set):
- minimal `PATH` → shim found
- `MISE_DATA_DIR` respected
- `XDG_DATA_HOME` respected
- an earlier fixed folder wins over the shim
- Windows lookup unchanged

**Docs:** add mise to the discovery note in `docs/claude-code.md`.

## 3. Desktop right-click menu

**Current behavior:** `electron/` registers no `context-menu` handler, so spelling suggestions never appear.

**Change:**
- New pure helper `electron/context-menu.cjs` turns Electron's `context-menu` params into a menu template.
- `electron/main.cjs` attaches it to the main window's `webContents` and pops up the built menu.
- Menu actions use `webContents.replaceMisspelling` and `session.addWordToSpellCheckerDictionary`, plus the standard editing roles.

Contents, per the design:
- **On a misspelled word:** up to 5 suggestions, then "Add to dictionary".
- **Then:** Cut, Copy, Paste, Select All, each shown only when its edit flag allows.
- **On selected read-only text:** Copy.
- **Otherwise:** no menu.

**Decided (human):** a misspelled word with no suggestions shows a disabled "No suggestions" line before "Add to dictionary", as Chrome does.

**Verify at implementation:** that the app's own right-click handlers (sidebar, graph canvas, selection actions) call `preventDefault` and therefore suppress the native menu. Any that don't are listed and asked about rather than changed.

**Tests:** unit tests for the template builder with fake params, in the style of `tests/appearance-chrome.test.ts`:
- misspelling with and without suggestions
- the 5-suggestion cap
- editable field vs read-only selection
- an empty, non-editable area producing no menu

**Manual check (human):** right-click a misspelled word in `nix develop -c mise exec -- npm run desktop:dev`. The agent cannot drive Electron's native menu.

## 4. Upgrade pi-ai and pi-agent-core to 1.5.2

**Facts:**
- `@earendil-works/pi-agent-core@1.5.2` depends on `@earendil-works/pi-ai@1.5.2` exactly, so they move together.
- 1.5.2 was published 2026-11-10 (past the one-day release-age gate).
- It adds `gpt-6.1-terra` and `claude-fable-5-2`, and pulls new versions of the OpenAI and Anthropic SDKs.
- No plugin package depends on pi; several scripts import it.

**Change:**
- Read the 1.4.0 → 1.5.2 release notes in the pi repository (`github.com/earendil-works/pi`) and summarize anything touching APIs this app uses.
- Then `mise exec -- npm install --save-exact @earendil-works/pi-ai@1.5.2 @earendil-works/pi-agent-core@1.5.2` and fix any type or behavior breaks.
- Breaks that need a behavior choice are reported, not improvised.

**Verify:**
- required gate
- `npm run build`, then `node scripts/smoke-provider-runtime.mjs`
- the CI Electron native tests inside `nix develop`

**Report:** release-note summary, lockfile diff size, anything changed to compile.

**Outcome (2026-11-12):**
- *Anthropic message threads off (agent-selected; the human delegated it and uses subscriptions only).* pi 1.5.1 sends Anthropic API requests as beta "message threads" by default: only new messages, with the server keeping the earlier conversation, system prompt and tools. This app rebuilds every request from its own transcript, so `piEngineForSpec` sets `compat.supportsMessageThreads: false` for `anthropic-messages` models. `tests/provider-neutral-agents.test.ts` asserts full requests with no `thread` field.
- *Packaged-server trace.* pi's GitHub Copilot OAuth now imports `auth/oauth/trusted-url.js`, which `next.config.ts`'s hand-kept include list missed; `scripts/smoke-provider-runtime.mjs` caught it.
- *Typing.* pi now types tool arguments with pi-schema's `Static<T>`; one cast in `src/server/plugin-background-tools.ts`. pi-ai no longer re-exports TypeBox's `Type`; one test imports it from `typebox`.
- *Test pins updated to pi's new facts:*
  - the `session-id` affinity header (pi's own Codex transport uses it too)
  - OpenCode Go's protocol-specific endpoints and `gemini-4-argon`
  - one new API-key provider row (Qwen Token Plan Individual CN)
  - fake-provider usage that books session prompt tokens as cache reads/writes rather than input
- *Verified:* full gate; `npm run build`; `smoke-provider-runtime.mjs`; `build-server.mjs` + `smoke-server.mjs --electron`; CI's Electron native tests (33/33). The last two ran inside `nix develop`, after a separate fix letting the compression probe keep nix-ld's variables.

## 5. Model pickers

### 5a. Latest per family + "Show all models"

**Rule:**
- Derive a model's family from its id by removing a trailing date stamp and the first version number. For example, `claude-opus-5-5` → `claude-opus-#` version 5.5, and `gpt-6.1-terra` → `gpt-#-terra` version 6.1.
- Each provider shows the highest version per family, preferring an undated id over a dated snapshot of the same version.
- Ids without a version number are always shown.
- It's a pure function in `src/core/`, applied in the picker, not the server, so settings validation and saved selections are unaffected.

**Prototype on pi-ai 1.5.2's catalogs (2026-11-12):**

| Catalog | All | Shown by default |
| --- | --- | --- |
| Anthropic API | 18 | `claude-fable-5-2`, `claude-haiku-5-5`, `claude-opus-5-5`, `claude-sonnet-5-5` |
| OpenAI subscription catalog | 8 | `gpt-6-astra`, `gpt-6-luna`, `gpt-6.1-sol`, `gpt-6.1-terra` |
| OpenAI API | 44 | 18, including older but distinct families such as `gpt-4o`, `o3`, `gpt-5.5-pro`, plus 3 unversioned ids |

**Behavior details:**
- The currently selected model is always listed, even if hidden by the rule.
- **Decided (human):** search covers all models, including hidden ones; the toggle affects only the unsearched list.
- **Decided (human):** the toggle is remembered per device in browser storage, not as a synced setting. Storage failures fall back to off.
- **Decided (human):** accept the 18-model OpenAI API list for now; no generation rule, because it would also hide a family that simply hasn't been refreshed.

**Claude Code:** the CLI aliases become `fable`, `opus`, `sonnet`, `haiku` (adding `fable` to `src/agent/claude-code/provider.ts`). "Show all models" adds the Anthropic catalog's full ids under the Claude Code provider, so a version can be pinned. Aliases are always shown.

**Tests:** the family function against fixed id lists, including:
- the table above
- dated snapshots
- unversioned ids
- multi-part versions
- the selected-model exception

Also the picker's filtering in `tests/model-catalog-setup.test.tsx` or a neighboring focused test, and the Claude Code catalog in `tests/claude-code-provider.test.ts`.

### 5b. Unverified ChatGPT models

**Current behavior:** `refreshChatGPTModels` (`src/agent/chatgpt-bridge.ts`) drops live account models missing from pi-ai's catalog. The live list carries only `slug` and `display_name` as used today (`electron/chatgpt.cjs`).

**Change:**
- Keep unknown models, built from a fallback template: the transport fields (api, base URL, compatibility flags) of the newest known ChatGPT model, with conservative limits.
- Mark them unverified in `ModelCatalogEntry` (new optional flag) so the picker shows a "New: limits unknown" badge and lists them only under "Show all models".
- When a request on an unverified model fails, the error message adds that the model's limits are guessed.
- Known models are unaffected, and an upgrade that teaches the library the model removes the badge automatically.

**Decided (human):** fallback limits are a 128,000-token context window, 32,000 maximum output tokens, thinking levels low/medium/high only, and text-only input (image features unavailable for that model until the library knows it).
- **Possible refinement (needs a human):** the live ChatGPT `/models` response may include real limits and supported reasoning levels. A sample can only be captured with the human's signed-in account. If the human captures one, the plan uses those fields instead of guesses.

**Tests:** extend `tests/chatgpt-catalog.test.ts`:
- an unknown live model is kept with fallback values and the unverified flag
- a known one is unchanged
- the badge and filtering behave as specified
- the error note appears only for unverified models

## Item 5 outcome (2026-11-12)

- Implemented as planned:
  - `src/core/model-families.ts`
  - `browse` in `SearchMenuList`
  - the toggle and badge in `ModelMenuList`
  - unverified ChatGPT models in `src/agent/chatgpt-bridge.ts`, with the failure note in `chatGPTFailureMessage`
  - the `fable` alias and full Anthropic names for Claude Code
- *Agent-selected details:*
  - The fallback template is the first known model in the account's list (else the first pi Responses model), not a "newest" one. All Responses models share the copied transport fields.
  - The error note's wording.
  - The toggle's storage key, `lh:show-all-models`.
- *Upstream test changed on purpose:* `tests/chatgpt-stream.test.ts` pinned "do not invent capabilities" (dropping unknown models). It now pins the fork's unverified-model behavior.
- *Plugin API:* `ModelCatalogEntry.unverified` is part of the plugin SDK, so `docs/plugin-api/` was regenerated.
- *Browser check (dev server, scratch profile, dummy keys, nothing sent):*
  - The default view showed 4 Anthropic models, 21 OpenAI (18 newest-per-family plus 3 unversioned ids, as prototyped) and 2 DeepSeek (from an ambient shell key).
  - Show all listed all 64 and stored the preference.
  - With the toggle off, searching "opus 4" found the hidden Opus 4.x models.
- *Not seen in a real browser:* the unverified badge (needs a ChatGPT sign-in) and the Claude Code list (needs the CLI opt-in). Unit tests cover both.

## Not in this plan

Fork identity, the updater, and Nix packaging (roadmap step 2); everything after.

## Completion report

Per item: what changed, checks run with results, manual checks still owed by the human, and any agent-selected implementation choices.
