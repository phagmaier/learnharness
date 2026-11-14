# Plan 04: courses and units (roadmap step 4, course phase 1)

**Status:** approved by the human 2026-11-13, including its Proposed items. Items 1–5 are committed on `phase1-courses`; checkpoint 1 was reviewed and repaired under human delegation (see Outcome). Item 6 is implemented and not yet committed; its checkpoint (the completion dialog and the handoff's look and wording) awaits the human. Items 7–10 remain pending. Work happens on branch `phase1-courses`, off `main`, one commit per item. Checkpoints after item 3 and after item 6 are approved before work continues. Progress is recorded under [Outcome](#outcome).

Designs: [fork README](../README.md), "Courses, units, and notes". Choices made in this plan's interview are marked **Decided (human)**. **Proposed** items are product choices the agent filled in (wording, UI details, small rules); approving the plan approves them, or the human edits them. *Agent-selected* items are implementation details, reported again at completion.

**Scope:**
- Course setup.
- Courses made of units, the unit lifecycle (start, complete, reopen), prerequisites, handoffs, and course revisions.
- Progress tracking: the course record and `progress.md`.
- Evidence events.
- The course overview, the sidebar groups, unit notes, the course Notes tab, the completion dialog's offers, "Practice this unit", and course deletion.

**Not in this plan:**
- **Books** (roadmap step 5).
- **Mastery gates** and overrides (phase 2).
- **Competency and weak-point views**, including any page that shows raw evidence (phase 3).
- **Release and install** (step 8).
- Practice sessions stay without notes.
- No whole-course HTML export, no plugin API for courses, and no Settings → Prompts overrides for the new prompts.
- Practice sessions are never members of a course group. "Practice this unit" sessions only link to their unit.

## Decisions from the interview (2026-11-13, human)

1. **Handoff model:** a new *handoff writer* role draws from the **Strong** slot, with the usual optional per-role override. This settles the README's open question. The course plan needs no role of its own: the setup session is an ordinary conversation on its own model (Strong by default).
2. **Solid and shaky:** the app classifies each plan node of the unit from **"check"** answers only. Predictions come before a step is taught, so missing one is normal.
   - *Solid:* the latest check is right at ≥ 70% confidence.
   - *Shaky:* the latest check is wrong, don't know, or right below 70%. The reason is stated.
   - Nodes never reached are carried forward.
   - The writer adds labeled notes: misconceptions repaired, things to carry forward, and extra shaky items. It can never mark solid what the rule calls shaky.
3. **Ungraded answers:** free-recall and plugin answers are recorded as **ungraded** evidence. A node that has only ungraded answers gets the writer's judgment from the transcript, labeled as written by the model. Probe answers are recorded too, both the unit probe's and the setup probe's, tagged by phase.
4. **"Practice this unit":** the Practice session is seeded with the unit's title, goal and plan topics, and the shaky items from its handoff. If the unit has already been extracted, its graph propositions are added. It works with the graph off and never waits for extraction.
5. **Edit rules:** units that have started (in progress or completed) can be renamed, re-goaled, reordered, and given different prerequisites. They can't be dropped or merged. Units that haven't started can change freely. The teacher's proposals follow the same rules, and a proposal that breaks them is refused back to the teacher.
6. **Starting points:** each proposed unit carries a one- or two-line *starting point* from the setup probe. You can edit it in the list you approve. The unit's agent receives it beside the prerequisite handoffs, labeled as the setup probe's read.

## Facts this plan relies on (verified 2026-11-13)

- **Sessions.** A session is one `ChatRecord` in `data/chats/<id>.json`, at version 2 (`src/core/contracts/chat.ts`). An absent `kind` reads as teach, and `practice` selects the practitioner.
  - Writes spread the parsed record, so an older build keeps fields it doesn't know (`src/store/chats.ts`, `writeChat`).
  - The list summary derives the phase from the transcript (`phaseAt3Lh`).
- **Creation.** `POST /api/chats` (`app/api/chats/route.ts`) creates the record and stamps the Strong slot's model. It writes graph picks as a `graph-context` marker at `message[0]`.
  - Starting a session hands the opening text to the chat page through `sessionStorage` (`components/opening-prompt.ts`). The page then sends it as the first user message.
  - The home composer has a Teach | Practice switch (`components/home.tsx`). The sidebar has "Teaching" and "Practice" buttons and a Teaching / Practice / All filter over a flat list sorted by `updatedAt` (`components/sidebar.tsx`).
- **Agents per turn.** `handleChatInput` (`src/server/chat-handler.ts`) builds a fresh agent every turn. That is the practitioner for practice, the teacher once `probe_done` has succeeded, and the prober otherwise.
  - The system prompt is composed fresh each turn.
  - Plugin contributions append instructions and tools without replacing anything (`teacher-agent.ts`, `baseAgentOptions`). That is the precedent for adding per-turn context.
- **Compaction.** Compaction summarizes everything before its cut and re-adds the plan tree word for word (`src/core/compaction.ts`). A context marker at `message[0]` can therefore be summarized away. The system prompt is never compacted.
- **Input causes.** `nativeInputCause` (`src/core/native-messages.ts`) classifies markers as learner, automatic, neutral, or unrecognizable. Automatic input makes a request background-purpose, which subscriptions block until the learner enables background use. The input taxonomy includes `continue` (`src/core/input-events.ts`).
- **Evidence in records.**
  - *Multiple-choice answers:* `QuestionAnswerData` (`src/core/question-core.ts`) records `correct`, `dontKnow`, `dismissed`, `confidence` (0–100, quiz only), `questionType` (`predict` | `check`, teach only) and `tool`. The tool is `probe`/`recall` while probing and `quiz`/`explain` while teaching.
  - *Plan position:* teaching calls carry `nodeId`.
  - *Free recall (`explain`):* stores no verdict, because the teacher grades it in prose.
  - *Plugin questions:* grading returns an arbitrary JSON value with no standard `correct` flag (`src/core/plugin-questions.ts`).
  - *Practice:* `conclude` records `outcome` (solved, solvedWithHints, movedOn, surrendered, dismissed), `rung` and `missClass` (`src/agent/tools/practice.ts`).
- **Notes (phase 0).**
  - `noteStoreAt(dir)` (`src/store/notes.ts`) takes any owner directory. The notes service (`src/server/notes.ts`) is keyed by chat id but hard-wires `sessionNoteStore(chatId)` → `data/notes/<chatId>/`.
  - The notes page, the "Notes" chip, the zip writer (`src/server/zip.ts`, which writes entry names as given), the export route, and the Background-agents rows all exist.
  - Session deletion removes notes through `finishChatRecordDeletion` (`src/server/chats.ts`).
- **Deletion.** `deleteChatSession(chatId, mode)` refuses (409) while a turn or a background job runs and waits for extraction to wind down. It then deletes the graph traces, the jobs and the record without awaiting. Modes are `preserve-graph` and `delete-nodes`.
- **Graph sources.** A chat's source id is its chat id (`src/server/source-organization.ts`). Folder placement lives in `graph/source-organization.json`. The chains view and practice picker hide practice sessions through `chainSourceDirectory`. Graph nodes carry provenance by `chatId`.
- **Workers.** Note writers run with purpose `user` in the shared worker pool, appear in Background agents with Stop, and recover from interruptions on read. `runSubmitAgent` runs one validated submit call.
- **Prompts.** The segment loader knows the `prober`, `teacher` and `practice` kinds (`src/agent/prompt-segments.ts`, `src/core/prompt-segments.ts`). The note writer's prompt lives in its module and is not a Settings segment, which is the precedent for prompts that aren't overridable.

## Assumptions (not verified; checked during implementation)

- A changed system prompt between turns costs one prompt-cache miss and works on every provider, including the Claude Code CLI. Plugin instructions already do this.
- The prerequisite handoffs of a 15–20-unit course fit in a few thousand tokens. This will be measured with fixtures, and no cap is planned.
- The local fake OpenAI-compatible endpoint used in plan 03's browser check can script multi-turn flows: the setup proposal, `probe_done`, `plan_init`, checks, `goal_reached`, and the handoff.
- Common unzip tools create folders from `/` in entry names, as the zip format specifies.

## Storage (agent-selected layout; covered by this plan's approval)

```text
data/courses/<courseId>/
  course.json        the course record (version 1)
  progress.md        regenerated on every change; never read back
  notes/<chatId>/    one phase-0 notes directory per unit session (same index format)
```

- **`course.json`** is written by temp file and rename, with no in-place fallback. An absent stamp reads as 1. A newer or damaged record is refused (HTTP 409) and never rewritten. Its shape:
  - `id`, `title`, `goal`, `createdAt`, `updatedAt`, `setupChatId`, `sourceFolderId?`;
  - `units[]` in suggested order: `id`, `title`, `goal`, `startingPoint?`, `prerequisites` (ids of earlier units), `status` (`not-started` | `in-progress` | `completed`), `chatId?`, `goalReachedAt?`, `completion?` (`confirmed` | `early`), `completedAt?`, `handoff?`;
  - `handoff`: `writtenAt`, `completion`, `topics[]` (node id, title, computed status `solid` | `shaky` | `unchecked` | `not-reached`, computed reason), `observations?` (`judged[]`, `alsoShaky[]`, `misconceptionsRepaired[]`, `carriedForward[]`), and `writer` (`writing` | `ready` | `failed`, `error?`, `stopped?`, `model?`, `usage?`);
  - `proposals[]`: `id`, `chatId`, `unitId`, `toolCallId`, `at`, `reason`, `changes[]`, `status` (`pending` | `accepted` | `rejected` | `outdated`), `decidedAt?`;
  - `evidence[]`: typed events with unique ids (see item 5). Event types this build doesn't know are kept on rewrite.
- **Chat records** gain one optional field, `course`:
  - `{ role: "setup", courseId? }`, `{ role: "unit", courseId, unitId }`, or `{ role: "practice", courseId, unitId }`.
  - The chat version stays 2. The field is additive: older builds ignore it and keep it.
  - The course record decides membership. The back-pointer makes a session self-describing (which agent, which notes folder) and lets the app recover from a crash between the two writes.
- **Unit notes** live under the course. `noteStoreAt` is unchanged, and the notes service resolves each chat's folder: `data/courses/<courseId>/notes/<chatId>/` for a unit session, `data/notes/<chatId>/` for a standalone one.
- **Golden fixtures:** a course record (with every event type and a handoff) and a unit chat record under `tests/fixtures/golden-data/`.

## 1. Course record, store, and `progress.md`

**Change:**
- Contracts in `src/core/contracts/course.ts`: the record, units, handoffs, proposals, evidence events, and the chat `course` field.
- Pure core helpers:
  - unit-list validation (non-empty titles and goals; prerequisites only point to earlier units, so there are no cycles; the edit rules for started units);
  - applying a change list to a unit list;
  - the transitive prerequisites of a unit;
  - the handoff topic rule (decision 2);
  - rendering a handoff as text, and rendering `progress.md`.
- Store `src/store/courses.ts` (`PATHS.courses`): create, read, list, update by read-modify-write, and remove the folder, with the version guard.
- The `courses-changed` server event.

**Proposed `progress.md`:**

```markdown
# <course title>

Goal: <course goal>
Updated <date>. Written by LearnHarness Fork; edits to this file are not read back.

## Units

| # | Unit | Status | Builds on |
|---|------|--------|-----------|
| 1 | Vectors and span | Completed 20 Nov 2026 | — |
| 2 | Linear maps | In progress | 1 |
| 3 | Eigenvectors | Not started | 1, 2 |

## Pending course changes

<each pending proposal: its reason and changes, one line each>

## Handoffs

### 1. Vectors and span
<the handoff text, as the next unit's agent sees it>
```

**Tests:**
- validation: an earlier-only prerequisite is accepted and a forward reference refused; dropping or merging a started unit is refused, while renaming or reordering one is allowed;
- applying each change type to a hand-written list;
- transitive prerequisites on a diamond;
- the topic rule against hand-worked cases: right at 70% gives solid; right at 69% gives shaky with "right at 69% confidence"; wrong then right at 90% gives solid; right then wrong gives shaky; predict-only gives unchecked; an unvisited node gives not-reached;
- the store: round trip, version guard, damaged file, unknown event types kept, path safety;
- `progress.md` against a hand-written expected file;
- the golden fixture loads.

## 2. Course setup session

**Change:**
- **Start:**
  - "Course" becomes a third option on the home composer's switch and a third sidebar button, `/chat/new?mode=course`.
  - *Proposed placeholder:* "What do you want to learn in this course?"
  - Sending creates a teach-kind chat with `course: { role: "setup" }`. The learner's text becomes the first message, as with Teach.
- **Setup agent** (`AgentKind` `setup`):
  - *Prompt:* `system-prompt.md`, then the setup doctrine below, then the shared fragments (no prober doctrine).
  - *Tools:* the prober's quizzing tools (`probe` or `recall`), `ask_user_question`, read-only files, research/PDF dispatch, the gated graph readers, and `propose_course`. No `probe_done`, no plan tools.
  - *Agent-selected:* plugins see it as agent `prober`, so plugin question types keep working; the plugin API is unchanged.
  - The setup session is never extracted, as decided. *Agent-selected:* the chains view and practice picker hide it, like practice sessions.
- **`propose_course`:** a server-side tool that doesn't end the turn. Its input:
  - `title`, `goal`;
  - `units[]`, each with `key` (a slug), `title`, `goal`, `prerequisites` (keys of earlier units) and `startingPoint`.
  - It validates with item 1's rules and returns errors for the model to fix. Calling it again replaces the proposal.
- **Proposal card:**
  - The latest `propose_course` call renders as an editable card in the chat: the course title, goal, and units. Each unit shows its title, goal, starting point, and prerequisites as checkboxes over earlier units.
  - Units can be moved up or down, added, and removed.
  - "Create course" sits at the bottom. Older proposals render read-only, marked "Replaced".
  - *Agent-selected:* edits are kept on this device until the course is created.
- **Create:**
  - `POST /api/courses` takes `setupChatId`, the `toolCallId` of the proposal it came from, and the edited list. It is refused (409) while a turn runs in the setup session.
  - It creates the record and links the setup chat. It then starts unit 1 (item 4) and navigates there.
- **After creation:**
  - The setup session stays readable, and side questions still work.
  - *Proposed:* its composer is replaced by "This course has been created." with "Open course".
  - The server refuses new main input to a setup whose course exists (409).
  - The setup session has no notes, as decided (the notes routes answer 400 with "Course setup sessions have no notes."). It keeps "Export as HTML…".
- **Abandoned setup:** before creation, the setup session is an ordinary row with a course icon and the meta "Course setup". Deleting it is ordinary session deletion.

**Proposed setup doctrine (approve or edit):**

> # Course setup
>
> The learner wants to learn a large subject as a course: a sequence of units, each taught later in its own session with its own detailed probe. Your job in this session is the course plan: a coarse map of where he stands across the field, and the unit list that takes him from there to his goal. Never teach here.
>
> ## 1. Make the goal concrete — `ask_user_question`
>
> What does he want to understand or be able to do at the end? The goal bounds the course: everything on the path to it, nothing off it. Ask until it is concrete. If he doesn't know the terrain, record that the course starts with orientation.
>
> ## 2. A broad, coarse probe — the quizzing tool
>
> Sketch the major areas on the path to his goal. Locate him roughly in each: one or two questions per area, entering near the top and stepping down on a miss. This is a survey, not a bracket; each unit probes in detail later. Stop when every area is placed as held, partly held, or new.
>
> ## 3. Propose the units — `propose_course`
>
> Plan the course as a minimal tree at unit resolution: nothing he holds becomes a unit, nothing off the path becomes a unit, and the order lets each unit build on what came before. A unit is one coherent goal, sized for one session (a plan map of roughly five to fifteen nodes). For each unit give a short title, a one- or two-sentence goal, the earlier units it builds on directly, and its starting point: one or two lines on what your probe found that bears on it, or "new" when nothing did.
>
> Then explain the plan in a few sentences (why this order, what you left out because he holds it) and end your turn. He reviews and edits the list in the card and creates the course himself. If he asks for changes, call `propose_course` again with the whole revised list.

**Proposed `propose_course` description:** "Propose the course: its title, goal, and the ordered unit list. The learner sees it as an editable card and creates the course from it. Call again with the whole list to revise. Prerequisites may name only earlier units."

**Checkpoint (human), after items 2–3:** the agent shows screenshots of the setup proposal card, its edit state, the course overview, and the sidebar group, in light and dark. The look is approved before item 4.

**Tests:**
- the setup agent's composition (doctrine present; no prober doctrine and no `probe_done`) and its tools;
- `propose_course` validation errors go back to the model;
- create: the course record, the setup link, unit 1 started, 409 while a turn runs, and an invalid edited list refused;
- the server refuses main input after creation;
- setup sessions are not extracted and are hidden from the chains view;
- render tests: the card's edit controls, a replaced proposal, the post-creation band.

## 3. Course overview and sidebar groups

**Change:**
- **Route** `/course/[id]`, with tabs "Overview" and "Notes" (item 8). The top bar holds the course title (click to rename) and the progress ("3 of 8 units completed").
- **Overview:**
  - The goal.
  - Pending course changes (item 7).
  - The unit list in order. Each unit shows its number, title, status, "Builds on 1, 2", goal, and its starting point (muted), plus actions:
    - Not started: "Start unit".
    - In progress: "Open".
    - Completed: "Open", "Practice this unit", "Reopen unit", and a "Handoff" disclosure (item 6).
  - "Edit units" switches the list into the same editor as the setup card, applying decision 5. "Save changes" records a learner revision.
- **Sidebar:**
  - Each course is a collapsible group in the session list, placed by its most recent activity. The header row shows the title and "3/8". Clicking it opens the overview; its chevron collapses the group, remembered on this device.
  - Rows: "Setup", then every unit in order ("1 · Vectors and span", with the usual status meta).
  - *Proposed:* not-started units are muted rows that open the overview at that unit.
  - Groups show under "Teaching" and "All". Search matches course and unit titles.
  - *Proposed:* rows inside a group offer "Export as Markdown…" and "Export as HTML…" only. Renaming happens in the course view, and deletion is per course. The header's menu has "Rename course" and "Delete course…".
- **Routes:** `GET /api/courses` (the list for the sidebar), `GET/PUT /api/courses/:id` (read, rename, edit units).

**Tests:**
- route tests: rename, edits under decision 5, refusal of a newer record;
- render tests: overview actions per status, sidebar grouping, order, the filter, search, the collapsed state;
- the sidebar's unit rows have no Rename or Delete.

## 4. Unit sessions and their agent context

**Change:**
- **Start:** `POST /api/courses/:id/units/:unitId/start`.
  - It creates the unit's chat (title "<course title> · <n>. <unit title>", `course: { role: "unit", … }`). Message 0 is a `unit-start` marker, which counts as learner input because the learner clicked Start.
  - It records the chat id and `unit-started`, places the session's graph source in the course's folder (created at the first start and named after the course), and returns the chat id. The chat page sends `continue`, so the prober begins at once.
- **Prerequisite warning (Proposed wording):** "Unit 4 builds on unit 2 (Linear maps), which isn't completed yet. Start anyway?" with Cancel and "Start anyway". Several unfinished prerequisites are listed by number.
- **Agent context (agent-selected mechanism):** each turn of a unit session appends a course section to the prober's or teacher's system prompt, composed fresh from the course record. That keeps it current when a prerequisite is reopened or the list is revised, and compaction can't summarize it away. It holds:
  - the unit doctrine for that agent (below);
  - the course title and goal;
  - this unit's number, title, goal and starting point;
  - every unit on one line (number, id, title, status, builds on);
  - the full handoffs of this unit's direct and indirect prerequisites;
  - the decisions on this unit's own proposals.
- **Teacher tools in units:**
  - `goal_reached`, with a `summary` (one line). It records `goalReachedAt` and a `goal-reached` event, doesn't end the turn, and can be repeated.
  - `propose_course_changes` (item 7).
- **Closed units:** the server refuses main input to a completed unit (409 "This unit is completed. Reopen it to continue."). Side questions still work.
- **Top bar:** "<course title> › <n>. <unit title>", linking to the overview.

**Proposed `unit-start` text (model-facing):** "[Unit start] The learner opened unit <n>, <title>. Begin the unit's probe." The transcript shows a quiet line, "Unit <n> started".

**Proposed unit doctrine for the prober (approve or edit):**

> # This session is one unit of a course
>
> The course context below gives the course, its units, this unit's goal, the setup probe's starting point for it, and the handoffs from the units it builds on. The unit's goal is set: ask about it only if it leaves a real choice open.
>
> Before probing the unit's new material, briefly re-check what the handoffs mark shaky (or, if nothing is, what this unit leans on most): a question or two, not a re-probe. Trust what they mark solid. Then probe the new material as usual, starting from the starting point. Your `probe_done` assessment covers both the re-check and the new strands.

**Proposed unit doctrine for the teacher (approve or edit):**

> # Teaching one unit of a course
>
> Plan only this unit's goal, from the course context below. The plan may begin by repairing shaky prerequisites the probe confirmed.
>
> When the goal is reached (every node on the path to it taught and checked), call `goal_reached` with a one-line summary and tell him he can complete the unit whenever he's ready. Nothing closes: answer his final questions, give a review quiz if he asks, but start no new material beyond the goal.
>
> If the unit showed that the course plan should change (a missing unit, a unit he already holds, a better order), propose it once, at the unit's end, with `propose_course_changes`, giving the reason. He accepts or rejects it in the card; don't ask him to confirm in prose.

**Proposed `goal_reached` description:** "Record that this unit's goal is reached. The learner can then complete the unit. Nothing closes; the conversation continues."

**Tests:**
- start: the record, the source placement and folder reuse, the marker classified as learner input (a foreground request on a subscription-shaped fake), and a refused start for an already-started unit;
- crash recovery: a chat created before the course write is adopted on the next read;
- composition: the course section appears for both agents of a unit and is absent elsewhere; it lists only transitive prerequisites' handoffs, in full, with unrelated units on one line;
- the section changes when a prerequisite is reopened;
- `goal_reached` is recorded;
- input to a completed unit is refused;
- the prerequisite dialog wording.

## 5. Evidence capture

**Change:**
- `syncCourseEvidence(courseId)` reads the linked sessions and appends events missing from the record. Ids are stable (`<chatId>:<toolCallId>`, or a lifecycle id), so it is safe to repeat. It runs:
  - at each turn's settlement in a setup, unit, or linked practice session;
  - before a handoff is written;
  - when the overview loads.
- **Events:**
  - `answer`: `unitId?`, `chatId`, phase (`setup` | `probe` | `teach`), `tool`, `questionType?`, `nodeId?`, `nodeTitle?` (the title at that time), result (`right` | `wrong` | `dontKnow` | `skipped` | `ungraded`) and `confidence?`.
    - Setup answers have no unit.
    - `ask_user_question` answers are not evidence.
  - `unit-started`, `goal-reached`, `unit-completed` (`confirmed` | `early`), `unit-reopened`.
  - `revision`: source (`teacher` | `learner`), decision (`accepted` | `rejected`), proposal id, and a one-line summary per change.
  - `practice`: `practiceChatId`, `unitId`, `problemCallId`, `outcome`, `rung?`, `missClass?`, `targets?`.
- *Agent-selected:* `goal-reached` is recorded in addition to the decided list, because it is what separates confirmed from early completions for phase 2.
- **Kept on deletion:** events from a deleted "Practice this unit" session stay in the record.

**Tests** (fixture records with hand-worked expected events):
- each answer kind: right and wrong checks with confidence; don't know; skipped; predict; explain recorded as ungraded; a plugin question recorded as ungraded; a probe; a setup answer;
- an ask answer produces no event;
- repeating the sync adds nothing;
- a practice conclude produces a `practice` event;
- a deleted practice session's events remain.

## 6. Completing, handoffs, and reopening

**Change:**
- **Button:**
  - Before the teacher's signal, the unit's top bar has a quiet "Unit" menu with "Complete unit early…".
  - After `goal_reached`, a "Complete unit" button appears and stays.
- **Dialog (Proposed wording):**
  - Title "Complete this unit?".
  - Before the signal, it adds "The teacher hasn't marked the goal as reached. This is recorded as an early finish."
  - Optional checkboxes, off by default, as decided: "Generate a note", which reveals the phase-0 instruction box, and "Export full conversation".
  - Buttons: Cancel and "Complete unit".
- **Confirming:**
  - Refused (409) while a turn or a background job runs in the unit, as deletion is ("Wait for the running work to finish, then complete the unit."). Note writers don't block.
  - The unit becomes completed, with `confirmed` or `early`.
  - The topics part of the handoff is computed at once (decision 2), and the writer starts.
  - `progress.md` is regenerated.
  - The offers run: the note through the phase-0 service, and the export as a download of `export.html`.
- **After confirming, the dialog shows (Proposed):** "Unit completed." with "Open next unit: <n>. <title>" (the first not-started unit in order, with the prerequisite warning if needed) and "Back to course".
- **Handoff writer** (`handoffWriter` role, Strong slot):
  - It makes one `submit_handoff` call, with purpose `user`, in the shared worker pool. It appears in Background agents as "Handoff · <unit title>" with Stop.
  - *Input:* the course and unit title and goal, the completion type, the computed topic table with each node's checks, and the session text (phase 0's note source). *Agent-selected:* a session too long for the model's window uses its compaction summary and the text after the cut.
  - *Output, validated, with up to 3 fixes:*
    - `judged[]`, only for `unchecked` nodes, each solid or shaky with a reason;
    - `alsoShaky[]`;
    - `misconceptionsRepaired[]`;
    - `carriedForward[]`.
    - Each item is one line of at most 200 characters (*agent-selected*).
  - *Failure, Stop, or app closed:* the computed part stays. The handoff shows "Teacher observations couldn't be written: <error>" with "Try again" on the overview. The next unit can start meanwhile, and its context shows the handoff as it stands at each turn.
- **Reopen:**
  - "Reopen unit" sets the unit back to in progress, clears `goalReachedAt`, and records `unit-reopened`.
  - The old handoff stays until the next completion rewrites it. Any writer still running is stopped first.

**Proposed handoff text (what agents receive, and the overview shows):**

```text
Unit 2 · Linear maps: completed 20 Nov 2026 (early: before the teacher marked the goal reached)
Solid:
- Matrix of a linear map: last check right at 90% confidence
Shaky:
- Kernel and image: last check wrong
- Rank–nullity: last check right at 40% confidence
Not checked by a graded question:
- Change of basis
Not reached (carried forward):
- Similar matrices
Teacher observations (model-written):
- Change of basis looks solid: explained the conjugation correctly twice (judged from free-recall answers)
- Also shaky: mixes up column space and row space for non-square matrices
- Misconception repaired: thought every linear map is invertible; fixed with the projection example
- Carry forward: wants more 3×3 practice
```

**Proposed handoff writer prompt (approve or edit):**

> You write the handoff for one completed unit of a learner's course. Tutors of his later units read it before probing and teaching. It is a briefing, not a log: short, specific, one line per item.
>
> The app has already rated each plan topic from his graded checks. Add only what the transcript shows:
> - for topics with no graded check (free-recall or other ungraded answers only): solid or shaky, with a one-line reason;
> - anything else that looked shaky, with the reason; you may add topics the checks rated solid when the transcript shows a real gap;
> - misconceptions he showed that the unit repaired, and how;
> - what to carry forward: open questions, his requests, topics deferred.
>
> Use only what the transcript shows. Never call solid what the checks rate shaky. Leave a list empty when there's nothing to add. Call `submit_handoff` once.

**Checkpoint (human), after item 6:** screenshots of the completion dialog in both forms and of a handoff rendered from a fixture unit. The handoff's look and wording are approved before item 7.

**Tests:**
- completion records `confirmed` vs `early` from the signal, and the gates refuse while work runs;
- the computed topics match decision 2 on the fixture;
- the writer: a scripted submit is stored; `judged` on a checked node is refused back to the model; the 200-character rule; a failure keeps the computed part; Stop; interruption on restart; Try again;
- reopen clears the signal and stops a running writer;
- the dialog offers start the note writer and the export only when checked;
- the next-unit offer skips started units;
- the handoff text matches the expected text above for the fixture;
- the engine is resolved through `handoffWriter` from the Strong slot with purpose user.

## 7. Course revisions

**Change:**
- **`propose_course_changes`** (teacher, unit sessions only):
  - Input: `reason` and `changes[]` with `insert` (after a unit or at the start: title, goal, prerequisites), `drop` (unit), `move` (unit, after), `merge` (units, title, goal). Units are named by the ids shown in the course context.
  - It is validated against the current course and decision 5. A refusal goes back to the model with the rule that broke.
  - It stores a pending proposal and returns "The learner sees the proposal and decides."
- **Card:** in the chat, and in the overview's "Pending course changes". *Proposed wording:*
  - Header "Proposed course changes", then the reason.
  - One line per change: "Insert after 3: <title>", "Drop 5: <title>", "Move 6 after 2", "Merge 7 and 8 into: <title>".
  - Accept and Reject. A decided card shows "Accepted" or "Rejected".
- **Deciding:** `POST /api/courses/:id/proposals/:proposalId` revalidates against the current course. A proposal that no longer applies becomes "Outdated" with the reason, and nothing changes. Each decision records a `revision` event and regenerates `progress.md`.
- **Learner edits** (item 3) record `revision` events with source `learner`.

**Proposed tool description:** "Propose changes to the course's unit list, at the end of a unit: insert, drop, move, or merge units, with your reason. The learner accepts or rejects them. Started units can't be dropped or merged."

**Tests:**
- each change type applied on accept;
- refusals for dropping or merging a started unit and for a forward prerequisite;
- outdated detection after a conflicting learner edit;
- reject changes nothing;
- each decision is recorded as evidence;
- render tests for the card states.

## 8. Unit notes, the course Notes tab, and "Practice this unit"

**Change:**
- **Notes service:**
  - Resolves each chat's notes folder (see Storage).
  - Refuses setup sessions.
  - Session deletion, the archive, and the notes chip use the resolver.
- **Course Notes tab** (`/course/[id]/notes`):
  - It reuses the phase-0 notes page. The left column lists notes grouped under unit headings in course order, plus "New note" with a unit picker that defaults to the unit last viewed.
  - The right pane is the same sandboxed viewer and toolbar. "Export conversation (HTML)" exports the selected note's unit.
  - A unit's "Notes" chip opens this tab with that unit selected, as decided ("unit notes appear in the course's Notes tab").
- **Course notes archive:** `/api/courses/:id/notes/archive.zip`, with one folder per unit (`<n>-<unit-slug>/`), named `<course-slug>-notes.zip`.
- **"Practice this unit":**
  - It opens the Practice draft with the unit attached, shown as a chip like graph picks.
  - *Proposed:* the composer is prefilled with "Practice unit <n>: <title>".
  - Sending creates a Practice session with `course: { role: "practice", … }`. Its context marker holds the unit's title, goal, plan topics, and the handoff's shaky items (decision 4), plus the unit's graph propositions when it has been extracted, in the existing `[id] name: statement` form so `problem` can target them.
  - The session is an ordinary Practice session in the flat list.

**Proposed practice context text (model-facing):**

```text
[Session context] — practice for a unit of the learner's course, chosen by the learner:
Course: <title>. Unit <n>: <title>.
Unit goal: <goal>
Topics the unit taught: <plan node titles>
Shaky at the end of the unit: <one per line, or "none recorded">
Propositions (id — name: statement; the problem tool's target field uses these ids):
- [n_…] <name>: <statement>
```

The propositions block is left out when the unit has none.

**Tests:**
- the resolver puts unit notes under the course and standalone notes where they were (existing phase-0 tests still pass);
- setup sessions are refused;
- the archive's folder layout, read back with the test's minimal zip reader;
- render tests for the grouped list and the unit picker;
- the practice marker, with and without propositions, and with the graph off;
- a practice session's link produces `practice` evidence (item 5).

## 9. Course deletion

**Change:**
- **Dialog (Proposed wording, mirroring session deletion):**
  - Red title "Delete course?".
  - The line "This deletes the course, its setup session, its <n> unit sessions, and their <m> notes."
  - The unchecked checkbox "Also remove their graph traces", with the session dialog's explanation adapted to "these sessions".
  - "Download notes" (the course archive), Cancel, and Delete.
- **`DELETE /api/courses/:id?mode=…`:**
  - It is refused (409) while any of the course's sessions has a running turn or background job, naming the session.
  - It stops the course's handoff writer and note writers.
  - It deletes each session through the existing deletion (the setup session first, then the units). It then removes the course folder (record, `progress.md`, notes) and finally the graph folder, if it's empty.
  - A crash part-way leaves a course whose missing sessions count as already deleted, so running Delete again finishes.
- *Proposed:* linked "Practice this unit" sessions are kept and become standalone (their link is ignored once the course is gone).

**Tests:**
- every file removed;
- both graph modes applied per session;
- the 409 gates;
- a rerun after a simulated partial failure;
- other courses and standalone notes untouched;
- linked practice sessions kept;
- the dialog's counts and the "Download notes" link.

## 10. Docs

- **Fork README:**
  - decisions from the plan's approval;
  - feature status and roadmap step 4 marked done when it lands;
  - pending human checks.
- **`docs/architecture.md`:**
  - the courses storage row and its version guard;
  - course sessions (setup and units) and the per-turn course context;
  - the handoff writer in the worker pool and Background agents;
  - the evidence sync.
- **`docs/development.md`:** `handoffWriter` in `LH_BACKGROUND_CAPTURE`.
- **`src/agent/prompts/README.md`:** where the setup doctrine, unit doctrines, and handoff writer prompt live. *Proposed:* they are fixed in code for phase 1 and are not Settings → Prompts segments.

## Verification

- **After each item:** the required gate (typecheck, tests, lint).
- **After items 2, 6 and 9:** also `npm run build` and `scripts/smoke-server.mjs`.
- **Browser check (agent), after items 3, 6, 8 and 9:** a dev server on a scratch profile (`LH_DATA_DIR` and `LH_AUTH_FILE` in the scratchpad), driven by the local fake OpenAI-compatible endpoint from plan 03. It scripts:
  - a setup run with a proposal, then editing and creating the course;
  - unit 1's probe, plan, checks, and `goal_reached`;
  - completion with both offers, and the handoff;
  - unit 2 starting with unit 1's handoff in its request (checked in the fake endpoint's received system prompt);
  - a proposal accepted;
  - "Practice this unit";
  - deleting the course.
  - Screenshots go to the human at the two checkpoints.
- **Human checks:**
  - a real setup and a real unit on your own provider;
  - completing that unit and reading its handoff;
  - opening `progress.md` outside the app.
- **Safety:** nothing reads or writes `~/.config/LearnHarness` or `~/.config/LearnHarness-Fork`. Tests use fakes and fixtures. No paid providers, no real sign-ins, and no dependencies added.

## Finishing

- **Commits:** one per item, in order, on `phase1-courses`.
- **Checkpoints:** after items 2–3 (setup card, overview, and sidebar look) and after item 6 (completion dialog and handoff). Each is approved before work continues.
- **Completion report per item:** what changed, checks and results, human checks still owed, and agent-selected choices.
- If implementation raises a product question this plan doesn't settle, work stops and the question goes to the human.

## Outcome

### Item 1 (2026-11-13)

- **Built:**
  - Contracts in `src/core/contracts/course.ts`: the record, units, handoffs, proposals, the seven evidence event types, the chat's `course` back-pointer (added to `ChatRecord` and `ChatSummary`), and the sidebar's `CourseSummary`.
  - Pure rules and texts in `src/core/course.ts`, exported through the core barrel: list validation, learner edits (`applyUnitEdit`), change lists (`applyCourseChanges`), transitive and unfinished prerequisites, the topic rule (`handoffTopics`), `handoffText`, `courseChangeLine`, and `progressMarkdown`.
  - The store `src/store/courses.ts` at `data/courses/` (`PATHS.courses`): create, get, list, update, remove, with the version guard. Every write regenerates `progress.md`.
  - The `courses-changed` server event.
  - A golden course record under `tests/fixtures/golden-data/courses/`.
- **Agent-selected:**
  - **Ids:** unit ids are readable slugs from the setup key or title (`linear-maps`, then `linear-maps-2`), because agents name units by them. Course ids follow the chat pattern (`course_<time>_<random>`).
  - **Learner edits:** the editor sends the whole list. Existing units are matched by id and keep their status, session and handoff; new units get fresh ids, and a new unit can build on another new one through a `new:<index>` placeholder.
  - **Change semantics:** a dropped unit's dependants inherit its prerequisites, so handoffs keep flowing. A merged unit takes the place of the earliest merged unit, the union of their prerequisites, and their starting points joined; units that built on a merged unit build on the new one.
  - **Topic rule details:** skipped checks are ignored. A right check with no recorded confidence (only possible in old records) is shaky. Unchecked topics remember whether their evidence was free-recall only, other ungraded answers, or nothing, and the writer's judgment line says "(judged from free-recall answers)", "(judged from ungraded answers)" or "(judged from the transcript)" accordingly.
  - **Wording the plan didn't specify:**
    - Topic reasons: "last check answered “don't know”" and "last check right, with no confidence recorded".
    - A unit with no plan: "No plan topics were recorded."
    - Change lines: "Insert at the start: <title>", "Move <n> to the start", and three-way merges as "Merge 2, 3 and 4 into: <title>".
    - Validation problems, for example "Unit 1 (Vectors) builds on unit 2 (Maps), which comes after it. A unit can only build on earlier units." and "Unit 2 (Maps) has started, so it can't be dropped."
  - **`progress.md`:** empty "Pending course changes" and "Handoffs" sections are left out. Each pending proposal is a bullet with its reason and nested change lines. Dates read "20 Nov 2026" in local time, pipes in table titles are escaped, and model-written observations appear only once the writer has finished.
  - **Store:** a failed `progress.md` write is logged and never fails or undoes the record write. `list` reports unreadable course folders separately. Every update stamps `updatedAt`. `courses-changed` is emitted on every write and removal.
  - **Plugin API reference:** regenerated (`docs/plugin-api/`). The chat record's `course` field shows as a supporting declaration and `courses-changed` joins the event list; no callable API was added.
  - **Golden record:** no session can produce a course yet, so the record was written by the real store from a scripted record (topics computed by the real rule). The unit chat record follows once unit sessions exist (item 4).
- **Checks:**
  - Typecheck passed. Lint passed with the inherited warning.
  - Full suite: 5,458 pass, 1 fail, 4 skipped. The failure was `tests/plugin-api-reference.test.ts`, which pins the generated reference; after regeneration it passes alone (4/4).
  - New tests: `tests/courses.test.ts` (23), with every expected value worked by hand. They include the plan's proposed handoff text verbatim, rebuilt from evidence through the topic rule, and a hand-written `progress.md`. The golden course case in `tests/golden-fixtures.test.ts` also passes.
- **Human checks owed:** none for this item (no UI).

### Item 2 (2026-11-13)

- **Built:**
  - "Course" as the third start option: the home composer's switch, the sidebar's third button, and `/chat/new?mode=course`, with the approved placeholder. `POST /api/chats` accepts `course: { role: "setup" }`.
  - The setup agent (`AgentKind` `setup`, `createSetupAgent`): the shared base, the approved setup doctrine verbatim, then the shared fragments. Its tools are the prober's minus `probe_done`, plus `propose_course` with the approved description. The doctrine is fixed in `src/agent/course-prompts.ts`.
  - `propose_course` (`src/agent/tools/course.ts`): validated with item 1's rules, refusals return to the model, and it doesn't end the turn.
  - The proposal card (`components/artifacts/course-proposal-card.tsx`) and the shared unit editor (`components/course-unit-editor.tsx`), with the editor rules in core (`parseCourseProposal`, `draftProblems`, `canMoveDraftUnit`, `moveDraftUnit`, `removeDraftUnit`, `togglePrerequisite`).
  - `POST /api/courses` on the course service (`src/server/courses.ts`): it creates the record, links the setup session, starts unit 1, and opens it.
  - After creation: the composer becomes "This course has been created." with "Open course", and the server refuses new input.
  - The `unit-start` marker: learner input that the chat page continues from at once, shown as a quiet line (rendering arrives with item 4's chrome).
- **Agent-selected:**
  - **Prompt composition:** the base and shared fragments honor Settings → Prompts overrides by their usual keys; the setup doctrine has none. The `send_to_user` output tool applies to the setup agent as it does to the prober, for models that need it.
  - **`propose_course` wording the plan didn't specify:** its success result reads "The learner sees the proposal as an editable card and creates the course from it." The input fields have one-line descriptions, and the live card reads "Proposing the course…".
  - **Unit ids** are slugs of the units' (possibly edited) titles; the proposal's keys only name prerequisites.
  - **Unit 1 starts inside course creation**, so the basics of starting a unit landed here. Its session is titled "<course> · <n>. <unit>", stamped with the Strong slot's model like any new session, and opened by its `unit-start` marker. The course records `unit-started` (id `unit-started:<chatId>`). Item 4 adds the route, source placement, warning, and agent context.
  - **Refusals:**
    - Creation refuses "This course has already been created." and "This proposal was replaced. Create the course from the latest one." A running turn reuses the deletion wording.
    - A closed setup session answers 409 "This course has been created. Continue in its units." to learner input. A job result's wake gets 410 instead, which leaves the delivery pending; a 409 would make the wake pipeline retry it forever.
  - **Crash recovery:** a setup session whose link wasn't written is adopted from the course's `setupChatId`.
  - **Card details:**
    - An "Edited" badge appears while this device holds edits.
    - A unit can't move past a unit it builds on (uncheck first), and removing a unit unchecks it in later units.
    - Field labels read "Goal", "Starting point", "Builds on", and "Add unit".
    - A replaced proposal is collapsed; the created proposal is read-only with "Course created"; a refused call renders nothing.
  - **Draft copy:** "New course", with "The teacher will pin down your goal, check broadly what you already know, and propose the course's units for you to edit."
  - **Course icon:** a graduation cap on the switch, the sidebar button, and setup rows. A setup row reads "Course setup · <time>" (or "Waiting for input"/"Working…").
  - **No extraction:** setup sessions hide the coverage ring, and the manual extract route refuses them ("Course setup sessions aren't extracted."). Their notes chip is hidden and their notes page redirects. Chains and the practice picker hide them through a new `courseRole` on source entries.
  - **Test seam:** the handler passes the chosen `agentKind` to its `buildAgent` test seam.
  - The `unit-start` details type lives in `native-messages.ts`: importing it from the course contracts pushed the plugin view context's deep readonly type past TypeScript's instantiation limit.
  - The plugin API reference was regenerated (`LhMarkerMessage` lists `unit-start`).
- **Checks:**
  - Typecheck passed. Lint passed with the inherited warning.
  - Full suite: 5,477 pass, 1 fail, 4 skipped. The failure was the stale generated API reference; after regeneration it passes alone (4/4).
  - New: `tests/course-setup.test.tsx` (19). It covers composition and tools; a scripted turn where a forward-reference proposal is refused back to the model and a valid one follows; creation (record, ids, link, unit 1's session and marker, evidence, `progress.md`); the 400/409 refusals; route answers; crash adoption; closed-session refusals with no model call; extraction and chains exclusion; no notes; the start surfaces; the editor rules; and the card, replaced, created, and band renders.
  - `npm run build` passed with the inherited `pdf-read.ts` tracing warning. `scripts/build-server.mjs` and `scripts/smoke-server.mjs` passed.
- **Known limits until later items:** "Open course" points at `/course/<id>`, which arrives in item 3. Unit sessions run as ordinary probes until item 4 adds their course context.
- **Human checks owed:** the checkpoint after item 3 covers this item's look.

### Item 3 (2026-11-13)

- **Built:**
  - The overview at `/course/[id]` (`components/course-overview.tsx`). The top bar carries the title (click to rename), "N of M units completed", and the Overview | Notes tabs; below are the goal and the unit list. Each unit shows its number, title, status, "Builds on …", goal and starting point, with "Start unit" or "Open".
  - "Edit units" opens the setup card's editor, where started units can't be removed. It ends in "Save changes" and Cancel.
  - Routes: `GET /api/courses` (`{ courses, unreadable }`), `GET`/`PUT /api/courses/:id` (rename, edit units), and `POST /api/courses/:id/units/:unitId/start`.
  - A learner's edit records a `revision` event, source `learner`.
  - Sidebar course groups (`components/session-list.ts` for the rules, `CourseGroup` in `components/sidebar.tsx`), as planned. Each header has a collapse chevron (remembered on this device), the title, and "completed/total". Inside are "Setup" and every unit; units that haven't started are muted and open the overview at that unit. Groups show under Teaching and All, and search matches course and unit titles.
  - Grouped rows offer the two exports only, and the header menu has "Rename course".
- **Agent-selected:**
  - **What lands in later items:** the start route landed here because the service existed. The prerequisite warning comes in item 4; "Practice this unit", "Reopen unit" and the handoff disclosure in items 6 and 8; "Pending course changes" in item 7; the Notes tab's page in item 8; "Delete course…" in item 9.
  - **Search:** a course-title match shows the whole group, while a unit-title match shows only the matching rows. Groups open while searching, and the search walk covers headers and rows.
  - **Ordering:** groups sort by the latest activity of the record or any member session.
  - **Revision lines:** "Added 2: …", "Renamed 3: … → …", "Changed the goal of …", "Changed the starting point of …", "Changed what 3 builds on: …", "Removed: …", and "Reordered the units". Saving an unchanged list records nothing.
  - **Renaming a course** leaves its sessions' titles as they were (a unit session is titled when it starts).
  - **Wording the plan didn't specify:**
    - Section labels "Goal" and "Units"; status labels "Not started", "In progress", "Completed"; buttons "Edit units", "Save changes", "Cancel".
    - A started unit's disabled remove button reads "This unit has started and can't be removed".
    - Sidebar rows that haven't started read "Not started".
  - **Look:**
    - Titles, goals and starting points use the prose font.
    - Editor fields use rings instead of borders, because the app's unlayered `* { border-color }` rule overrides every border-color utility (`border-transparent` included).
    - Once its course exists, the setup proposal card collapses like a replaced one, since the edits live in the course.
- **Checks:**
  - Typecheck passed. Lint passed with the inherited warning.
  - Full suite: 5,491 pass, 0 fail, 4 skipped. New: `tests/course-overview.test.tsx` (13), covering route rename, edits under decision 5 with revision evidence, the version guard, list, single start, the edit summary, unit cards per status, tabs, and the sidebar's grouping, order, filter, search, collapse, rows and menus.
  - **Browser check:** the dev server (`npm run dev`, port 3001) on a scratch profile (`LH_DATA_DIR`, `LH_AUTH_FILE` and `XDG_CONFIG_HOME` in the scratchpad), backed by a local fake OpenAI-compatible endpoint connected as a keyless custom endpoint.
    - The browser was the desktop engine, Electron 44, launched as a scratch host (offscreen window, own profile, remote debugging) and driven by the repo's `puppeteer-core`.
    - The full flow ran in two themes: Ivory for light and Default for dark, since the app has themes rather than a light/dark switch. It covered starting a course from the Course draft, the real setup agent's `propose_course` card (its request carried the setup doctrine and not the prober's), editing (rename, add a unit, a builds-on checkbox, the "Edited" badge), Create course opening unit 1 where the prober replied, the overview, the sidebar group, "Edit units" with the started unit's remove disabled, and the closed setup session with its band.
    - Only the dictation token's expected 503 appeared in the console.
- **Found, inherited, not fixed (dev tooling only):**
  - **Helium:** in the Chromium build the Playwright MCP uses, every POST from a page takes about 4 seconds and the page then reloads. This happens on `main` too, in dev and production, while Electron is unaffected; the checks therefore use Electron.
  - **Playwright MCP logs:** the MCP writes its logs into `.playwright-mcp/` inside the repo, which makes `next dev` rebuild and reload in a loop. Agents should not drive the dev server with it.
  - **Self-sustaining rebuild loop:** once, `next dev` rebuilt every few hundred milliseconds with no source change, plausibly because the inherited whole-project trace (`pdf-read.ts`, reached through the server barrel) watches `.next/dev`. Deleting `.next/dev` and restarting cleared it.
- **Checkpoint review:** delegated to the agent by the human; see the review and repairs below.

### Checkpoint 1 review and repairs (2026-11-13)

The human requested a visual and code review of items 1–3 and delegated the decisions and repairs. Reviewed commits `93fd613`, `0871f95`, and `4cc94b9`, their callers and existing tests, all 16 supplied screenshots, and the resulting repair diff. The existing visual direction is retained. Items 4–9 remain pending, with only the interrupted-start recovery brought forward from item 4 because item 3 already exposes starting units.

**Findings repaired:**
- **P1, course store:** a valid JSON record whose embedded id names a different course could redirect an update into that other course. Malformed nested unit data could also escape the damaged-record guard and break the sidebar or overview. Reads now check the folder identity and structures used by this build; damaged records are refused and their bytes preserved, along with unknown fields and evidence types in valid records.
- **P1, learner edits:** saving an old editor snapshot could silently drop units another window had added. The editor sends its opening `updatedAt`; a changed course returns 409, retains the local draft, and explains how to reopen the latest editor. Refusal also fetches the latest record: the browser check deliberately masks the live update, then verifies Cancel → Edit units → Save succeeds while retaining the concurrent unit. That recovery check failed before the explicit fetch.
- **P2, interrupted start:** a chat created before the course write was left ungrouped, and a later Start could create another session. Course and sidebar reads now adopt the existing linked chat, repair an empty chat's opening marker, preserve existing transcripts/model choices, and record the start once. Existing published memberships are never replaced.
- **P2, validation:** proposal keys were converted to stored ids before validation, allowing duplicate keys or an unknown reference that happened to match a generated slug. Validate the draft first. An edit naming an unknown existing unit is now refused instead of creating a replacement implicitly.
- **P2, partial updates:** a PUT carrying both title and units could rename the course and then reject the units. One synchronous service operation validates the full request before publishing it; no-op edits still create no revision, and revision ids use UUIDs.
- **UI:** failed overview renames retain the draft and focus for retry; sidebar rename errors are visible. Creating a course refreshes an already-open setup in another window so its composer closes. The Notes placeholder is disabled until item 8 supplies its destination. Narrow layouts preserve the title/progress and place unit actions below their content; unstarted rows and editor labels use stronger existing theme colors.

**Tests:** six focused regressions extend the existing course files: record identity/structural damage, invalid proposal keys, atomic combined edits, stale snapshots/unknown ids, interrupted publication, and recovery before the opening marker. Failure injection exercises the real filesystem/store boundary and preserves the original transcript. The initial regression run failed on the original implementation and passed after the repairs. The Notes tab's existing render check now covers its unavailable and available states.

The full gate also exposed two inherited timing assumptions. The atomic-write test now checks that a directory error is not retried and leaves the directory intact, rather than imposing a 50 ms disk-write deadline. The import-route test holds the first import until three workers have started and a sibling has freed a slot for the fourth, verifying completion order without racing 1 ms and 25 ms timers. Both focused files pass. No production change accompanies these two test repairs.

**Browser verification:** the production build on a fresh scratch profile, a local fake keyless endpoint, and Electron 44 driven by the existing `puppeteer-core`. The development server reproduced the previously noted rebuild/chunk-load instability, so the final browser checks use the built server. Tests exercise setup, the real agent's proposal, editing/adding a prerequisite, creation and unit 1, the overview and editor, locked removal, sidebar groups, and the closed setup; a second window closes its setup after creation. Additional assertions cover rename focus/Escape, simulated save failure and retry, stale-edit preservation, a fresh revision, persisted collapse, unit-title search and keyboard navigation to the unit anchor, and visible sidebar rename failure. Both themes are checked at 1,400, 640, and 375 pixels with no horizontal overflow and the standard 60 px header. No paid provider or real learning profile is used.

**Final verification:**
- Typecheck passed. Lint passed with the one inherited warning in `tests/source-name-ui.test.tsx`.
- Full suite: **5,497 passed, 0 failed, 4 skipped** (5,501 tests). The focused course regressions and both repaired timing-sensitive files also pass.
- Production build passed with the inherited `pdf-read.ts` tracing warning. The built app completed the setup-to-unit flow in Ivory and Default; the additional browser assertions above passed with no page exceptions. Expected dictation-token 503s and deliberately simulated save failures are excluded from product failures.
- Screenshot gallery: `/tmp/lh-course-review/shots/index.html`. Logs and the scratch browser harness are under `/tmp/lh-course-review/`; the original supplied gallery remains unchanged.
- Changes remain uncommitted on `phase1-courses`. No dependency or storage-version changes, paid model calls, real learning data, releases, or packaging changes. The inherited development rebuild/chunk-load issue remains; the final runtime evidence is from the production server.

No known in-scope review findings remain. The remaining plan items are still pending, including unit context and prerequisite warnings, completion/handoffs, evidence capture, course revisions, unit/course notes, and course deletion.

### Item 4 (2026-11-13)

- **Built:**
  - **Starting a unit** (`startUnit`, behind `POST /api/courses/:id/units/:unitId/start`) now also places the session's graph source in the course's folder. The folder is created at the first start, named after the course, recorded as `sourceFolderId`, and reused after. The interrupted-start recovery from the checkpoint review places adopted sessions the same way.
  - **The course section:** each turn of a unit session appends a course section to the prober's or teacher's system prompt, composed fresh from the record (`unitCourseContext` in core, `unitTurnCourse` in the course service, the `course` build option in `teacher-agent.ts`). It holds the approved unit doctrine for that agent, the course title and goal, this unit's number, title, goal and starting point (labeled as the setup probe's read), every unit on one line, the full handoffs of the unit's direct and indirect prerequisites, and the decisions on this unit's own proposals. The compaction estimate counts it.
  - **`goal_reached`** for the unit teacher, with the approved description. It records `goalReachedAt` and a `goal-reached` event, doesn't end the turn, and can be repeated. `goal_reached` joins the reserved conversation tool names.
  - **Closed units:** main input to a completed unit is refused with 409 "This unit is completed. Reopen it to continue." (a job delivery's wake gets 410, as for a closed setup). The chat page shows the closed band with that sentence and "Open course".
  - **Unit chrome:** the top bar reads "<course title> › <n>. <unit title>" and links to the overview; the transcript shows "Unit <n> started" for the opening marker.
  - **The prerequisite warning** before starting a unit whose direct prerequisites aren't all completed, with the approved wording, Cancel and "Start anyway" (`prerequisiteWarning` in core).
  - **Golden fixture:** a unit session record (`chats/chat_mwflszug_5a1f29dc.json`), and `unit-start` joins the golden marker coverage.
- **Agent-selected:**
  - **Section format:** a "# Course context" heading after the doctrine, units listed as "<n>. <id>: <title> (<status>; builds on …)", "(…, this unit)" on the session's own unit, and "Starting point (the setup probe's read): none recorded" when a unit has none. A prerequisite without a handoff reads "Unit <n> · <title>: <status>, no handoff yet."; a reopened one reads "Unit <n> · <title> was reopened and is in progress. Its last handoff:" followed by that handoff. Own proposals list as "- <Status>: <reason>" with indented change lines; a pending one reads "Pending (the learner hasn't decided)". The section closes the app's own prompt, before plugin instructions.
  - **Membership:** only the session the course records for a unit gets the section and the unit chrome. A crash's duplicate stays an ordinary session. If the course record can't be read, the unit's input is refused with "This session's course can't be read: <reason>" instead of running without its course.
  - **`goal_reached` details:** the summary is collapsed to one line. The first signal's time is kept until a reopen clears it, and every call records its own event (id `goal-reached:<chatId>:<toolCallId>`). The model reads "Recorded. The learner can complete the unit whenever he's ready; the conversation continues.", or the refusal when the unit was completed meanwhile. The live activity reads "Recording the goal…".
  - **Transcript line for the signal:** a quiet "Goal reached" line with the summary under it.
  - **Folder placement:** a source the learner already placed stays where it is, a removed course folder is recreated at the next start, and a placement failure is logged without blocking the start. The folder keeps its name when the course is renamed.
  - **Chat page:** the unit's view stays live through `courses-changed` (it refetches the course rather than refreshing the page mid-turn). F2 doesn't rename a unit session.
  - **Warning dialog:** focus starts on Cancel. Several unfinished prerequisites read "units 2 and 3, which aren't completed yet".
- **Assumption checked (human decision):** the prerequisite handoffs exceed the plan's "few thousand tokens" estimate. For the last unit of a fully chained course, typical handoffs (10 topics, one model-written note per list) measure about 5k tokens at 15 units and 6.7k at 20; with every model-written list full at the 200-character cap, 9k and 12k. Asked, the human kept the section uncapped, as planned.
- **Checks:**
  - Typecheck passed. Lint passed with the inherited warning.
  - Full suite: 5,517 pass, 0 fail, 4 skipped.
  - New: `tests/course-units.test.tsx` (19). It covers:
    - start (the record, placement, folder reuse and recreation, a learner-placed source left alone, adoption placement, a refused second start, and the opening turn prepared as a foreground request);
    - the section against a hand-written expected text (only transitive prerequisites' handoffs, in full; an unrelated unit on its line only; own proposals only), no-handoff and reopened prerequisites;
    - the prober's and teacher's prompts through the turn handler, with the section changing on the next turn after a prerequisite is reopened, and absent from a standalone session and a duplicate;
    - `goal_reached` recorded, non-terminating and repeatable, and refused once the unit is completed;
    - the completed-unit and unreadable-course gates;
    - the warning wording and dialog body, the breadcrumb, the quiet lines, and the closed band.
  - Golden suite: the unit record parses, flattens to a legal wire, and carries its link, opening marker and successful `goal_reached`.
  - **Browser check** (not required by the plan for this item; done because it changes the UI): the dev server on a scratch profile with the fake keyless endpoint, driven in Electron 44, in Ivory and Default.
    - **Flow:** setup, Create course, then unit 1. The top bar read "Linear algebra › 1. Vectors and span" and linked to the overview; "Unit 1 started" showed. The prober concluded and the probe's handoff woke the teacher, which planned and called `goal_reached`. "Goal reached" showed with its summary, and the course recorded `goalReachedAt` and the event.
    - **Interactions:** F2 opened no rename. On the overview, Start on unit 3 showed "Unit 3 builds on unit 2 (Linear maps), which isn't completed yet. Start anyway?". Cancel closed it; "Start anyway" opened unit 3.
    - **What the endpoint received:** the unit prober's requests carried the prober unit doctrine and the course section, and the teacher's carried the teacher doctrine with `goal_reached` among its tools. Unit 3's section listed both prerequisites as "no handoff yet". Setup requests had no course section.
    - **Console:** only the dictation token's expected 503s. The first light-theme run timed out while the dev server compiled its first routes; the rerun passed.
    - **Screenshots:** `08-unit1-start`, `09-unit1-goal-reached`, `10-prerequisite-warning`, `11-unit3-chat` (light and dark) in the session's scratch gallery.
  - **Deviation:** the plan asks for the opening turn as "a foreground request on a subscription-shaped fake". The test asserts the prepared request's purpose (`callPurpose.background === false`), which is what the subscription gate reads, on the faux engine, rather than standing up the desktop subscription bridge.
- **Golden fixture:** written by the real course service and turn handler against a scratch copy of the golden directory, with a scripted (faux) model. Only the chat record was copied in. The existing golden course record was left untouched (its unit 3 still reads not started), so reading the pair through the course service adopts the session as an interrupted start; the fixture README says so.
- **Known limits until later items:**
  - The teacher's approved doctrine names `propose_course_changes`, which arrives with item 7. Until then a call to it fails as an unknown tool.
  - Notes written in a unit session are still stored in the standalone notes folder; item 8's resolver moves unit notes under the course.
  - A completed unit can't occur until item 6 adds completion, so the closed band and the 409 are covered by tests only.
- **Human checks owed:** none required by the plan for this item (the next checkpoint follows item 6).

### Item 4 review repairs (2026-11-13)

The human authorized fixing all four findings from the review of `8a99874`. These repairs leave items 5–10 pending and remain uncommitted on `phase1-courses`.

- **Compaction:** changing course sections now contribute their growth beyond the saved response's usage anchor. Prompt-size baselines stay in memory and are tied to response ids; an unknown baseline after restart conservatively adds the full current section until a fresh response measures it. A new live response already measures its current section, and the post-compaction heuristic counts the whole prompt once. Request preflight, side-question admission, and the settlement kick share this accounting. Failed/aborted responses preserve the last usable baseline.
- **Request preparation:** completed-unit refusal is checked again after asynchronous preflight, before input is saved or turn ownership is claimed. A course section changed during preflight is refreshed and checked against the compaction budget before proceeding.
- **Reconnects:** unit chrome refetches its course when the notification channel reconnects, including changes missed while disconnected.
- **Interrupted starts:** newly created course folders use a stable id derived from the course id. Recovery finds that identity even if the course write never recorded it or the learner subsequently moved the session. Existing recorded folder ids and learner placements are retained. This changes id generation only, with no new storage fields or version.
- **Regression coverage:** six tests extend the existing unit-session and compaction suites. They cover interrupted folder publication (with and without a learner move), completion during preflight for learner and automatic requests, prompt refresh and saved-response bookkeeping, hand-worked prompt-growth estimates, compaction through both entrypoints, and baseline retention through failed turns and compaction. The original folder/completion and prompt-growth/compaction-trigger checks failed before their fixes and passed afterward.
- **Quality gate:** typecheck passed; lint passed with the inherited warning in `tests/source-name-ui.test.tsx`; full suite **5,523 passed, 0 failed, 4 skipped** (5,527 tests). Focused course, compaction and side-question budget checks passed.
- **Runtime verification:** the production build passed with the inherited `pdf-read.ts` filesystem-tracing warning. On a scratch profile with no configured model, Playwright reproduced the original offline rename scenario and verified that the sidebar and unit breadcrumb both update after reconnect. Additional seeded completed/reopened states, refreshed by explicitly dispatching the channel's `open` event, replaced the composer with the closed band and restored it correctly. These checks do not implement or exercise item 6's pending lifecycle routes.
- **Development limitations:** the default development bundler stalled on the chat page, and an attempted Webpack fallback hit the inherited `node:crypto` import through the core barrel. The generated development cache was moved to the scratch directory; final browser evidence uses the successful production build. Build/server logs and scratch data are under `/tmp/lh-item4-fixed-browser/`. No dependency, configuration or storage-format changes, paid model calls, or access to real learning profiles.

### Item 5 (2026-11-13)

- **Built:**
  - `syncCourseEvidence(courseId)` in the course service. It reads the setup session, each unit's recorded session, and the "Practice this unit" sessions linked to the course, and appends the events the record lacks. The transcript readers are pure, in `src/core/course-evidence.ts` (`sessionAnswerEvidence`, `sessionPracticeEvidence`).
  - **Where it runs:**
    - at each turn's settlement in a setup, unit, or linked practice session, including a failed settlement, reading only that session;
    - at course creation, for the setup probe's answers (the setup session closes then, so no later settlement would bring them in);
    - when the overview page opens (its server render), as a full sync.
    - Item 6 calls it before writing a handoff.
  - **Answer events:** every answered `probe`, `recall`, `quiz`, `explain` and plugin question, as planned. `ask_user_question` answers produce none.
  - **Practice events:** one per concluded problem, with the conclude's outcome, rung and miss class plus the problem's targets.
- **Agent-selected:**
  - **Results:**
    - A multiple-choice answer (`probe`, `quiz`) is right or wrong from its stored verdict.
    - Free recall (`recall`, `explain`) and plugin answers are ungraded.
    - "Don't know" is `dontKnow` for multiple-choice tools. Free recall stays ungraded, including a teach-side check answered "don't know" (corrected in the human-authorized item 5 review follow-up below).
    - A learner's dismissal is `skipped`, for native and plugin questions alike. A plugin protocol cancellation (an incompatible or unreadable plugin) records nothing, since it says nothing about the learner.
  - **Fields:**
    - The phase is `setup` throughout the setup session. Elsewhere it comes from the tool (`probe`/`recall` mean probe, `quiz`/`explain` mean teach) or from the plugin question's variant.
    - `tool` is the call's tool name, which for a plugin question is the plugin's own tool.
    - `questionType` comes from the stored answer. When that record omits it (a dismissal's minimal record does), the call's own `type` is used.
    - `nodeTitle` is the node's title in the latest successful `plan_init` before the question executes, including an earlier call in its assistant batch, so a later plan rewrite doesn't rename past answers. It is absent when the node isn't in that plan.
    - `at` is the answer's `answeredAt`, or the result's time when there is none.
  - **Ids:** answers use `<chatId>:<toolCallId>`, with `:<n>` added for a reused call id. Practice events use `<practiceChatId>:<problemCallId>`, so a dismissal counts as concluded "dismissed" from its marker on, and its deferred conclude later reads as the same event. A refused conclude records nothing. The rung is stored as a number (R0–R5 → 0–5), as item 1's contract declared.
  - **Membership:** only the session the course records for a unit contributes; a crash's duplicate does not. A practice session contributes only when it is a practice session linked to an existing unit of this course.
  - **Writes:** nothing is written when nothing is new, so the `courses-changed` refetch it triggers ends there. Evidence-only writes leave `updatedAt` alone (`courseStore.update` gained a `touch: false` option): every unit turn would otherwise invalidate an open "Edit units" draft through its stale-edit check. Events are never removed, so a deleted practice session's events stay.
  - **"When the overview loads"** is the overview page's server render, not `GET /api/courses/:id`. The overview and every open unit page refetch that route on each `courses-changed`, and a full sync there would re-read every session of the course from each open window on every change. Those refetches stay plain reads, and settlement keeps the record current between page loads.
  - `problemForConclude` in `native-messages.ts` names a conclude's problem call; `problemInputForConclude` now wraps it.
- **Checks:**
  - Typecheck passed. Lint passed with the inherited warning.
  - Full suite: 5,531 pass, 0 fail, 4 skipped (5,535 tests). A one-line simplification of the settlement hook landed during that run; typecheck, lint and the five course test files were rerun on the final code and pass.
  - New: `tests/course-evidence.test.ts` (8), with every expected event worked by hand. It covers:
    - a unit transcript holding every answer kind: wrong and right checks with confidence, don't know, a skipped check, a predict, a refused call, free recall, plugin answered and dismissed, a plan rewrite, and an ask answer that records nothing;
    - setup answers;
    - practice concludes, with and without the dismissal's deferred conclude;
    - the service: three kinds of session synced once, another course's practice session and a duplicate unit session ignored, `updatedAt` unchanged, a repeated sync leaving the file byte-identical, a deleted practice session's events kept, one-session syncs, and setup answers at course creation;
    - a real teacher turn through the handler (`plan_init`, a check `quiz`, then the learner's answer graded by `buildAnswer` as the dock does), whose settlement records the answer.
  - **Mutation checks:** removing the settlement hook, stamping `updatedAt`, dropping the creation sync, and reading titles from the session's final plan each make the new tests fail.
- **Known limits until later items:** "Practice this unit" sessions arrive with item 8, so practice evidence is covered by tests only. The handoff's computed topics start reading these events in item 6.
- **Human checks owed:** none for this item (no UI change).

### Item 5 review repairs (2026-11-13)

The human authorized fixing all four findings from the review of the uncommitted item 5 implementation.

- **Free recall:** `recall` and `explain` stay ungraded for "don't know" as well as text answers. An `explain` check can no longer become a graded failure in the handoff topic rule.
- **Reused plugin ids:** pending occurrences sharing a native call id are retained separately. Each result must match its saved occurrence through the existing validator before that occurrence is consumed. Native questions retain their existing newest-call pairing. Event ids retain their format and answer order.
- **Historical titles:** a bounded scan of an assistant batch finds successful plan results. Earlier plan calls in that batch establish the title for a question after them; later assistants' rewrites cannot rename a question already posed. This covers native and plugin questions.
- **Parked dismissals:** the normal settlement path syncs evidence after `applyParkedDismissal`, before releasing the turn. The failed-settlement path already had that ordering.
- **Regression checks:** extend `tests/course-evidence.test.ts` with don't-know free recall through `buildAnswer` and the handoff rule; both answer orders for overlapping plugin occurrences, copied/repeated results and repeated syncs; native and plugin batched plan rewrites; a real teacher batch containing plan and quiz; and real-route parked question/practice dismissals, including practice evidence retained after session deletion. Each original finding was observed failing before its fix and passing afterward. The quiz and practice builders now supply valid live-tool inputs.
- **Verification:** all 14 evidence tests and the 120-test focused course/plugin/dismissal/practice set pass. Typecheck and lint pass (the inherited `source-name-ui.test.tsx` warning remains). The full suite passes: **5,537 passed, 0 failed, 4 skipped** (5,541 tests). The production build passes against a scratch profile, with the inherited `pdf-read.ts` filesystem-tracing warning. Final code and test review found no remaining in-scope issues. No browser or live-provider checks were needed for these evidence-bookkeeping repairs.
- No dependencies, storage versions or formats, UI or prompt wording changes. No paid model calls or access to real learning profiles. Changes remain uncommitted on `phase1-courses`.

### Item 6 (2026-11-13)

- **Built:**
  - **Completing** (`completeUnit`, behind `POST /api/courses/:id/units/:unitId/complete`): confirmed after the goal signal, early before it. It is refused with 409 "Wait for the running work to finish, then complete the unit." while a turn or a background job runs in the unit; note writers don't block. It syncs the session's evidence, stores the handoff's computed topics at once (`sessionHandoffTopics` in core: the session's plan nodes, reached once a teaching question was about them, rated by decision 2), records `unit-completed`, and starts the writer. `progress.md` is regenerated by the store. The dialog's note offer is sent with the completion and runs through phase 0's service.
  - **The handoff writer** (`src/agent/subagents/handoff-writer.ts`, lifecycle in `src/server/handoffs.ts`): the `handoffWriter` role (Strong slot, purpose user, worker pool), one `submit_handoff` call with the approved prompt verbatim. Its input is the course and unit, the completion type, the computed topic table with each topic's answers, and the session text. A judgment of a checked topic and any item over 200 characters go back to the model, with up to 3 fixes. It shows in Background agents as "Handoff · <unit title>" with Stop. A failure, Stop, or closed app keeps the computed part, and "Try again" (`POST …/handoff`) reruns it.
  - **Reopening** (`POST …/reopen`): the unit goes back to in progress, `goalReachedAt` is cleared, `unit-reopened` is recorded, a running writer is stopped first, and the old handoff stays.
  - **UI:** in the unit's top bar, the quiet "Unit" menu with "Complete unit early…" before the signal, and "Complete unit" after it (`components/unit-completion.tsx`). The dialog uses the approved wording, both offers are off by default, and the note offer reveals phase 0's instruction box (factored out of the notes page as `NoteRequestFields`). After confirming it shows "Unit completed." with "Open next unit: <n>. <title>" (with the prerequisite warning when needed) and "Back to course". On the overview, completed units gain "Reopen unit" and a "Handoff" disclosure (`components/course-handoff.tsx`) that renders the agents' text through the shared `handoffSections`, plus the writer's state.
- **Agent-selected:** see the fork README's item 6 entry: no Strong model at completion, writer identity by `writtenAt`, lifecycle ids, reopen clearing `completion`/`completedAt`, and the wording the plan didn't specify. Also:
  - **Long sessions:** a session too long for the model's window uses its compaction summary plus the text after the cut, as planned; one that still doesn't fit fails with the note writer's message.
  - **Fill rules:** absent lists read as empty, whitespace collapses to one line, and empty items drop.
  - **Refusals:** "This unit is already completed.", "This unit hasn't started yet.", "This unit isn't completed.", "The teacher observations are being written.", "The teacher observations are already written.", and 503 with the models message for Try again without a Strong model.
  - **Restart recovery** happens on course reads, as phase 0's notes do. A handoff left "writing" without a live writer becomes "Interrupted when the app closed".
  - The plugin API reference was regenerated (`BACKGROUND_MODEL_ROLES` lists `handoffWriter`), and `docs/development.md` and `src/agent/prompts/README.md` name the new role and prompt. The architecture section stays with item 10.
- **Checks:**
  - Typecheck passed. Lint passed with the inherited warning.
  - Full suite: **5,557 passed, 0 failed, 4 skipped** (5,561 tests).
  - New: `tests/course-completion.test.tsx` (19) and one Background-agents render case. They cover:
    - confirmed and early completion with hand-worked topics, events and `progress.md`;
    - the turn, job and note-writer gates;
    - the note offer only when checked;
    - the writer: a scripted submit stored as the plan's handoff text verbatim, a checked-topic judgment and a 201-character item refused back, a give-up and a thrown failure keeping the computed part, Stop from the dock then Try again, interruption on read without touching `updatedAt`, the engine resolved through `handoffWriter` with purpose user in the pool and the role override, and no Strong model;
    - reopen clearing the signal, stopping the writer and keeping the handoff for later units;
    - the dialog's offers, its forms, the next-unit offer and the top-bar trigger;
    - the overview's handoff states and card actions.
  - **Mutation checks:** allowing judgments of checked topics, always recording "confirmed", dropping the work gate, and skipping restart recovery each fail the new tests.
  - **Existing test change:** `tests/course-units.test.tsx`'s interrupted-publication case reads its course once before injecting the crash. Its fixture holds a "writing" handoff that the new recovery settles on first read (a course write), which otherwise fired the injected crash early.
  - The production build passed with the inherited `pdf-read.ts` tracing warning. `scripts/build-server.mjs` and `scripts/smoke-server.mjs` passed.
  - **Browser check:** the built server on a scratch profile, the local fake keyless endpoint, and Electron 44 (headless platform) driven by `puppeteer-core`, in Ivory and Default. Each theme ran setup → unit 1 → the Unit menu and the early dialog → a real graded check at 90% → the goal signal → "Complete unit" with both offers → "Unit completed." It then verified:
    - the record: confirmed, "Span" solid, observations ready;
    - the note written with its instruction, and the export downloaded;
    - the closed band;
    - "Open next unit: 2. Linear maps" starting unit 2, whose request carried unit 1's full handoff;
    - the overview's handoff, then Reopen restoring the composer.
    - A first run whose fake judged a topic the unit never reached showed the real refusal four times and then the kept computed part. Only the expected dictation-token 503s appeared.
  - **Fixture screenshots:** the plan's example handoff and a stopped writer with Try again, at 1,400 and 390 px, show no horizontal overflow.
- **Checkpoint (human):** screenshots of the completion dialog (early and confirmed with offers), "Unit completed.", the top-bar controls, and the fixture handoff in both themes are under the session scratchpad's `bc/shots/`. The look and the wording listed in the README entry await approval before item 7.

### Item 6 review repairs (2026-11-13)

The human approved fixing both worker-startup findings from the review of item 6.

- **Handoff startup:** unavailable saved model selections no longer prevent completion. The service saves the computed topics, completion event and failed writer with the startup error; the handoff can be retried after restoring the model.
- **Optional note startup:** a thrown exception becomes `noteError` on a successful completion response. The dialog can show "Unit completed." with the note error, run the requested export and offer the next unit.
- **Agent-selected implementation:** catch engine-construction errors before the completion write and optional-note exceptions after it, leaving course persistence errors visible. No changes to storage formats, dependencies, UI wording, or prompts.
- **Regression coverage:** two additions to `tests/course-completion.test.tsx`, both observed failing before their fixes. One uses a saved model for a disconnected custom endpoint and verifies persisted topics, the completion event, `progress.md`, and a successful retry after restoring the model. The other exercises the client completion helper against the real completion and HTML-export routes, verifying HTTP 200, `noteError`, a persisted completion and a downloaded export despite the unavailable note model.
- **Verification:** all 21 focused completion tests pass. Typecheck and lint pass (the inherited `source-name-ui.test.tsx` warning remains). The full suite passes: **5,559 passed, 0 failed, 4 skipped** (5,563 tests). The production build passes with the inherited `pdf-read.ts` tracing warning; `scripts/build-server.mjs` and `scripts/smoke-server.mjs` pass.
- **Browser verification:** Playwright against the production server on a scratch profile, with both writer roles pinned to unavailable custom models. Completing with both offers returns 200, saves the computed handoff with its startup error, shows "Unit completed." and the note error, downloads the HTML conversation, and offers unit 2. The overview shows the kept topic, the handoff error and Try again; reopening retains the failed handoff. The screenshot is under the repair scratchpad's `browser-evidence/repaired-completion.png`. Only the unrelated favicon 404 and unconfigured dictation-token 503 appeared in the browser console.
- **Final review:** the two exception boundaries preserve the existing work gates and course-write failures; each new regression test covers a distinct reported failure and failed before its fix. No remaining in-scope issues found. No paid provider calls or access to real learning profiles. The repair remains uncommitted on `phase1-courses`; the original item 6 design checkpoint is unchanged.
