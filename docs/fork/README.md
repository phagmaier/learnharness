# Fork overview

This is a personal fork of [LearnHarness](https://github.com/amosblomqvist/learnharness), forked at upstream v0.6.1 (`cb25c8e`). Coding agents write the code; the human owns design decisions (see [AGENTS.md](../../AGENTS.md#decision-authority)).

This page is the fork's source of truth for goals and decisions. Upstream docs elsewhere in `docs/` describe the inherited code; where a decision here conflicts with them, this page wins and the upstream doc should be updated when the change lands.

- [NixOS development setup](nixos.md)

## Goals

The human plans changes in the areas below; the designs are under [Feature designs](#feature-designs) and the build order is the [Roadmap](#roadmap-approved-by-the-human-2026-11-12).

- Teaching behavior (probing, planning, teaching, practice)
- UI / UX
- New features and plugins
- Platform and providers

## Decisions

Each entry records who made the call. *Agent-selected* means the human delegated the choice.

### Fork model: independent, but merge-friendly — 2026-11-12, agent-selected

The fork diverges wherever its goals need it: fork-specific `AGENTS.md`, docs, and tooling. The `upstream` remote stays configured so upstream fixes can be merged or cherry-picked. Avoid churn that only creates conflicts (reformatting upstream docs, swapping the package manager, mass renames).

**Why:** the planned changes are not yet known. Staying mergeable keeps both paths open at little cost. Merging never silently overwrites fork edits; overlapping edits surface as conflicts. Revisit once the scope of the changes is clear.

### Agent decision authority — 2026-11-12, human

Agents ask before deciding product behavior (UX, prompt and teaching wording, data formats, settings, defaults, dependencies, scope). They decide implementation details themselves and report them. This replaces upstream's stricter "ask about anything ambiguous" rule.

### Package manager stays npm — 2026-11-12, agent-selected

Keep upstream's npm and `package-lock.json`. Switching to pnpm would conflict on every upstream lockfile change and touches CI, scripts, and plugin setup for no functional gain.

### Runtime pinned in mise — 2026-11-12, agent-selected

[mise.toml](../../mise.toml) pins Node 26.13.0 (CI uses Node 26) and sets `NEXT_TELEMETRY_DISABLED=1`, matching CI.

### Electron libraries come from a flake dev shell — 2026-11-12, human

[flake.nix](../../flake.nix) supplies Electron's native libraries through `NIX_LD_LIBRARY_PATH`. Node still comes from mise. Details: [nixos.md](nixos.md).

### Fork identity, packaging, and CI — 2026-11-12

- *Human:* the fork's app is named **LearnHarness Fork**, with its own data folder (`~/.config/LearnHarness-Fork`) and launcher. On first launch, a one-time copy brings over the upstream app's learning data, leaving the original untouched as a backup. Upstream is uninstalled when the human is ready, and neither app can corrupt the other's data.
- *Human:* the fork is packaged for the human's personal NixOS use only. The packaging method is chosen at planning time; today's upstream install is an AppImage in a Nix FHS wrapper.
- *Agent-selected (human may veto):* the packaged fork disables upstream's auto-updater, whose feed points at upstream's GitHub releases and would replace the fork with upstream builds.
- *Human:* keep CI's quality job (typecheck, tests, lint) and the Linux standalone build. Drop the macOS and Windows build jobs, `release.yml`, and `notify-website.yml`.

## Feature designs

### Courses, units, and notes

**Status:** designed 2026-11-12; no implementation plan yet. Build order starts with phase 0 (notes and export).

**Problem (human):** everything happens in one chat. For large subjects (full-stack development, AI, linear algebra), one chat is wasteful and hard to review.

**Proposal (human, refined with agent):** a course is a sequence of units; each unit is its own session (probe → plan → teach). Finishing a unit produces a handoff and points to the next unit. Progress is tracked in files. Units can end in a mastery gate, with a manual override. Competency is tracked to find weak points.

**Current behavior (verified in code/docs):** one session holds one probe → plan → teach cycle; the plan map is per session. The knowledge graph persists across sessions but records objective propositions, not learner understanding. Upstream removed its mastery-level model and left the "learner state model" undesigned (`docs/archive/vision.md`). Practice outcomes are session-only evidence. Plugins cannot create or run sessions, so this is a core change.

**Decided:**
- *2026-11-12, human:* the unit list is planned up front by a course-level probe and plan. The learner reviews and edits it before unit 1, and it can be revised as units reveal what the learner knows.
- *2026-11-12, human:* starting a course opens a separate setup session: a broad, coarse probe across the field, then the proposed unit list for the learner to edit. Approving it creates the course, and unit 1 opens as a fresh session. Each unit still runs its own detailed probe.
- *2026-11-12, human (revised same day):* when the teacher says the unit's goal is reached, nothing closes. A "Complete unit" button appears and stays available. The learner can keep asking final questions, ask for a review quiz, or ask for notes. A review quiz inside the unit counts as ordinary checks; a real exam is the phase-2 gate, run as a separate assessment session. The learner can also complete a unit early at any time, and an early finish is recorded as such. Confirming writes the handoff and offers to open the next unit.
- *2026-11-12, human (revised same day):* the handoff is a short briefing for the next unit's agent, not a log. It lists what was covered and looks solid, what is shaky (one line each, with the reason), which misconceptions were repaired, and anything carried forward. It is derived from the course record's evidence, plus teacher observations labeled as model-written. Raw evidence stays in the course record (overview page, phase 3) and is never sent to the agent directly. **Why:** in phase 1 completing a unit is a judgment, not proof; the next unit's confirming probe needs to know what is shaky; and learners forget between units. Once phase-2 gates exist, a passed gate earns "solid", and handoffs shrink.
- *2026-11-12, human:* **notes** are for the learner; handoffs are for the agent.
  - *On demand only.* Notes are never generated automatically. The learner picks a chat (a unit in any state, or a standalone Teach session) and asks for a note at any time. A background worker writes it from that chat. Practice sessions are excluded.
  - *Many per chat.* Each generation creates a new titled note that keeps its instruction. Each note can be viewed, downloaded, regenerated, or deleted on its own. Unit notes appear in the course's Notes tab, grouped by unit; standalone notes are shown on their session.
  - *Style.* One unified default: a condensed lesson in learning order, with key definitions, the reasoning steps, worked examples from the session, and the misconceptions met and how they were fixed. An optional free-text instruction is appended to the prompt: a focus ("I struggle with X"), a single topic ("only Y"), or emphasis ("lots of visuals"). The style stays the same.
  - *HTML.* The model writes only the body, and the app wraps it in a fixed template (shared stylesheet and layout, bundled KaTeX) so every note looks the same. Notes are shown in a sandboxed frame like interactive demos (`components/artifacts/demo-card.tsx`), and Download saves the same self-contained file.
  - *Visuals and scripts.* Anything static HTML can show: inline SVG, CSS layouts, tables, math, Mermaid, and figures already made during the session. By default there are no model-written scripts (the template's own scripts may render math and Mermaid). Interactive widgets are included only when the instruction asks for interactivity, inside the same sandbox.
  - *Storage.* Every course has its own directory under the data folder holding its record, `progress.md`, and notes. Each standalone session with notes gets its own notes directory. Exact paths and filenames are agent-delegated.
  - *Reversal.* The agent first proposed Markdown with HTML only as an export, claiming model-written HTML was unsafe in Electron. The existing sandboxed demo frame showed that claim was weak, and the human prefers HTML.
- *2026-11-12, human:* the "Complete unit" confirmation dialog has optional checkboxes, all off by default: "Generate a note" (with an optional instruction box) and "Export full conversation". Skipping them changes nothing; both stay available later from the unit.
- *2026-11-12, human:* "Export full conversation" produces a self-contained HTML file in the notes template: learner messages, explanations, questions with the learner's answers and results, math, and the session's figures. It is available for any teaching session at any time, not only at unit completion.
- *2026-11-12, human:* units have a suggested order, and each lists the earlier units it builds on (prerequisites). The learner normally goes in order but may skip ahead, with a warning when a prerequisite is unfinished. Prerequisites also decide which handoffs a unit receives.
- *2026-11-12, human:* a unit's agent receives the full unit list with statuses (one line per unit), plus the complete handoffs of its direct and indirect prerequisites. Unrelated units appear only as their one-line status.
- *2026-11-12, human:* after setup, the teacher may propose course changes at a unit's end (insert, merge, reorder, or drop units), shown as a reviewable diff the learner accepts or rejects. The learner can also edit the unit list directly at any time from the course view.
- *2026-11-12, human:* a completed unit's main lesson is closed, so its handoff stays accurate, but the chat remains readable. Side questions on its passages still work. "Practice this unit" starts a Practice session from the unit's material. "Reopen unit" resumes teaching, and completing it again rewrites the handoff.
- *2026-11-12, human:* course data is a JSON record under the data folder (units, statuses, handoffs, evidence), like the other stores. A readable `progress.md` per course is regenerated on every change for reading outside the app; edits to it are never read back.
- *2026-11-12, human:* "Course" becomes a third start option beside Teach and Practice. Each course appears in the session sidebar as a collapsible group holding its setup session and units. Clicking the course opens an overview page: the unit list with statuses and prerequisites, handoffs, pending revision proposals, and buttons to start, open, or practice units. Standalone Teach and Practice sessions are unchanged.
- *2026-11-12, human:* unit sessions are extracted into the graph like any teaching session. Their graph sources are placed automatically in a folder named after the course, so a whole course or a single unit can be selected as practice material. The setup session's broad probe is not extracted.
- *2026-11-12, human:* deleting a course mirrors session deletion. One confirmation deletes the course record, its `progress.md`, its setup session, and all unit sessions. A checkbox, off by default, also removes their graph contributions.
- *2026-11-12, human:* a unit's probe briefly re-checks what prerequisite handoffs mark shaky, or what the unit leans on most (a question or two, not a full re-probe). It trusts what is marked solid, then probes the unit's new material as usual. The unit's plan may include repairing shaky prerequisites.
- *2026-11-12, human:* the course record stores evidence events stamped with unit, plan node, and time: every predict/check result (right, wrong, or don't know) with stated confidence; unit started, completed (confirmed or early), and reopened; course revisions accepted or rejected; and outcomes of "Practice this unit" sessions linked to the unit. All of it is computed from existing session records, with no extra model calls.
- *2026-11-12, human:* build order: **phase 0**, on-demand HTML notes and HTML conversation export for standalone Teach sessions, which also builds the shared HTML template; then three course phases: (1) course, units, handoff, progress tracking, plus unit notes, the course Notes tab, and the completion-dialog offers; then **books** (see [Books](#books)); then (2) mastery gates with manual override; (3) competency and weak points, designed in detail once phases 1–2 produce evidence. Phase 1 must still record the evidence phase 3 will need.

**Still open (settle when planning the relevant phase):**
- Which model slot (Strong or Cheap) generates notes, handoffs, and the course plan.
- Phase 2 gate design: format, pass criteria, retries, override flow.
- Phase 3 competency model and weak-point views.

**Agent recommendations (not yet accepted):**
- Run gates as a separate assessment reusing the practice problem/conclude machinery; record overrides as overrides.
- Store evidence events and derive competency, rather than storing model-assigned scores.

### Books

**Status:** designed 2026-11-12; no implementation plan yet. Built right after course phase 1 (see build order below).

**Problem (human):** to study a specific text (e.g. Hegel's *Phenomenology of Spirit*), the learner wants to add the book. The whole book should never sit in context, but it should be reachable when needed.

**Current behavior (verified):** a session can receive a PDF path. The teacher dispatches a `pdf` job (`src/agent/subagents/pdf-reader.ts`) with a question; for long PDFs it keyword-searches, reads only the matching pages, and returns a brief with page citations. Nothing persists between questions: no table of contents or book structure, and every question re-triages from scratch. EPUB is unsupported. No embeddings exist anywhere in the app. Graph import ("Extract files") turns text into propositions but discards the text itself.

**Decided (2026-11-12, human):**
- *Book map, not embeddings RAG.* A one-time import converts the book to text and splits it along its own structure (parts, chapters, sections, numbered paragraphs such as the *Phenomenology*'s §1–§808). The Cheap model writes a short summary and key terms for each section, producing a compact hierarchical map. Agents receive the relevant part of the map, pull exact text with a "read section" tool, and fall back to keyword search. **Why:** embeddings need an extra paid provider (neither the ChatGPT subscription nor Claude Code offers one) plus a vector store, and similarity-chunk retrieval loses a passage's place in the argument, which is the meaning in a text like Hegel's.
- *Formats.* PDF (text layer only, no OCR), EPUB (new), and plain text/Markdown.
- *Library.* A Books library holds each imported book's copy and map in the data folder. The map is built in the background at import. A library book is attached when starting a course or a Teach session; one book can serve several courses and sessions without re-import.
- *Course from a book.* When a course is started with a book, setup proposes units that follow the book's structure, still adjusted by the probe (e.g. adding a background unit on Kant). Each unit is tied to its book sections. A book can also be attached as reference only.
- *Passages in lessons.* The teacher quotes short key passages verbatim, each with a clickable citation (§187, p. 114) that opens an in-app book reader at that spot, and teaches through the quote (e.g. a prediction before the explanation).
- *No graph extraction at import.* What is taught from the book enters the graph through normal session extraction. The existing "Extract files" remains available for whole-book extraction.

**Still open (settle when planning):** the map's size budget and how much of it each unit receives; handling books without clear structure; the reader view's layout; how quotes are kept verbatim (validated against the stored text).

### Model pickers and Claude Code discovery

**Status:** designed 2026-11-12; no implementation plan yet.

**Problem (human):** the ChatGPT subscription picker leaves out models (e.g. gpt-6.1-terra), Claude offers no options, and the full lists are longer than needed. The human wants the latest of each family by default, with a way to reach newly named models.

**Current behavior (verified):**
- The ChatGPT account returns a live model list, but `refreshChatGPTModels` (`src/agent/chatgpt-bridge.ts`) keeps only models already in pi-ai's static catalog. pi-ai 1.4.0 knows `gpt-6.1-sol` but not `gpt-6.1-terra`; 1.5.2 (2026-11-10) knows both, plus `claude-fable-5-2`.
- Claude is available only through the Claude Code CLI (`src/agent/claude-code/provider.ts`), as the aliases `opus`, `sonnet`, `haiku`. The CLI also accepts `fable` and full model names.
- CLI discovery (`src/agent/claude-code/binary.ts`) searches `PATH` plus fixed folders. These include Nix profile folders but not mise's, so an app launched from the desktop (no shell init) does not find a mise-installed `claude`. Reproduced with a desktop-like `PATH`. This is the likely reason Claude shows no options in the installed app.

**Decided:**
- *2026-11-12, human:* by default every picker shows only the newest model of each family, computed from the catalog rather than hand-maintained. A "Show all models" toggle reveals every model, including a newly named family.
- *2026-11-12, agent-selected (review follow-up):* if filtering removes the highlighted row's index, reset keyboard navigation without clearing the search text. Enter then chooses the first visible model; ArrowUp enters at the last visible model.
- *2026-11-12, human:* a model the ChatGPT account offers but the library doesn't know is listed under "Show all models" with a "New: limits unknown" badge. It uses conservative fallback limits and only the basic reasoning levels, and errors caused by a wrong guess say so. Real values replace the guesses once the library knows the model.
- *2026-11-12, human:* upgrade pi-ai and pi-agent-core together from 1.4.0 to 1.5.2 as a separate, focused change: review the changelog, run the full gate and `scripts/smoke-provider-runtime.mjs`, and report behavior changes.
- *2026-11-12, human:* the Claude Code picker shows the aliases `fable`, `opus`, `sonnet`, `haiku` by default; "Show all models" adds full model names from the library for pinning a version.
- *2026-11-12, agent-selected (human may veto):* add mise's shims folder (`~/.local/share/mise/shims`) to the Claude CLI search folders, a bug fix in line with the existing Nix-folder entries.

**Workaround for the installed upstream app (not yet verified inside its Nix FHS sandbox):** `ln -s ~/.local/share/mise/shims/claude ~/.local/bin/claude`, then enable Settings → Providers → External CLI → Claude Code.

### Desktop right-click menu and spelling suggestions

**Status:** designed 2026-11-12; no implementation plan yet.

**Problem (human):** misspelled words are underlined, but right-click shows no suggestions in the desktop app.

**Current behavior (verified):** `electron/` registers no `context-menu` handler, so Chromium's spellchecker marks words but nothing displays suggestions. Browser mode works because Chrome supplies its own menu. The app's own right-click menus (sidebar, graph canvas, selection actions) are separate.

**Decided (2026-11-12, human):** where the app shows no menu of its own, right-clicking text opens a native editing menu. On a misspelled word it lists up to 5 suggestions, then "Add to dictionary". After that come Cut, Copy, Paste, and Select All, shown only when they apply, plus Copy on selected read-only text, matching Chrome in browser mode.

## Roadmap (approved by the human, 2026-11-12)

Each item gets its own implementation plan, approved before work starts.

1. *(Done 2026-11-12; see [plan 01](plans/01-small-fixes.md).)* **Small fixes:** trim CI; Claude CLI discovery via mise shims; desktop right-click menu; pi-ai 1.5.2 upgrade (its own change); model pickers (latest per family, Show all, unverified models).
2. **Fork identity and packaging:** LearnHarness Fork name and data folder, one-time data copy, updater off, personal Nix package. Done before fork-only data formats exist, so real learning data is never mixed with upstream's.
3. **Phase 0:** on-demand HTML notes and conversation export.
4. **Phase 1:** courses and units.
5. **Books.**
6. **Phase 2:** mastery gates.
7. **Phase 3:** competency and weak points.

## Open questions

- Feature ideas beyond those above are welcome from agents; the human builds features directly in the fork and does not need local models.
- **Desktop PATH under mise (settle in roadmap step 2).** A desktop-launched app has no mise-activated PATH. The human's other machine runs upstream LearnHarness and can't find `claude`, nor `node` (likely because an npm-installed Claude CLI's script needs `node` on PATH); a `~/.local/bin/claude` symlink was a partial workaround. The app's own server runs on Electron's bundled Node; the only outside programs it launches are the Claude CLI (`src/agent/claude-code/binary.ts`) and Chrome for demo checks (`src/agent/subagents/headless.ts`). Roadmap step 1 added mise's shims folder to the Claude CLI search, and a shim sets up mise's tools for the program it runs. Option for step 2: have the packaged app load the login shell's environment at startup (as VS Code does), so every tool resolves as in a terminal.
- Whether the fork's GitHub repository settings (Actions enabled, branch protection) need changes after the workflows are trimmed.
