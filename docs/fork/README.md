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
- *Human, 2026-11-12 (step 2 interview; details in [plan 02](plans/02-fork-identity-packaging.md)):*
  - **Packaging:** the AppImage is built locally, published as a GitHub release on the fork, and wrapped in Hermes with `appimageTools.wrapType2` as upstream is today. The agent edits Hermes on a branch; the human merges and activates. The app changes come first and packaging last.
  - **Desktop PATH:** the Nix wrapper appends mise's shims folder to PATH. The login-shell environment is not loaded.
  - **Data copy:** everything in upstream's folder except logs, caches, and Chromium lock files, sign-ins included. If upstream is running, the fork asks the human to quit it first and never starts empty by accident. A one-time dialog confirms the copy.
  - **Updater UI:** the "Check for Updates…" menu item is removed. `homepage` points at the fork, so "Release notes" opens the fork's release.
  - **Versions:** upstream base plus a fork counter (`0.6.1-fork.1`). Upstream's icon is kept.

### Notes and conversation export (course phase 0) — 2026-11-12 and 2026-11-13

*Human*, in the step 3 interview and at the item 1 checkpoint; details in [plan 03](plans/03-notes-and-export.md):

- **Model:** notes are written by a *note writer* role on the **Strong** slot.
- **Files:** notes and exports are final when written. The server renders math (KaTeX) and Mermaid. Every file is a light, print-friendly, self-contained page in one fixed template, and embeds the app's fonts (Source Sans 3, CMU Serif titles, JetBrains Mono on pages with code).
- **Notes page:** each Teach session has a notes page with the list on the left and the selected note on the right, plus an "Invert colors" switch remembered on the device.
- **Interactive notes:** an "Interactive" checkbox, off by default, allows scripts in that note only.
- **Export:** includes the plan map, side-question threads, research and PDF briefs, and demos. It is built fresh and downloaded from the notes page or the sidebar's "Export as HTML…".
- **Deletion:** deleting a session deletes its notes; the dialog offers "Download notes" as one .zip.
- **Regenerate:** keeps the current version until the new one succeeds.
- **Setup wording (2026-11-13):** setup lists the Strong slot as "Prober, teacher, note writer". Settings keeps its descriptive "The main model for your sessions".

*Human, 2026-11-13, repair-plan approval following review findings:*

- **Publication:** the notes index is version 2, with an optional `htmlRevision` pointer selecting immutable HTML. Version-1 indexes and their original HTML remain readable. A failed publication preserves the previous HTML and metadata. Exact revision filenames and cleanup are agent-selected implementation details.
- **Unanswered export questions:** include visible prompts, context, and options with "Not answered". Keep answer keys, explanations, and correctness hidden until the learner answers. Plugin questions export their saved public prompt, never private payloads.
- **Recorded learner content:** HTML export retains plugin reading thoughts and all image channels. Markdown and note-writer input retain structured option labels and both thinking channels. Offline notes reject resources that require another file or a network request; embedded data and local SVG references remain allowed.
- **Instructions and deletion:** preserve the full instruction without the silent 4,000-character truncation. Failed deletion keeps the note visible and shows the error; an already-absent note (404) counts as removed.
- **Ratification and title rule:** the note-page wording listed under Plan 03 item 4's "Wording the plan didn't specify" is approved, as is the persisted `stopped: true` flag. Enforce the prompt's eight-word title rule and remove the additional 120-character restriction. The deletion connection error uses the existing "Couldn't reach the app. Try again." wording.

The repair plan includes regression coverage, a browser check using a scratch profile, the required quality gate, and a final review. No dependencies are added.

*Human, 2026-11-13, follow-up coverage and development-repair approval:*

- Retain the preceding repairs and decisions, including the approved Markdown/note-input formatter correction. Add coverage for the remaining export outcomes and question types, stopped regeneration, simultaneous notes, note-source fidelity, and interruption between HTML staging and index publication.
- Fix the development issues in order: isolate browser-service Chromium in a temporary profile before readiness (including parent-disconnect shutdown); initialize complete input-view bridge objects in Chat and DockOverlay; resolve the development Electron binary and app directory from a real filesystem anchor while preserving packaged execution and Chrome fallback.
- Verify development SSR, plugin-input notifications, real Mermaid rendering and demo checking under `next dev` without `CHROME_PATH`, the required quality gate, scratch browser checks, build and standalone smokes. No dependencies or additional product/storage changes; courses, releases, packaging changes, and real learning data are excluded. Leave changes uncommitted.

*Human, subsequent instruction:* commit the completed repairs, merge the feature into `main`, and delete unnecessary fully merged branches. This supersedes the preceding instruction to leave changes uncommitted.

*Agent-selected implementation:* the parent allocates the helper profile and passes its path through the internal `LH_BROWSER_SERVICE_PROFILE` environment field; both Electron profile paths are set before readiness. The parent removes the profile after helper exit because Chromium may flush after Electron's quit event. The dev executable and app argument resolve from the real project working directory; packaged servers still self-execute. Input-view bridges are complete mutable objects held inside React refs. Repeatable runtime checks live in `scripts/smoke-browser-service.mjs` and `scripts/smoke-dev-runtime.mjs`.

### Courses and units (course phase 1) — 2026-11-13

*Human*, in the step 4 planning interview; details in [plan 04](plans/04-courses-and-units.md):

- **Handoff model:** a *handoff writer* role draws from the **Strong** slot, with the usual optional per-role override. The course plan needs no role of its own: the setup session is an ordinary conversation on its own model.
- **Solid and shaky:** the app rates each plan node of a unit from its **"check"** answers only. Predictions are excluded, since missing one before a step is taught is normal.
  - *Solid:* the latest check is right at ≥ 70% confidence.
  - *Shaky:* the latest check is wrong, don't know, or right below 70%, with the reason stated.
  - Nodes never reached are carried forward.
  - The handoff writer adds labeled, model-written notes (misconceptions repaired, things to carry forward, extra shaky items). It can never mark solid what the rule calls shaky.
- **Ungraded answers:** free-recall (`explain`) and plugin answers have no stored verdict. They are recorded as **ungraded** evidence. A node with only ungraded answers gets the writer's judgment from the transcript, labeled as written by the model. Probe answers (unit probes and the setup probe) are recorded too, tagged by phase.
- **"Practice this unit":** seeds the Practice session with the unit's title, goal and plan topics, and the shaky items from its handoff. If the unit has been extracted, its graph propositions are added. It works with the graph off and never waits for extraction.
- **Edit rules:** units that have started (in progress or completed) can be renamed, re-goaled, reordered, and given different prerequisites, but not dropped or merged. Units that haven't started can change freely. The teacher's proposals follow the same rules, and invalid ones are refused back to the teacher.
- **Starting points:** each proposed unit carries a one- or two-line *starting point* from the setup probe. The learner can edit it before creating the course. The unit's agent receives it beside the prerequisite handoffs, labeled as the setup probe's read.

*Agent-selected, approved with plan 04 (human, 2026-11-13):*
- **Storage:** each course keeps `data/courses/<courseId>/` with `course.json` (version 1, refused when newer), `progress.md`, and `notes/<chatId>/` per unit session in the phase-0 index format. Chat records gain an optional `course` back-pointer, and the chat version stays 2.
- **Unit agents' context:** it is appended to the system prompt each turn, built fresh from the course record. That keeps it current and out of reach of compaction.
- **Evidence:** a `goal-reached` event is recorded beside the decided events.
- **Setup and plugins:** the setup agent appears to plugins as `prober`, so the plugin API is unchanged.
- **Prompts** (proposed in plan item 10): the setup doctrine, the unit doctrines, the course tools' descriptions and the handoff writer's prompt are fixed in code for phase 1. They aren't Settings → Prompts segments and have no overrides.

*Human, 2026-11-13:* plan 04 is approved as written, including its **Proposed** items (prompt and tool wording, dialog wording, sidebar and overview details).

*Human, 2026-11-13, checkpoint review:* review items 1–3 visually and in code, then make needed fixes and refinements autonomously, without waiting for design approvals. This delegation covers this review; it does not implement the remaining plan items.

*Agent-selected under that delegation:*
- **Editing:** a stale "Edit units" save is refused with a visible explanation, keeping the local draft and fetching the latest course even if its live update was missed. Cancel and reopen the editor to load that version. Combined title/unit requests validate completely before either change is saved; unknown existing unit ids and invalid proposal keys are refused.
- **Recovery:** overview and sidebar reads adopt unit sessions left between the chat write and course write, including restoring the opening marker of an empty session. Existing transcripts and model choices survive; start evidence is added once. This brings the recovery part of item 4 forward to protect item 3's already-exposed start route. If old duplicate candidates exist, adopt the oldest deterministically and delete none.
- **UI:** retain the checkpoint's themes, typography and desktop layout; place progress below the title and unit actions below their text in narrow windows, improve muted-row and editor-label contrast, preserve failed title edits for retry, show sidebar rename failures, and close an already-open setup in other windows when the course is created. The Notes placeholder is disabled until item 8 supplies its page (`CourseTabs` then receives `notesAvailable`).
- **Implementation:** validate stored record identity and the structures this build reads before rewriting, while retaining unknown fields and evidence types. Course edits share one synchronous service operation, and learner revision ids use UUIDs. Storage versions and dependencies are unchanged.

*Human, 2026-11-13, plan 04 item 4:* a unit's course section stays uncapped, as planned. Measured on fixtures, the last unit of a fully chained course receives about 5k tokens of prerequisite handoffs at 15 units and 6.7k at 20 (9k–12k when every model-written list is full at the 200-character cap), above the plan's "few thousand tokens" assumption.

*Human, 2026-11-13, item 4 review follow-up:* fix all four review findings: account for course-context growth in compaction, recheck completed units after asynchronous request preparation, refresh unit chrome after notification reconnects, and preserve the course's graph-folder association across an interrupted first start. These repairs retain the approved behavior, dependencies and storage formats.

*Agent-selected implementation:* prompt-size baselines are held in memory and tied to saved response ids; an unknown baseline after restart conservatively counts the full current course section until another response measures it. Course folders created by this repair use an id derived from the course id, allowing recovery independently of a session's current placement. Previously recorded folder ids remain supported, and learner moves are preserved.

*Human, 2026-11-13, item 5 review follow-up:* fix all four evidence-capture findings. Free recall remains ungraded even for "don't know"; overlapping plugin occurrences with a reused call id each retain their answer; node titles reflect successful plans preceding the question's execution, including in the same assistant batch; and settlement syncs evidence after saving parked dismissals.

*Agent-selected implementation:* retain pending plugin occurrences in call-id buckets and match results with the existing occurrence validator, preserving native questions' newest-call pairing. Read plan results only within the originating assistant's batch when assigning question titles. Event fields, id formats, storage versions and dependencies stay unchanged.

*Agent-selected, plan 04 item 6 (completing, handoffs, reopening; the human reviewed and finished the item, commit `7020fbd`, 2026-11-13):*
- **Role:** `handoffWriter` joins the model roles (Strong slot, schema-level override `agent.models.handoffWriter`, no Settings row), like `noteWriter`.
- **No Strong model at completion:** the unit still completes; the computed topics are stored and the writer fails at once with the usual "No model configured" message, so "Try again" applies once a model is set.
- **Writer identity:** a writer belongs to the handoff it started for (its `writtenAt`), so a late result after a reopen and a new completion is dropped. Results, failures, interruption and Try again leave the course's `updatedAt` alone, as evidence writes do.
- **Reopen** also clears the unit's `completion` and `completedAt`; the kept handoff carries its own completion and date.
- **Lifecycle ids:** `unit-completed:<chatId>:<n>` and `unit-reopened:<chatId>:<n>`, counted per unit session.
- **Wording the plan didn't specify (proposed for the checkpoint):** the dialog names the unit under its title ("2. Linear maps"); "Writing the teacher observations…" while the writer runs; "The note couldn't be started: …" and "The conversation couldn't be exported: …" after completion; the overview's handoff opens with "Completed 20 Nov 2026 (early: …)" instead of repeating the unit's title; Background agents labels the row "Handoff writer".

*Human, 2026-11-13, item 6 review follow-up:* fix both worker-startup findings. A handoff engine that cannot be built still leaves the unit completed with its computed topics and a failed writer that can be retried. An exception starting the optional note returns completion success with `noteError`, so the export and next-unit offer remain available.

*Agent-selected implementation:* handle engine-construction errors inside the completion service, and catch optional-note exceptions after saving completion. Course persistence failures still propagate. No storage-format, dependency, or UI wording changes.

*Human, 2026-11-13, plan 04 item 7:* when a unit's teacher proposes course changes again while its earlier proposal is still pending, the new proposal replaces the old one. The old one becomes "Outdated" with "Replaced by a later proposal from this unit.", as `propose_course` replaces earlier proposals in setup.

*Agent-selected, plan 04 item 7 (course revisions):*
- **Tool shape:** each change is one flat object (`type` plus the fields that apply), checked per type, so every provider's schema handling reads it. A refusal that isn't a broken rule (the unit is completed, or the session no longer holds it) reads as a plain refusal, like `goal_reached`'s.
- **Ids:** proposals are `proposal_<time>_<random>`, and a decision's revision event is `revision:<proposalId>`, as the golden record already used. The same tool call recorded twice keeps its first proposal.
- **Outdated:** an Accept that no longer applies stores the broken rules as the reason and records no revision event, since nothing was revised and the event's decision is accepted or rejected. Reject doesn't revalidate. A replaced proposal records no event either.
- **`updatedAt`:** only an accepted proposal stamps it, because its units change and an open "Edit units" draft must become stale. Proposing, rejecting and outdating leave it alone, as evidence writes do.
- **Change lines:** a decided proposal shows the lines its revision event recorded, numbered against the units it was decided on. Pending and outdated ones are numbered against the current units. The unit's course context uses the same lines, so an accepted drop no longer reads `Drop "<id>": <id>`.
- **Store:** reads check each proposal's fields and the four change shapes. A change type this build doesn't know is kept, shows as "Unknown change: <type>", and an Accept finds it outdated.
- **Overview:** "Pending course changes" sits between the goal and the units. A proposal decided in that view stays, showing how it ended, until the page is left.
- **Chat:** the card at the tool call reads its proposal live from the course, by the id in the call's result. A session no longer in its course shows the call's own input, read-only.
- **Wording the plan didn't specify:** "Accepting…" and "Rejecting…" while deciding; the live activity "Proposing course changes…"; an outdated card's reason below its lines; the model's field descriptions; the refusals "The proposal couldn't be recorded: …", "This proposal has already been decided." and 'The decision must be "accept" or "reject".'; and missing-field problems such as `Change 1 (move) needs "after": the id of the unit it goes after, or null for the start.`

*Human, 2026-11-13, item 7 review follow-up:* fix distinct course proposals being mistaken for retries when a provider reuses a tool-call id. Preserve the approved replacement behavior and idempotency for the same call.

*Agent-selected implementation:* the existing wire boundary publishes an executing call's canonical id before the tool body runs. The turn handler gives that id to the proposal recorder, matching the streamed and saved transcript even when raw provider ids repeat within or between turns. Record fields, versions, dependencies and wording stay unchanged.

*Agent-selected, plan 04 item 8 (unit notes, the course Notes tab, "Practice this unit"):*
- **Which notes folder:** a unit session keeps its notes under its course only while the course record names it as the unit's session. A crash's duplicate unit session is standalone, as it is for the course context (item 4). A unit session's notes written before item 8, in the standalone folder, move under the course the first time they are read. A course that can't be read answers 409 from the session's notes routes.
- **Deleting a session** removes both possible notes folders of that session, read from the record before it goes.
- **The Notes tab:** each started unit is a heading ("2. Linear maps") with its notes newest first, or "No notes yet". A heading is a button that selects its unit, and selecting a note selects its unit too. The selected unit is what "New note" defaults to and what "Export conversation (HTML)" exports. The tab opens on the unit named in `?unit=` (a unit's Notes chip), or else on the newest note, or else on the last started unit. The top bar shows the title, progress and tabs as the overview does, and renaming stays on the overview. A unit session's own notes page redirects to the tab.
- **Course archive:** unit folders are `<n>-<unitSlug(title)>/` and hold the notes in the session archive's naming. A unit without notes has no folder. A unit whose notes index can't be read fails the whole archive with 409, naming the unit, so a "Download notes" before deletion is never silently incomplete.
- **"Practice this unit":** the overview's button is offered on completed units, as planned. The draft and the server accept any started unit, so a unit reopened meanwhile still works. While a unit is attached, its chip takes the node picker's place, and Clear makes the draft a plain practice draft. The session's context is a `graph-context` marker carrying the unit in its details, so it classifies, flattens and renders like a map pick. The transcript card reads "Unit context · Unit <n>: <title>".
- **Practice context contents:** "Topics the unit taught" are the handoff's topics except those never reached, joined with "; ". The shaky items are the computed shaky topics, then the writer's shaky judgments and extra shaky items, marked "(model-written)", once the writer has finished. The propositions are graph nodes whose provenance names the unit's session, with no cap and no chains. They are left out while the graph is off.
- **Narrow windows:** the note toolbar wraps, so the desktop window's minimum width (640 px) no longer overflows. Phone widths keep phase 0's side-by-side layout (browser only).
- **Wording the plan didn't specify:** "Unit" (the picker's label), "No notes yet", "No notes for this unit yet.", "No unit has started yet.", "Unit context" (the transcript card), and the refusals "This unit hasn't started yet." and "Unit <n> (<title>): <reason>".

*Human, 2026-11-13, item 8 review follow-up:* fix failed legacy-note migration leaving older notes inaccessible and allowing an incomplete archive. *Agent-selected implementation:* a failed move throws the existing notes-unreadable error, so session note routes and both archives return 409; the course archive names the affected unit. New-note creation is refused before the destination or a writer is created, and the next request retries the move. The refusal reads "This session's notes couldn't be moved into its course. Try again."

*Agent-selected, plan 04 item 9 (course deletion):*
- **What goes:** the setup session and the sessions the course record names for its units. A crash's duplicate unit session (one with only the back-pointer) isn't a member, so it stays as a standalone session, as it does for notes and the course context. Linked "Practice this unit" sessions stay, as planned.
- **One step:** every gate runs first, then the sessions' extraction winds down together. After that, everything happens without an await:
  - the gates again;
  - the handoff writers stopped;
  - one graph rewrite for all the sessions, with the same survival rules as deleting them one at a time;
  - each session's jobs, record and notes (setup first, then the units);
  - the graph folder;
  - the course folder last.

  A unit started while extraction winds down is included. An initial running-turn or running-job refusal stops nothing. Extraction wind-down aborts the members' extraction runs before waiting, so a 503 (or a later work-gate refusal) can follow cancellation.
- **Graph folder:** removed only when nothing is left in it: no source and no subfolder. A deleted session whose traces the graph kept still counts as a source. So keeping the traces keeps the folder, and removing them removes it, unless the learner filed something else there. The folder goes before the course record, so a crash between the two leaves nothing behind.
- **Failure part-way:** if a session's record or the course's notes/progress can't be removed, the request fails with 500 and the course record stays. The course store removes every other entry before removing `course.json`. A rerun counts missing sessions as deleted, while still applying the graph mode to every member id. A session record the store can't read (damaged, or saved by a newer build) counts as already gone and is left untouched, as it does for session deletion.
- **API:** `DELETE /api/courses/:id?mode=…` returns `{ ok, mode, chatIds, stats, graphRevision }`. `chatIds` includes every recorded member, including sessions deleted by an earlier attempt, so an open member page can leave on success. Work-blocking refusals carry `code` and the named session's `chatId`; extraction refusals carry `code`. Other refusals, such as an unreadable course (409) or a cleanup failure (500), carry neither.
- **Wording the plan didn't specify:**
  - The session names in refusals, inside session deletion's sentences: "A turn is running in unit 2 (Linear maps) — try again when it finishes" and "Background jobs are still running in the setup session — try again when they finish".
  - "An extraction in this course is still winding down — try again in a moment" and "Some of this course's sessions couldn't be deleted. Try again."
  - The dialog's line leaves out a part whose count is zero and uses singulars ("its 1 unit session", "their 1 note"). "Download notes" shows only when there are notes, as in the session dialog. The dialog follows the plan's line and has no "This cannot be undone." sentence.
  - "Delete course…" sits below "Rename course" in the session menu's quiet destructive look.

*Human, 2026-11-14, item 9 review follow-up:* fix all three deletion findings: preserve the course record through late cleanup failures, remove graph traces belonging to missing member sessions, and cancel extraction registered during single-session deletion. Retain the approved storage formats, dependencies, and UI wording.

*Agent-selected implementation:* course cleanup removes notes and progress before the record, and cleanup errors use the existing retryable 500 response. The graph purge and successful response use all recorded member ids; record cleanup continues to skip unreadable sessions. Single-session deletion checks extraction again immediately before its synchronous purge, aborting a late run and returning the existing retryable 503.

*Human, 2026-11-14, further review repairs:* address final-directory cleanup losing the course record, retry skipping legacy notes after a session record is removed, unknown note counts being treated as zero, and inaccurate refusal guarantees. The approved dialog policy blocks Delete while notes load or cannot be read, shows "Reading notes…" while loading and the server's reason on failure, and offers "Try again" to reload the count. Cancel remains available. No dependency or storage-format changes; leave the work uncommitted.

*Agent-selected implementation:* retain the original course record for restoration if final directory removal fails, and retry legacy-note cleanup independently of session-record availability. Unknown note counts stay distinct from zero; only a complete successful notes read enables Delete.

### Books item 1 review repairs — 2026-11-14, human

Fix all thirteen review findings within item 1: preserve non-Latin and rotated PDF text; preserve EPUB mathematical/accessibility text, UTF-16 documents, inline page boundaries and encoded anchors; refuse missing spine documents with the existing unreadable-file message; repair sparse-outline confidence, compound labels, hyphenated ranges and selected-root budget collapse; and protect newer or damaged maps during contents acceptance and switching.

Page locations prefer printed labels and use one numbering scheme for the whole range. Physical numbering is a fallback only when neither endpoint has a matching printed label; a partially matching printed range is refused instead of mixing schemes.

The approved repair plan includes focused regression coverage, the required quality gate with scratch profiles, and updates to the existing plan outcome. No dependencies, storage-format changes, UI changes, commits, or real learning data.

*Human, repair implementation:* when a hyphenated range has multiple valid endpoint pairs, refuse it with `"<input>" matches several ranges. Use section ids with "to".` rather than selecting one or reusing the unknown-location message.

### Books item 2 decisions — 2026-11-14, human

The optional model contents pass uses the agent's drafted prompt as written (`BOOK_STRUCTURE_PROMPT` in `src/agent/subagents/book-mapper.ts`). It shows in Background agents as "Book contents · <title>" ("Finding the contents"), with its live cost and Stop, like every other model worker; a stopped pass fails as "Stopped" and the review screen keeps the other methods. Details and agent-selected choices: [plan 05, item 2](plans/05-books.md#item-2-2026-11-14).

*Human, item 2 review follow-up:* fix all four findings: budget map requests against the production provider's context headroom, size the contents digest and estimate for the selected model, apply a replacement model candidate even when its method is unchanged, and keep Stop available after a writer retry. Preserve dependencies, storage formats and existing wording; no commit was requested. For a model that cannot fit even one useful request and its answer, the human approved failing before a provider call with: "This model's context or output limit is too small for the book writer's request and answer. Choose a model with a larger context or output limit."

*Agent-selected implementation:* request sizing counts the complete provider-facing prompt and tool schema and reserves room for the submitted answer. Contents estimates and execution share the same prepared digest. Candidate comparison excludes summaries and terms, so accepting unchanged contents keeps the existing map work. Stop state belongs to the writer run, while the server's abort id stays unchanged.

### Books item 3 review repairs — 2026-11-14, human

Fix all six review findings within item 3: the in-use check skipping records it can't read, a replacement model candidate the review couldn't offer, late jump responses replacing newer navigation, jump windows that could leave out their target, the open delete dialog discarding refreshes, and a failed read of the contents leaving the review without recovery. No dependency or storage-format changes; leave the work uncommitted.

*Human, unreadable records:* a session or course record that can't be read (damaged, or saved by a newer version of the app) counts as using a book when its file contains the book's id. It blocks deletion and contents changes, and "Used by" and the refusal list it without a link as "a course that can't be read (<id>)" or "a session that can't be read (<id>)". Unreadable records that don't mention the book block nothing. A record or folder that can't be opened at all fails closed with the existing retryable error.

*Agent-selected implementation:* the chat and course stores gain a scan of the files that contain a given text (`chatsMentioning`, `mentioning`), which reports unreadable matches and throws when a file can't be opened. A listed unreadable course covers the sessions that name it, as a readable course does. The review shows the book's current map as the found contents (exactly what "Looks right" accepts) and offers every candidate whose contents differ from it, using the server's comparison (`sameBookContents`, now in core). A failed read of the candidates shows its reason with "Try again", and a reconnect reads them again. Jumps and search matches use `around`/`at` windows that keep up to 4 blocks above the target, fewer when those would use up the window. Refreshes are held off only during the delete request, and a refused or failed delete refreshes. Details: [plan 05, item 3 review repairs](plans/05-books.md#item-3-review-repairs-2026-11-14).

### Books checkpoint 1 and item 4 decisions — 2026-11-14, human

*Checkpoint 1:* the look of items 1–3 (the library, "Check the contents" and its alternatives, the garbled refusal, the book page and reader, an app-made book, the delete refusal) and item 3's agent-selected choices are approved. Item 4 may start.

*Where the Book control appears:* in both session composers, the home composer and the `/chat/new` draft (which the sidebar's "+ New session" and "Course" doors open), in their Teach and Course modes, hidden in Practice. The plan named only the home composer.

*Course mode's choice:* a setup session keeps "Follow its structure" or "Reference only" on its own record as `book: { bookId, mode: "follow" | "reference" }`; Teach sessions keep `book: { bookId }`. An additive field; the chat version stays 2. Creating the course copies both into the course's `book`.

*The book section's wording* beyond the approved doctrine and additions, approved as the agent drafted it:
- A header with the title and author.
- The citation line: PDFs with the book's own structure, "Cite places as the book does, with the page: "§187 (p. 114)"."; EPUB and text, "Cite places as the book does: "§187"."; app-made parts of a PDF, "Cite places by page: "p. 114". The app divided this book into parts; never cite them."; app-made parts of an EPUB or text, "Cite places by the app's part numbers: "Part 14". The book has no structure of its own." The examples come from the book itself.
- "The tools take a place as an id or label from the outline ("n52", "§187"), a range ("§178–§196"), or pages ("pp. 114–116").", and while the map is written, "Summaries are still being written; the outline shows those done."
- The outline under "Outline", and for a unit of a followed book "This unit's reading: <range>" with the unit-teacher addition (teacher only) and the detail.
- A book that can't be read: "This session's book, "<title>", can't be read right now (<reason>). Teach without it; if the learner asks about it, say so."
- The tools' limits: `read_section` ends a long read with "Continues: call read_section with at "blocks 341–512"" (block numbers become a location form); `book_map` over its cap says "Too large to show in full. Narrow to one of: …"; `search_book` says "57 matches; showing the first 20. Add words to narrow it." or "No matches for "…".".
- The doctrine's second paragraph (quoting through `quote_passage`) joins the prompt in item 5, with the tool.

*Human, item 4 review follow-up:* fix both retrieval findings: enforce the 8k-token read limit even within a single oversized block, with lossless continuation, and make an oversized selected map expose smaller locations instead of recommending itself. Block continuations may carry a character offset; dependencies and storage formats stay unchanged. Implementation and checks: [plan 05, item 4 review repairs](plans/05-books.md#item-4-review-repairs-2026-11-14).

## Feature designs

### Courses, units, and notes

**Status:** designed 2026-11-12. Phase 0 (notes and export for standalone Teach sessions) done 2026-11-13 ([plan 03](plans/03-notes-and-export.md)). Phase 1 planned and approved 2026-11-13 ([plan 04](plans/04-courses-and-units.md)). All ten items were implemented by 2026-11-14, and the human checks under [Pending human checks](#pending-human-checks) remain.

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
- ~~Which model slot (Strong or Cheap) generates handoffs and the course plan.~~ *Settled.* Notes use the Strong slot (2026-11-12, human; [plan 03](plans/03-notes-and-export.md)). Handoffs use the Strong slot, and the course plan comes from the setup session's own conversation model (2026-11-13, human; [plan 04](plans/04-courses-and-units.md)).
- Phase 2 gate design: format, pass criteria, retries, override flow.
- Phase 3 competency model and weak-point views.

**Agent recommendations (not yet accepted):**
- Run gates as a separate assessment reusing the practice problem/conclude machinery; record overrides as overrides.
- Store evidence events and derive competency, rather than storing model-assigned scores.

### Books

**Status:** designed 2026-11-12. Planned and approved 2026-11-14 ([plan 05](plans/05-books.md)), including its Proposed items. Item 1 (record, store and model-free import) is implemented, including review repairs; item 2 (the map writer and the optional contents pass) and item 3 (library and book pages) are implemented, both including review repairs. Checkpoint 1 (the look of items 1–3) was approved on 2026-11-14. Item 4 (attaching a book, the book in prompts, the retrieval tools) is implemented; its browser check is still owed (see plan 05). Items 5–8 remain, with checkpoint 2 after item 5. Built right after course phase 1 (see build order below).

**Problem (human):** to study a specific text (e.g. Hegel's *Phenomenology of Spirit*), the learner wants to add the book. The whole book should never sit in context, but it should be reachable when needed.

**Starting point (before plan 05):** a session can receive a PDF path. The teacher dispatches a `pdf` job (`src/agent/subagents/pdf-reader.ts`) with a question; for long PDFs it keyword-searches, reads only the matching pages, and returns a brief with page citations. Nothing persists between questions: no table of contents or book structure, and every question re-triages from scratch. EPUB is unsupported. No embeddings exist anywhere in the app. Graph import ("Extract files") turns text into propositions but discards the text itself.

**Decided (2026-11-12, human):**
- *Book map, not embeddings RAG.* A one-time import converts the book to text and splits it along its own structure (parts, chapters, sections, numbered paragraphs such as the *Phenomenology*'s §1–§808). The Cheap model writes a short summary and key terms for each section, producing a compact hierarchical map. Agents receive the relevant part of the map, pull exact text with a "read section" tool, and fall back to keyword search. **Why:** embeddings need an extra paid provider (neither the ChatGPT subscription nor Claude Code offers one) plus a vector store, and similarity-chunk retrieval loses a passage's place in the argument, which is the meaning in a text like Hegel's.
- *Formats.* PDF (text layer only, no OCR), EPUB (new), and plain text/Markdown.
- *Library.* A Books library holds each imported book's copy and map in the data folder. The map is built in the background at import. A library book is attached when starting a course or a Teach session; one book can serve several courses and sessions without re-import.
- *Course from a book.* When a course is started with a book, setup proposes units that follow the book's structure, still adjusted by the probe (e.g. adding a background unit on Kant). Each unit is tied to its book sections. A book can also be attached as reference only.
- *Passages in lessons.* The teacher quotes short key passages verbatim, each with a clickable citation (§187, p. 114) that opens an in-app book reader at that spot, and teaches through the quote (e.g. a prediction before the explanation).
- *No graph extraction at import.* What is taught from the book enters the graph through normal session extraction. The existing "Extract files" remains available for whole-book extraction.

**Decided (2026-11-14, human, in the step 5 planning interview; details in [plan 05](plans/05-books.md)):** this settles the four questions left open on 2026-11-12.
- *Verbatim quotes:* the teacher quotes through a tool that checks the passage against the stored text and refuses a mismatch back to the teacher. The chat shows a quote card whose text comes from the stored book, with a clickable citation.
- *Map in prompts:* every turn gets the whole-book outline down to section headings with one-line summaries (about 3k tokens at most; deeper levels collapse). A course unit also gets full detail (summaries and key terms) for its own reading (about 4k tokens at most). The rest is reached through a map tool, then read or searched.
- *Books without detectable structure:* split at paragraph breaks into app-made parts of about 2,000 words, titled by the Cheap model with their summaries, marked "Divided by the app". Citations then use pages (PDF) or part numbers, never invented §s.
- *Reader:* a citation opens a resizable panel beside the chat at the passage, highlighted: reflowed stored text, a contents list, section and page labels, and "Show original page" for PDFs. "Open full page" goes to `/books/<id>`; narrow windows get the full page.
- *Attaching:* at most one book per course or Teach session, chosen when it starts. A course follows it or keeps it as reference.
- *Unit readings:* each unit of a course that follows its book has a reading (one or more contiguous map ranges, or none), shown and editable with a contents picker in the setup card and "Edit units". The overview shows the parts no unit reads. Teacher proposals that insert or merge units carry readings.
- *Who reads the book:* the prober, teacher, setup agent, and the "Practice this unit" practitioner (which can pose problems on a quoted passage). Note and handoff writers work from the transcript's quote cards. Standalone Practice sessions have no book.
- *Side questions* stay tool-less. One asked on a message with quote cards gets each quoted passage's surrounding text (about 2k tokens) and the book's outline in its prompt. (The human first chose book tools for side questions, then chose this once told side questions have no tool loop.)
- *Deleting a book* is refused while any course or session uses it, listing them; afterwards it removes the copy and map.
- *Import flow (the human's request after the first draft):* anything that can be done without a model is done without one.
  - The contents (index) are always found without a model, and the app judges its own confidence.
  - Confident contents are accepted automatically and shown.
  - Unsure ones stop at "Check the contents" ("Looks right" / "Not right"). "Not right" first offers the other methods that need no model. Only after that does it offer, and ask before running, a model pass over a compact digest of candidate headings, never the whole book.
  - A broken file (unreadable, no text layer, garbled text) is refused with a plain explanation and no model call.
- *Summaries* are written automatically by the Cheap model once the contents are accepted, as originally designed, with Stop available. Books under about 20,000 words get no summaries; the agent reads their text directly.

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
2. *(Done 2026-11-12; see [plan 02](plans/02-fork-identity-packaging.md), items 1–5.)* **Fork identity:** LearnHarness Fork name and data folder, one-time data copy, updater off, and a local AppImage build. These only take effect in a packaged build; dev runs are unchanged.
3. *(Done 2026-11-13; see [plan 03](plans/03-notes-and-export.md).)* **Phase 0:** on-demand HTML notes and conversation export.
4. *(Approved 2026-11-13; implemented 2026-11-14, awaiting the human checks below; see [plan 04](plans/04-courses-and-units.md).)* **Phase 1:** courses and units.
5. *(Approved 2026-11-14; see [plan 05](plans/05-books.md).)* **Books.**
6. **Phase 2:** mastery gates.
7. **Phase 3:** competency and weak points.
8. **Release and install:** publish a fork release and install it through Hermes (plan 02, items 6–7, re-planned when this step starts). Until then the human keeps learning in upstream LearnHarness, and the fork runs only in dev against the repo's data.

*Reordered 2026-11-12 (human):* releasing and installing moved from step 2 to last. The app should be working with all changes in place before anything is packaged or installed. A first release and Hermes package were made and then removed the same day: the GitHub release `v0.6.1-fork.1` was deleted and the Hermes changes were never committed or activated.

## Pending human checks

Checks only the human can do, such as clicking native dialogs or menus. Remove an entry once it's done; report problems as bugs.

- *Step 1, right-click menu:* in `nix develop -c mise exec -- npm run desktop:dev`, right-click a misspelled word. Expect up to 5 suggestions, "Add to dictionary", then the editing items.
- *Step 2, first-launch dialogs:* run the packaged build against a scratch profile (`npm run desktop:dist:linux`, then `XDG_CONFIG_HOME=<scratch>/config nix develop -c dist/linux-unpacked/learnharness-fork`, with a fake `LearnHarness` folder in the scratch config). Check the "LearnHarness is running" dialog (Retry asks again while upstream runs; once upstream quits, Retry restarts the app and copies), Quit, the "Copied…" confirmation, and the copy-failed dialog. Retry's restart inside the Hermes wrapper can only be checked in step 8.
- *Step 3, notes and export:*
  - On NixOS, start the dev server inside `nix develop` when testing Mermaid and demos, so the Electron helper has its native libraries. No `CHROME_PATH` is needed.
  - Write a real note from one of your sessions on your own provider (from the session's Notes chip), then regenerate it with an instruction.
  - Open a downloaded note and an exported conversation outside the app, in a browser, and print one.
  - In `nix develop -c mise exec -- npm run desktop:dev`, click a web link inside a note. It should open in the system browser.
- *Step 4, courses and units* (the checks in [plan 04](plans/04-courses-and-units.md#verification)):
  - Run a real course setup on your own provider: start from "Course", answer the setup probe, edit the proposed units in the card, and create the course. Then work through unit 1's probe, plan and checks until the teacher marks the goal reached.
  - Complete that unit and read its handoff: the overview's "Handoff" disclosure on the completed unit. Check that the computed solid and shaky lines match your answers, and that the teacher observations (written by your Strong model) are fair.
  - Open the course's `progress.md` outside the app, at `<data folder>/courses/<courseId>/progress.md` (the repo's `data/` in dev unless `LH_DATA_DIR` is set). It should read as the course's current state.

## Open questions

- Feature ideas beyond those above are welcome from agents; the human builds features directly in the fork and does not need local models.
- **Desktop PATH under mise (settled 2026-11-12: the Nix wrapper adds mise's shims to PATH; see Decisions; built in roadmap step 8).** A desktop-launched app has no mise-activated PATH. The human's other machine runs upstream LearnHarness and can't find `claude`, nor `node` (likely because an npm-installed Claude CLI's script needs `node` on PATH); a `~/.local/bin/claude` symlink was a partial workaround. The app's own server runs on Electron's bundled Node; the only outside programs it launches are the Claude CLI (`src/agent/claude-code/binary.ts`) and Chrome for demo checks (`src/agent/subagents/headless.ts`). Roadmap step 1 added mise's shims folder to the Claude CLI search, and a shim sets up mise's tools for the program it runs. Rejected option: have the packaged app load the login shell's environment at startup (as VS Code does), so every tool resolves as in a terminal.
- Whether the fork's GitHub repository settings (Actions enabled, branch protection) need changes after the workflows are trimmed.
