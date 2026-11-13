# Plan 03: notes and conversation export (roadmap step 3, course phase 0)

**Status:** approved by the human 2026-11-12, including its Proposed items. Work happens on branch `phase0-notes-export`. Item 1 ends at a checkpoint: the human approves the look (and fonts) from screenshots before item 2 starts. *Done 2026-11-13: items 1–6, checkpoint approved (see [Outcome](#outcome)).*

Designs: [fork README](../README.md), "Courses, units, and notes". Choices made in the interview are marked **Decided (human)**. Agent-selected implementation details are marked as such and reported again at completion. **Proposed** items are product choices the agent filled in; approving the plan approves them, or the human edits them.

**Scope:** on-demand notes and HTML conversation export for **standalone Teach sessions**, plus the shared document template that course phase 1 reuses. Not in this plan: units, courses, the course Notes tab, and the completion-dialog offers (phase 1); Practice sessions (no notes by design; they keep the Markdown export); packaging and release (step 8).

## Decisions from the interview (2026-11-12, human)

1. **Note model:** a new *note writer* role draws from the **Strong** slot, like the teacher. The README's open question is settled for notes only; handoffs and the course plan are settled in phase 1.
2. **Rendering:** files are **final when written**. The server renders math with KaTeX and Mermaid with the browser helper that already checks demos. A stored note opens in any browser, and a plain note runs with scripts disabled. Rendering errors go back to the note writer to fix. If the helper can't start, a diagram shows its source with a short notice.
3. **Dependencies:** add the Markdown libraries the chat already uses through Streamdown as direct dependencies, pinned to the versions in `package-lock.json`: `unified`, `remark-parse`, `remark-gfm`, `remark-math`, `remark-rehype`, `rehype-katex`, `hast-util-to-html`. Nothing new is downloaded.
4. **Notes UI:** a **separate notes page** per session, with the note list and "New note" on the left, the selected note on the right, and a link back to the chat.
5. **Interactivity:** an **"Interactive" checkbox**, off by default, beside the instruction box. Only a checked note may contain scripts, and only its frame allows scripts.
6. **Export contents:** learner messages, explanations, questions with the learner's answers and results, math, figures, and images the teacher showed, **plus** the plan map, side-question threads, research and PDF briefs, and interactive demos.
7. **Theme:** files are always a **light, print-friendly page**. The notes page has an "Invert colors" switch like the demo card's, remembered on this device. Downloads stay light.
8. **Export entry points:** a button on the notes page, plus **"Export as HTML…"** in the sidebar's right-click menu beside "Export as Markdown…". Each export is built fresh and downloaded, not stored.
9. **Session deletion:** the delete dialog says the session's notes will be deleted too, and offers **"Download notes"** (one .zip) beside Cancel and Delete.
10. **Regenerate:** opens the note's instruction and Interactive checkbox, prefilled and editable, then rewrites the note from the session as it is now. The current version stays until the new one succeeds. A failure keeps the old version and shows the error.

## Facts this plan relies on (verified 2026-11-12)

- **Markdown export exists.** `GET /api/chats/:id/markdown` (`app/api/chats/[id]/markdown/route.ts`) is built on `sessionMarkdown` (`src/core/session-markdown.ts`), the same engine the extractor reads. Custom markers are invisible to it, so it omits figures, demos, briefs, and side questions. The sidebar menu (`components/sidebar.tsx`) offers Rename, Export as Markdown…, Delete….
- **Where session content lives.** Everything is in the chat record (`data/chats/<id>.json`):
  - Figures (SVG), demos (HTML), and research/PDF briefs are steer markers whose `details.result` holds the payload (`src/core/contracts/jobs.ts`, `SteerDetails`).
  - Learner images are in `imageSnapshots` (base64 PNG/JPEG), and annotation SVGs embed them through `embedLearnerImage`.
  - Side questions are in `sideChats`, each anchored to a teacher message.
  - The chat displays figures as `<img src="data:image/svg+xml,…">`, so figure SVG never joins a page's DOM.
- **Math.** KaTeX 0.18.2 is a direct dependency and runs on the server (`src/core/content-reader.ts` already imports it). Its woff2 fonts total 296 KB (about 395 KB as base64), and its CSS is 25 KB. The chat uses `$…$` and `$$…$$` math with `singleDollarTextMath` (`components/ai-elements/message.tsx`), and `transformMathDelimiters` reads the old `\(…\)` and `\[…\]` forms.
- **Mermaid** renders only in a real browser. `mermaid.min.js` is 3.5 MB. The browser helper (`src/agent/subagents/headless.ts`) runs untrusted HTML in an isolated page (network blocked) and can return a probe value. It is the app's own Electron in `--browser-service` mode, with system Chrome as fallback.
- **The plan map** is hand-built SVG over dagre (`components/plan-block.tsx`). Its layout helpers are pure exports, but the file is marked `"use client"`, so server code can't call them as they are.
- **Worker pieces.** `runSubmitAgent` (`src/agent/subagents/submit-agent.ts`) runs one validated submit call, with a `validate` hook whose error text makes the model retry. Background workers share one request-admission pool (`agent.workerRequestConcurrency`).
- **Model roles.** Roles map to slots in `ROLE_SLOT` (`src/core/settings.ts`). The Strong roster reads "Prober, teacher" in Settings and setup (`components/setup-dialog.tsx`, `components/settings/agent-section.tsx`). Subscription providers block background-purpose requests until the learner enables background use. User-initiated plugin worker tasks already run with purpose `"user"` in the shared pool (`docs/architecture.md`).
- **Electron.** Window-open requests go to `openExternalLink` and are denied (`electron/main.cjs`), so a link opened from a sandboxed frame opens in the system browser. There is no `will-download` handler, so a download shows the normal save dialog (the demo and figure downloads work this way).
- **Zip.** No zip library is installed. `node:zlib` provides `crc32` and `deflateRawSync`.
- **Fonts.** The app's fonts are Source Sans 3 and JetBrains Mono (`next/font/google`, self-hosted at build) and CMU Serif (`public/fonts/`).

## Storage (agent-selected layout; covered by this plan's approval)

- `data/notes/<chatId>/notes.json` is the index: `{ version: 1, notes: [...] }`.
- Each entry has: `id`, `title`, `instruction` (may be empty), `interactive`, `status` (`writing` | `ready` | `failed`), `createdAt`, `updatedAt`, the latest generation's `model` and `usage`, `error` when failed, and `regenerating` (instruction, interactive, startedAt, error) while a rewrite runs or after one fails.
- `data/notes/<chatId>/<noteId>.html` is the final self-contained file. It is written by temp file and rename, so a failed rewrite never touches the old file.
- The index has a version guard like chats: an absent stamp reads as 1, and a newer one is refused.
- The store takes an owner directory, so phase 1 can put unit notes under `data/courses/<courseId>/notes/` without a format change.
- A golden fixture for the index is added under `tests/fixtures/golden-data/`.

## 1. Document template and renderers

**Change:**
- A shared module builds a complete HTML page from a title, a subtitle line (session title, date), and body HTML:
  - one fixed stylesheet: page layout, typography, tables, code, the callout boxes (definition, example, misconception, key idea), figures, `<details>` blocks, and print rules;
  - KaTeX's CSS with its woff2 fonts inlined as `data:` URIs, included **only when the page contains math**;
  - no script unless the page is interactive or embeds demos.
- **Math in HTML bodies:** a renderer walks the text nodes and renders `\(…\)` and `\[…\]` with KaTeX. It skips `pre`, `code`, `svg`, `script`, `style`, `textarea`, and Mermaid blocks, and leaves `$` alone. It parses with `linkedom`, which is already a dependency, and returns each formula that fails, with KaTeX's message.
- **Mermaid:** a new browser-helper call renders a list of Mermaid sources in one isolated page. It uses Mermaid's default (light) theme, `securityLevel: "strict"`, and the font size the chat uses, and returns an SVG or an error for each source. When the helper is unavailable, the caller gets "unavailable", never a thrown error.
- **Figures:** a figure SVG becomes `<img src="data:image/svg+xml;base64,…">`, with learner images embedded first through `embedLearnerImage`. Learner images become `data:` PNG or JPEG images.
- **Links** get `target="_blank" rel="noopener"`. The in-app frame allows popups, so they open in the system browser in the desktop app and in a new tab in browser mode.
- **Packaging trace (not packaging):** add the KaTeX CSS and fonts and `mermaid.min.js` to the standalone server's traced files, so `npm run build` and `scripts/smoke-server.mjs` keep working. No AppImage is built (step 8).

**Checkpoint (human):** before items 2–5, the agent renders a sample note and a sample export from fixtures and shows screenshots of the page, in light and inverted, plus print preview. **Open for the checkpoint:** fonts. The agent recommends embedding the app's fonts (Source Sans 3 for text, CMU Serif for titles, JetBrains Mono for code), so files look like the app everywhere, measuring the added size first. The fallback is system fonts with no added size.

**Tests:**
- template output: math assets only with math, no `<script>` in a plain page, title and subtitle escaped
- math renderer: inline and display, skipped containers, `$` untouched, failed formulas reported
- Mermaid call through the `headlessOverride` fake: SVGs, per-diagram errors, unavailable helper
- figure embedding: annotation with a learner image, and a plain figure

## 2. HTML conversation export

**Change:**
- `GET /api/chats/:id/export.html` returns an attachment named `<session-title-slug>.html`, refusing Practice sessions and unknown chats. *Agent-selected:* the response carries `Content-Security-Policy: sandbox allow-scripts allow-popups`, so the file can't act as the app's origin even if opened by URL.
- A core builder turns the chat record into ordered blocks, using the projections the chat and the Markdown export use. A failed tool call shows nothing, and markers stay invisible. Blocks, in transcript order:
  - **Learner messages**, with citations as readable text.
  - **Teacher prose:** Markdown → HTML through the unified pipeline: GFM, `singleDollarTextMath`, line breaks as in the chat, the same legacy-delimiter reading, and KaTeX. Raw HTML in prose shows as literal text, and remote images are blocked as in the chat. Mermaid fences go through the browser helper. Code blocks are not syntax-highlighted.
  - **Questions:** the question, its options with the learner's choice and the correct answer marked, the result (right, wrong, don't know, skipped), and the learner's thinking and confidence where recorded. Plugin questions use their recorded answer text, as the Markdown export does.
  - **Plan map** where it was presented: the same static SVG as the chat's plan block, light colors. *Agent-selected:* the pure layout helpers move from `plan-block.tsx` into a non-client module that `plan-block.tsx` re-exports, so the chat block and the export share one layout.
  - **Figures and images** the teacher showed, with captions.
  - **Research and PDF briefs:** collapsed `<details>` sections with the brief and its source links (PDF: file name and pages read).
  - **Interactive demos:** each embedded as `<iframe sandbox="allow-scripts" srcdoc>`, sized to its content by the existing demo bridge script. A failed demo shows its failure note.
  - **Side questions:** after the teacher message they were asked about, each thread is a collapsed `<details>` block whose summary is the quoted passage, holding the learner's questions and the answers.
  - **Not included:** model thinking, usage and costs, tool traffic.
- **Sidebar:** "Export as HTML…" sits below "Export as Markdown…" on Teach sessions only. *Agent-selected:* it downloads the way the Markdown entry does. The notes page's button (item 4) shows "Exporting…" while the export builds, since diagrams take a few seconds.

**Tests** (fixture chat records; expected output worked out by hand from the fixture, checked by parsing the result with `linkedom`):
- each block type above, in order
- a failed tool call, a marker, and model thinking produce nothing
- a demo frame has `sandbox="allow-scripts"` and no `allow-same-origin`
- the side-question summary quotes its passage
- the plan SVG matches the chat block's node and edge geometry for the same snapshot
- Practice session → refused; unknown chat → 404
- sidebar entry: present for Teach, absent for Practice

## 3. Note storage and the note writer

**Change:**
- **Role:** `noteWriter` in `ModelRole`, mapped to `strong` in `ROLE_SLOT`, plus a schema-level override like the other background roles. The Strong roster reads "Prober, teacher, note writer" in Settings and setup. `LH_BACKGROUND_CAPTURE` accepts `noteWriter`.
- **Requests:** *agent-selected:* note requests go through the shared worker-request pool and run with purpose **user**, because the learner asked for the note. A note therefore works on a subscription without enabling background use, as user-initiated plugin tasks do.
- **Input:**
  - the session as text: the `sessionMarkdown` engine, extended with `[Figure F1]`, `[Image I1]`, and `[Interactive demo: title]` placeholders at their positions, and each side-question thread after its message;
  - a figure list: id, kind, and the visual's brief or the image caption;
  - the plan's node titles;
  - the instruction.
- **Output:** one `submit_note` call with `title` and `body`. Validation (any failure goes back to the model, up to 3 fix attempts; agent-selected):
  - The body must parse and be non-empty.
  - Refused element: `html`, `head`, `body`, `base`, `meta`, `link`, `iframe`, `object`, `embed`.
  - Refused content: any external resource (`src`, `srcset`, `poster`, `url(…)` to http(s), protocol-relative, or `file:`). Web links in `<a href>` are allowed.
  - In a plain note: no `<script>`, no `<style>`, no `on…` attributes, and no `javascript:` URLs. An interactive note may contain `<script>` and `<style>`.
  - Every `data-figure` must name a listed figure.
  - Every formula must render, and every Mermaid diagram must render when the helper is available.
  - If formulas or diagrams still fail after the fix attempts, the note is saved anyway, and each failed item shows its source in a "couldn't be rendered" box.
  - *Agent-selected:* the body is capped at 500 KB.
- **The file:** the app inserts figures, renders math and Mermaid, and wraps the body in the template. The subtitle line reads "Notes from <session title> · <date>", plus the instruction when there is one.
- **Lifecycle:**
  - *Proposed:* several notes can be written at once, but one note can't be regenerated while it is being written.
  - *Proposed:* Stop works while writing. A new note then shows "Stopped", with Try again and Delete. A stopped regeneration keeps the old version.
  - *Proposed:* after a restart, a note left `writing` becomes failed "Interrupted when the app closed", and an interrupted regeneration keeps the old version and shows that message.
  - *Agent-selected:* a session too long for the Strong model's context window fails with a message naming the model and suggesting a larger-window model. Long sessions are not split.
- **Visibility:** a running note writer appears in Background agents as "Note · <session title>", with its live cost and Stop. A `notes-changed` server event lets open pages refetch.
- **Routes** under `app/api/chats/[id]/notes/`:
  - list notes
  - create (instruction, interactive)
  - get one note's HTML (attachment with `?download=1`, sent with the same sandbox CSP header)
  - regenerate
  - stop
  - delete
  - `archive.zip` of all ready notes (*agent-selected:* a small hand-written zip writer on `node:zlib`, no new dependency)

**Proposed prompt (approve or edit).** System prompt, with `<…>` filled by the app:

> You write study notes for a learner from one of their tutoring sessions. The learner reads the notes later to review what they learned; nobody else reads them.
>
> **What to write.** A condensed lesson, in the order the session taught it:
> - the key definitions, stated precisely;
> - the reasoning steps, so each result follows from what came before it;
> - the worked examples from the session, with their steps;
> - the misconceptions the learner showed, and how each was resolved.
>
> Use only what the session taught. Where the session corrected an earlier statement, write only the corrected version. Leave out small talk and the session's logistics (plans, quizzes as events); keep the knowledge.
>
> **The learner's instruction**, if there is one, follows the session. It can set a focus ("I struggle with X"), narrow the topic ("only Y"), or ask for emphasis ("lots of visuals"). Follow it within this style.
>
> **Format.** Call `submit_note` once, with a short, specific `title` (at most eight words) and the note's HTML `body`. The app places the body in a fixed page template with its own stylesheet, so write only content:
> - headings `h2` and `h3`, paragraphs, lists, tables, `blockquote`, `code`, and `pre`;
> - callout boxes: `<div class="definition">`, `<div class="example">`, `<div class="misconception">`, `<div class="key-idea">`;
> - math as TeX: `\( … \)` inline and `\[ … \]` for display. Inside formulas, write `\lt`, `\gt` and `\&` instead of `<`, `>` and `&`. Never use `$` for math;
> - diagrams: Mermaid source in `<pre class="mermaid">…</pre>`, or inline `<svg>`;
> - figures from the session, by the ids listed after it: `<figure data-figure="F2"><figcaption>…</figcaption></figure>`. The app inserts the image;
> - inline `style` attributes for layout, such as grids and columns.
>
> Everything must be self-contained: no `<style>`, `<script>`, `<iframe>` or `<link>` elements, no event-handler attributes, and no external images, fonts, or stylesheets. Links to web pages are fine.
>
> If the app finds a problem (a formula that doesn't render, a diagram with a syntax error, an unknown figure), `submit_note` returns it. Fix it and submit again.

When Interactive is checked, the self-contained paragraph is replaced by:

> The learner asked for an interactive note. Where it helps them explore an idea (a slider that changes a parameter, a step-through of an algorithm), add small widgets with `<script>` and `<style>` elements. Scripts run in a sandbox with no network access, so they must be self-contained: no external scripts, images, fonts, or stylesheets. Keep the rest of the note static.

The user message holds the session title, the session text in a `<session>` block, the figure list ("none" when empty), and either "Learner's instruction: …" or "No instruction: write the default note."

**Tests** (fake engines and the `headlessOverride` fake; no provider calls):
- store:
  - create, list, and delete
  - the version guard
  - path safety for chat and note ids
  - restart turns `writing` into failed, and an interrupted regeneration keeps the old version
- writer:
  - a scripted submit produces the stored file, title, model, and usage
  - each validation rule makes the model retry with the problem text
  - leftover render failures show as source boxes
  - a plain note refuses scripts; an interactive note keeps them
  - Stop
  - regeneration replaces only after success, and a failure keeps the old file byte for byte
- engine: resolved from the Strong slot through the `noteWriter` role, built with purpose user, and admitted through the worker pool
- routes: each one, the CSP header, and a zip read back with a minimal reader in the test
- activity feed row and `notes-changed` event

## 4. Notes page

**Change:**
- **Route** `/chat/[id]/notes`, for Teach sessions only; a Practice session redirects to its chat.
  - The top bar has the session title in the title font, a muted "› Notes", and "Back to chat" on the right.
  - The sidebar keeps the session highlighted on this page.
- **Session top bar:** a "Notes" chip beside "Plan", with a count when notes exist, opens the page. It is shown at any phase.
- **Left column:**
  - "New note" opens the instruction box. *Proposed placeholder:* "Optional: a focus, a topic, or an emphasis (e.g. “I struggle with eigenvectors”, “only diagonalization”, “lots of diagrams”)". Below it: the "Interactive" checkbox, *proposed label* "Interactive (widgets with scripts)", and a "Write note" button.
  - The note list, newest first. Each row shows the title (or "Writing note…"), date, the instruction's first line or "Default note", and a status for writing, failed, or stopped. Interactive notes get a small tag.
  - "Export conversation (HTML)" at the bottom, showing "Exporting…" while it builds.
- **Right pane:**
  - The selected note in a frame that fills the pane and scrolls inside it. Plain notes use `sandbox="allow-popups allow-popups-to-escape-sandbox"`, interactive notes add `allow-scripts`, and no note gets `allow-same-origin`.
  - Toolbar: "Invert colors" (remembered on this device; agent-selected key `lh:notes-inverted`), Download, Regenerate…, and Delete….
  - *Proposed:* Delete confirms with "Delete this note? This can't be undone."
  - A failed or stopped note shows its error, with Try again and Delete.
  - During a regeneration, the old version stays visible with a "Rewriting…" line and Stop.
  - *Proposed:* an info line under the toolbar gives the instruction, the model, and the latest generation's cost when known.
- **Empty state:** *proposed wording* "No notes yet. Write one from this session at any time."

**Tests:**
- render tests for:
  - the list states
  - the chip count
  - the frame's sandbox flags for plain and interactive notes
  - the regenerate form prefilled
  - Practice redirect
- **Browser check (agent):** dev server on a scratch profile (`LH_DATA_DIR` and `LH_AUTH_FILE` in the scratchpad), with a fixture session and pre-seeded notes.
  - Check the page and chip, viewing, the invert switch, downloads, delete, both export entry points, and the delete dialog.
  - *Agent-selected, if it works without new dependencies:* run a real generation end to end against a local fake OpenAI-compatible endpoint (the custom-endpoint feature allows keyless local servers) that returns a scripted `submit_note`. Otherwise generation is covered by unit tests only.
- **Human check:** one real note from a real session on the human's own provider, plus opening a downloaded note and an export outside the app.

## 5. Session deletion

**Change:**
- Deleting a session deletes `data/notes/<chatId>/`. A running note writer for that session is stopped first.
- When notes exist, the delete dialog adds "This also deletes its <n> notes." and a "Download notes" button. The button saves `archive.zip` as `<session-title-slug>-notes.zip`, and the dialog stays open.
- *Proposed wording* is as quoted. The dialog's existing graph checkbox is unchanged.

**Tests:**
- deletion removes the notes folder and leaves other sessions' notes alone
- a running writer is stopped
- the dialog shows the line and button only when notes exist

## 6. Docs

- Fork README:
  - a decision entry for this interview
  - the "Still open" note-model question marked settled for notes
  - roadmap step 3 marked done when it lands
  - new pending human checks
- `docs/architecture.md`: the storage table row and a background-work note for the note writer.
- `docs/development.md`: `LH_BACKGROUND_CAPTURE` roles.
- `src/agent/prompts/README.md`: where the note writer's prompt lives.

## Finishing

- **Order:** one commit per item, in order. Item 1's checkpoint is approved before item 2 starts.
- **After each item:** the required gate (typecheck, tests, lint).
- **After items 1 and 3:** also `npm run build` and `scripts/smoke-server.mjs`.
- **Completion report per item:** what changed, checks and results, human checks still owed, and agent-selected choices.
- **Safety:** nothing reads or writes `~/.config/LearnHarness` or `~/.config/LearnHarness-Fork`. Manual runs use a scratch profile. Tests use fakes and fixtures only.

## Outcome

### Item 1 (2026-11-13)

- **Checkpoint, decided (human):** the look was approved as shown: the note, the export blocks, and their wording. That covers the callout labels "Definition", "Example", "Misconception", "Key idea"; the failure boxes "This formula couldn't be rendered." and "This diagram couldn't be rendered."; the notice "Diagram not drawn: the diagram renderer wasn't available when this page was made."; and the export labels "You", "Check question" with a result badge, "your answer" / "correct answer", "Interactive demo", "Side question on “…”", "Research brief · …", and "Plan" under the plan map. The samples used the golden teach fixture's real figure, demo, plan, quiz, and research brief, with Mermaid drawn by the app's own Electron helper.
- **Fonts, decided (human):** files embed the app's faces. Source Sans 3 (Latin) is on every page, about 38 KiB. CMU Serif Bold, re-encoded to WOFF2 without subsetting so its OFL reserved name stays valid, is on every page, about 111 KiB. JetBrains Mono (Latin) is only on pages with code, about 53 KiB. A file grows by 148 KiB, or 201 KiB with code. The options shown were the shipped TTF (289 KiB), a renamed Latin subset of CMU (38 KiB), Source Sans 3 Black titles, and system fonts. The files, their licenses, and their sources are in `src/agent/document/fonts/`. For scale, KaTeX adds about 360 KiB to any page with math. The measured sample note was 621 KiB embedded and 420 KiB with system fonts.
- **Built:**
  - `src/core/document/`: the template, stylesheet, math, body preparation, and figures.
  - `src/agent/document/`: the asset loader and `renderDocumentFile`.
  - `renderMermaid` on the browser helper.
  - Trace includes for KaTeX's CSS and fonts, `mermaid.min.js`, and the document fonts.
- **Agent-selected:**
  - Pages with no script and no frame carry a Content-Security-Policy meta (`default-src 'none'`, inline styles, `data:` images and fonts). They stay inert even when opened from disk.
  - Rendered KaTeX and Mermaid markup is spliced in by token after one `linkedom` parse, so it never round-trips through the parser.
  - Adjacent text nodes are merged first, because the parser splits text at entities (`\(a &lt; b\)`). A test caught this.
  - An unclosed `\(` or `\[` counts as a failed formula ("No closing \)").
  - In-page `#` links stay in the page.
  - Mermaid measures labels in the document's own embedded text font. A diagram keeps Mermaid's natural-size cap, so small diagrams are not stretched to the column.
  - The export block styles (learner turns, question cards, plan, demo frame, side questions, briefs) are in the shared stylesheet, so item 2 only builds the markup.
  - `scripts/smoke-server.mjs` now checks that the document assets are in the standalone payload.
- **Checks:**
  - Typecheck passed.
  - Lint passed with the one inherited warning.
  - Tests: the full run gave 5339 pass, 1 fail, 4 skipped. The failure was `tests/provider-tracing.test.ts`, which pins the include list; it was updated and passes on its own.
  - `npm run build`, `scripts/build-server.mjs` and `scripts/smoke-server.mjs` passed. The smoke reported 5 document files and 20 KaTeX fonts in the payload.
  - The real `renderMermaid` was exercised by the sample run, not by the suite (the suite never drives the live helper).
- **Known limits:**
  - An interactive demo frame prints only what fits on one page.
  - Including only the KaTeX font families a page uses would roughly halve its 360 KiB. This is not planned.
- **Found, inherited, not fixed:** `electron/main.cjs` sets the app's user-data folder before the `--browser-service` branch. A browser helper spawned in dev (demo checks, and now Mermaid) therefore keeps its Chromium profile in `~/.config/LearnHarness-Fork`. The agent's runs set `XDG_CONFIG_HOME` to a scratch folder.

### Item 2 (2026-11-13)

- **Built:**
  - `GET /api/chats/:id/export.html` (`app/api/chats/[id]/export.html/route.ts`) on `conversationExportHtml` (`src/server/document-export.ts`).
  - The core builder `conversationDocument` (`src/core/document/conversation.ts`) and the Markdown reader `markdownToHtml` (`src/core/document/markdown.ts`).
  - The static plan map `planMapSvg` (`src/core/document/plan-map.ts`).
  - "Export as HTML…" in the sidebar menu for Teach sessions.
  - Dependencies: `unified` 11.0.5, `remark-parse` 11.0.0, `remark-gfm` 4.0.1, `remark-math` 6.0.0, `remark-rehype` 11.1.2, `rehype-katex` 7.0.1, and `hast-util-to-html` 9.0.5, added as exact direct dependencies. The lockfile change is only the root dependency list.
- **Agent-selected:**
  - **Transcript source and order:**
    - Blocks come from the chat's own projection (`projectView`).
    - Side threads are placed by `sideEntryPoints`, at the same segment boundaries where the chat shows their button.
    - The plan helpers moved to `src/core/plan-layout.ts`, and the demo bridge to `src/core/demo-bridge.ts`. Both are re-exported from their components unchanged. The barrel exports the plan's node type as `PlanLayoutNode`, because the graph layout already owns `LayoutNode`.
  - **Learner text:**
    - Shown verbatim, as in the chat: never read as Markdown or math.
    - Tutor quotes appear as quotes labeled "Tutor quote", with "Comment:".
    - Images attached to learner messages and answers are included.
  - **Question labels:**
    - Each label is the chat's label plus "question": "Check question", "Prediction question", "Probe question", "Recall question", "Explain question". Ask questions are labeled "Question".
    - Result badges: "Right", "Wrong", "Don't know", "Skipped".
    - Other wording: "Confidence: N%", "Your thinking while reading:", "Your thinking:", and "Your answer: “…”".
    - "Why" is collapsed, as in the chat, and an explain question shows "The answer".
  - **Briefs and failures:**
    - A PDF brief's summary reads "PDF brief · <file> (pages 3–5, 9)".
    - Only http(s) research sources become links.
    - A failed figure, demo, research, or PDF job shows a muted failure note.
    - Plugin worker results are left out.
  - **Side threads:** the summary quotes the first attached passage, or the anchor block, cut at 140 characters.
  - **Dates:** the subtitle's date is the session's creation date.
  - **Markdown:** links to anything other than web, mail, or in-page targets lose their target and keep their text.
  - **The route:**
    - A Practice session gets 400 with "Practice sessions have no HTML export."
    - Responses carry `Content-Security-Policy: sandbox allow-scripts allow-popups`, `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`.
  - **Sidebar:** the menu item is a small exported component (`ExportHtmlItem`), so it can be render-tested.
- **Checks:**
  - Typecheck passed. Lint passed with the one inherited warning.
  - Tests: 5357 pass, 0 fail, 4 skipped, including the new `tests/conversation-export.test.tsx` and `tests/conversation-export-route.test.ts`. The plan-map test compares node and edge geometry with the chat's `PlanBlock` for the same snapshot.
  - The golden teach fixture exports with 10 questions, 2 plan maps, a figure, the demo frame (auto-sized to 1212 px in a browser), the research brief, and the failed PDF job's note.
- **Not yet checked:** the sidebar entry in a running app is part of item 4's browser check.

### Item 3 (2026-11-13)

- **Decided (human), replacing a wrong fact:** only the setup dialog listed the Strong slot's roles ("Prober, teacher"). It now reads "Prober, teacher, note writer". Settings → Agent keeps its descriptive "The main model for your sessions", matching its Cheap and Vision rows.
- **Built:**
  - `src/store/notes.ts`, the store, at `data/notes/<chatId>/` (`PATHS.notes`).
  - `src/agent/subagents/note-writer.ts`: the writer, with the approved prompt verbatim.
  - `src/core/document/note-source.ts`, the session input, and `note-body.ts`, the body rules and figure insertion.
  - `src/server/notes.ts`, the lifecycle service, and `src/server/zip.ts`, the archive writer.
  - Routes under `app/api/chats/[id]/notes/`: list, create, view or download, regenerate, stop, delete, `archive.zip`.
  - A "Note writer" row in Background agents, the `notes-changed` event, and a golden index fixture.
  - The `noteWriter` role: `ROLE_SLOT` maps it to Strong, plus the schema-level override `agent.models.noteWriter`. It also appears in `/api/models` `rolePins` and in the regenerated plugin API reference (`docs/plugin-api/`).
- **Agent-selected:**
  - **Storage:**
    - A stopped note is stored as `failed` with `error: "Stopped"` and an added `stopped: true`, so the page can tell it from a failure.
    - An index that is newer or damaged is refused (HTTP 409) and never rewritten.
  - **Lifecycle:**
    - "Try again" on a failed or stopped note reuses the regenerate route, which rewrites the note in place.
    - Interruptions are settled on read: a note left `writing`, or a rewrite with no running writer in this process, becomes "Interrupted when the app closed".
  - **The writer:**
    - The user message carries the session title, `<session>…</session>`, the plan topics, the figure list ("F1 (figure): <brief>", "I1 (image): <caption>"), and the instruction line.
    - A session that is too long is caught before any request. The estimate is characters ÷ 4, plus a reserve for the reply.
    - `runSubmitAgent`'s `validate` hook may now be async.
    - `sessionMarkdown` gained an optional per-message hook; the Markdown export and the extractor are unchanged.
  - **Body rules:**
    - External loads are checked on `src`, `srcset`, `poster`, `data`, `background`, `action`, `formaction`, and non-link `href`, and in CSS `url(…)` and `@import`.
    - An interactive note may also use event handlers and `javascript:` URLs, since its scripts run anyway.
    - The title must be non-empty and at most 120 characters.
    - A note gets up to 4 model turns: the first submission plus 3 fixes.
  - **Interactive notes:** they carry a policy that allows their own inline scripts and blocks all network, so the prompt's "no network access" holds in any browser.
  - **Routes:** create and regenerate answer 202. A Practice session gets 400, no Strong model gets 503 (`models_not_configured`), and stopping when nothing runs gets 409.
  - **The archive:** it is named `<session-slug>-notes.zip`, and its files are named after the note titles, with `-2`, `-3` on clashes.
- **Checks:**
  - Typecheck passed. Lint passed with the inherited warning.
  - The full suite gave 5387 pass, 1 fail, 4 skipped. The failure was the timing-sensitive `tests/atomic-write.test.ts` "folders in the way fail at once"; it passed 23/23 when rerun alone.
  - New tests: `tests/notes.test.ts` (29) and a dock row case in `tests/render-activity-dock.test.tsx`.
  - Updated tests: the golden fixtures, role lists, and the plugin API reference.
  - `npm run build`, `scripts/build-server.mjs` and `scripts/smoke-server.mjs` passed. The build's two "dynamic filesystem access" warnings are inherited (same call sites in item 1's build); only their import traces now include the new routes.
- **Not yet checked:** a real generation on a provider (item 4's end-to-end check and the human check).

### Item 4 (2026-11-13)

- **Built:**
  - `/chat/[id]/notes` (`app/chat/[id]/notes/page.tsx`, `components/notes-page.tsx`).
  - The "Notes" chip with its count (`components/notes-chip.tsx`) beside "Plan", on Teach sessions at any phase.
  - The sidebar keeps the session highlighted on its notes page (`isSessionPath`).
  - The proposed wording as planned: the placeholder, the "Interactive (widgets with scripts)" label, the empty state, and the delete question.
- **Agent-selected:**
  - **Wording the plan didn't specify:**
    - List statuses: "Writing…", "Failed", "Stopped", "Rewriting…". A note without a title shows "Untitled note".
    - The writing pane shows "Writing note…" with Stop. A failed note shows its error, or "Stopped.", with Try again and Delete.
    - A failed rewrite reads "The rewrite failed: <error> The current version is kept."
    - Buttons: "Write note", "Regenerate", "Cancel".
    - The info line is "“instruction” · model · cost", and the cost is left out when unknown, as for custom endpoints.
    - The switch's accessible name is "Invert note colors".
  - **Implementation:**
    - The frame's URL changes with each version, so a rewrite reloads it.
    - The list route returns each note's `costUsd`.
    - The response sandbox policy for notes and exports now includes `allow-popups-to-escape-sandbox`. Otherwise a web link opened from a plain note in browser mode would open with its site's scripts disabled.
- **Checks:**
  - Typecheck passed. Lint passed with the inherited warning. Tests: 5399 pass, 0 fail, 4 skipped, including `tests/notes-page.test.tsx` (11).
  - **Browser check** (dev server on a scratch profile with the golden Teach and Practice sessions):
    - Notes were really generated end to end through a local fake OpenAI-compatible endpoint, configured as a keyless custom endpoint.
    - The chip and its count, the Practice redirect, and the Teach-only sidebar entry all behaved as specified.
    - Writing showed the "Note · <session>" row in Background agents. Stop, Try again, Regenerate (prefilled; the old version stays visible until the new one lands), and an interactive note in a script-enabled frame all worked.
    - The invert switch persisted across reloads. Download headers, the delete dialog, and both export entry points worked.
- **Found, inherited, not fixed:**
  - In `next dev`, React seals ref objects during server rendering, so `components/chat.tsx` (`inputViewReader.changed = …`) throws. Every chat page answers 500 and then renders on the client. Production builds are unaffected.
  - In `next dev`, the browser helper can't locate the dev Electron binary (Turbopack reports module paths as `/ROOT/…`), so it falls back to system Chrome. On this machine, without `CHROME_PATH`, demos can't be checked and note diagrams show their source with the "renderer wasn't available" notice; that fallback was observed working. With `CHROME_PATH` set to a Chromium, diagrams rendered. The packaged app runs the helper from its own executable.
- **Owed (human):**
  - A real note from a real session on your provider.
  - Opening a downloaded note and an export outside the app.
  - In the desktop app, clicking a web link in a note: it should open in the system browser.

### Item 5 (2026-11-13)

- **Built:**
  - Deleting a session removes `data/notes/<chatId>/` once its record is gone, for both delete paths (the dialog's and source deletion's), through `finishChatRecordDeletion`. The session's running note writers are stopped first. A stopped writer finds no index and writes nothing back.
  - With notes present, the delete dialog adds the planned line and a "Download notes" link to `archive.zip` (saved as `<session-slug>-notes.zip`). The dialog stays open.
- **Agent-selected:**
  - One note reads "This also deletes its 1 note." (the planned wording, singular).
  - The dialog fetches the note count when it opens.
  - "Download notes" sits at the left of the Cancel and Delete row.
  - Note writers don't block deletion, unlike background jobs; they are stopped.
- **Checks:**
  - Typecheck passed. Lint passed with the inherited warning.
  - Tests: 5401 pass, 1 fail, 4 skipped. The failure was the timing-sensitive `tests/atomic-write.test.ts` "folders in the way fail at once" (a 50 ms bound, run while the dev server was up); it passed 23/23 alone, twice.
  - New tests: 2 deletion cases in `tests/notes.test.ts` and a dialog case in `tests/session-context.test.tsx`.
  - Browser check: the dialog showed "This also deletes its 1 note.", "Download notes" saved a valid zip with the dialog still open, and Delete removed the session and its notes folder.

### Item 6 (2026-11-13)

- **Fork README:**
  - A decision entry for this plan, including the checkpoint and the setup-wording choice.
  - The note-model question marked settled for notes; handoffs and the course plan stay open.
  - The feature status updated, and roadmap step 3 marked done.
  - Step 3 pending human checks.
  - The inherited dev-only issues listed under Open questions.
- **`docs/architecture.md`:** the notes storage row, the notes index's version guard, a "Notes and conversation exports" background-work section, and the note writer in the shared worker pool.
- **`docs/development.md`:** `noteWriter` added to the `LH_BACKGROUND_CAPTURE` roles.
- **`src/agent/prompts/README.md`:** where the note writer's prompt lives (`subagents/note-writer.ts`). It is not a Settings → Prompts segment.
- **Checks:** with the dev server stopped, typecheck passed, lint passed with the inherited warning, and tests gave 5402 pass, 0 fail, 4 skipped.

## Review repairs — approved by the human 2026-11-13

The human approved the repair plan for findings 1–8. These decisions supersede the conflicting agent-selected choices recorded above; approval is recorded in the [fork README](../README.md#notes-and-conversation-export-course-phase-0).

- Publish a new immutable HTML revision before atomically switching the version-2 notes index's optional `htmlRevision` pointer. Read version-1 files until they are rewritten. The index never uses the in-place write fallback. A storage failure before the index commit preserves the previous file and metadata. Agent-selected: UUID revision names; remove superseded or unpublished revisions on a best-effort basis, and delete any leftovers with the note.
- Include unanswered built-in and plugin questions in export, labeled "Not answered". Show their public prompts and visible context/options; never include private plugin payloads, keys, explanations, or correctness before submission. Agent-selected: use the chat's deterministic quiz shuffle for pending options.
- Keep plugin answer reading thoughts and all attached image channels in HTML, and structured learner option labels and both modern thinking channels in Markdown and note input.
- Reject relative and other non-embedded HTML/CSS resources, while allowing data URIs and local SVG references. Validation returns the problem to the writer.
- Preserve full learner instructions. After a failed DELETE, retain the note and show the server error or the existing connection-error wording. A 404 confirms that the note is already absent.
- Ratify all note-page wording listed in item 4 above and the persisted `stopped: true` field. Replace the unapproved 120-character title limit with the prompt's eight-word rule.

**Verification:**

- Full suite: 5,419 passed, 0 failed, 4 skipped. The 88 focused notes, export, Markdown, and UI cases passed; the notes file passed again (41 cases) after the final SVG-resource check.
- Typecheck passed. Lint passed with the documented inherited warning in `tests/source-name-ui.test.tsx`. A repeat initially raced plugin staging's temporary files; rerunning after staging passed.
- The regression cases were also run against an isolated archive of the original code: 11 failed, including index-write/rename publication failures, lost plugin content, pending questions, deletion failures, answer formatting, instruction truncation, and title validation. The original HTML-rename failure case already passed.
- Real browser, synthetic scratch profile: disconnected and HTTP-500 deletion kept the note and its frame with an error visible; successful deletion removed both. A downloaded export opened from disk with the pending quiz's prompt and options, "Not answered", and no answer key or explanation.
- Final implementation review and `git diff --check` passed. No paid providers, real sign-ins, or human learning data were used. Real-provider generation and desktop behavior were not exercised by these repairs.

## Follow-up coverage and development repairs — approved 2026-11-13

The human approved the remaining scope after the first repair pass. The preceding product/storage decisions and Markdown formatter correction remain approved; no further dependencies or product/storage changes are introduced.

- Extended export checks for right, don't-know and skipped results, prediction/probe questions, and answered recall/explain questions. The first repair pass already added plugin answers/images/thoughts and pending questions.
- Added stopped-regeneration and simultaneous-generation checks, plus a note-source fixture asserting side-thread placement, shown-image identity, plan titles, selected labels and both modern thinking channels.
- Added real child-process interruption at both sides of the index rename: staging without commit preserves the old version and recovers the rewrite as interrupted; a committed index selects the complete replacement even when cleanup never ran.
- Fixed the development issues in the requested order: helper profile isolation, sealed-ref SSR, then development Electron resolution. Agent-selected: the parent owns the temporary profile through `LH_BROWSER_SERVICE_PROFILE` and cleans after child exit; Chromium may flush after Electron's quit event. Both `userData` and `sessionData` are set before readiness. Bridges are complete ordinary objects held inside React refs. Development resolution anchors package lookup and the app argument to the real project working directory; packaged servers self-execute and Chrome remains the fallback.
- Repeatable live checks: `scripts/smoke-browser-service.mjs` exercises real helper/profile/disconnect behavior, and `scripts/smoke-dev-runtime.mjs` starts the standard dev script against synthetic data and temporarily adds/removes a probe route for the real bundled helper. It checks SSR, Mermaid and a demo control's independently expected result (42), without `CHROME_PATH`.

**Verification:**

- Full suite: 5,435 passed, 0 failed, 4 skipped. Typecheck passed. Lint passed with the inherited warning in `tests/source-name-ui.test.tsx`.
- The new SSR regression reproduced `Cannot add property changed, object is not extensible` before the fix; it now passes, together with all four production Chat/plugin draft-notification cases. The missing export/lifecycle/source cases passed (69 focused cases).
- Real Electron profile smoke passed for regular and dev launches: both profile paths were temporary before readiness, synthetic page execution worked, regular/dev/upstream scratch profile locations stayed absent, and parent-disconnect shutdown/cleanup passed. Helper lifetime/retirement unit cases passed; resolver tests also passed under Electron's own Node runtime.
- `smoke-dev-runtime.mjs --hold` passed inside `nix develop`: Chat/Dock SSR answered 200, real Mermaid produced SVG, and a demo button produced 42 without `CHROME_PATH`. A real browser rendered the lesson and pending dock and retained typed answer text. The temporary route and scratch server were removed afterward.
- `npm run build`, the provider-runtime smoke, `build-server.mjs`, and `smoke-server.mjs --electron --isolated` passed. The server served its APIs, document assets and plugin proofs from a copy outside the source checkout. Provider initialization reported zero network attempts. The build retained the inherited `pdf-read.ts` dynamic-filesystem tracing warning.
- Final diff review and whitespace checks passed. No real learning data, paid providers, real sign-ins, package installs, releases or AppImage packaging were used. The human subsequently authorized committing these repairs, merging the feature into `main`, and deleting fully merged branches.

## Not in this plan

- Phase 1 pieces: unit notes, the course Notes tab, the "Complete unit" dialog's note and export offers.
- Notes or HTML export for Practice sessions.
- Renaming notes, editing a note by hand, and syntax highlighting in exports.
- A notes archive that keeps notes after their session is deleted (discussed in the interview; the zip download was chosen instead).
