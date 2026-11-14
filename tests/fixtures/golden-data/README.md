# Golden fixtures — real user data, read through production paths

**The law (owner ruling, 2026-10-10):** this directory is a REAL data dir —
verbatim records written by the real application code, never hand-edited. Any
intentional on-disk format change updates these fixtures IN THE SAME COMMIT;
an unintentional change fails `tests/golden-fixtures.test.ts`. When schema
stamps land (Wave D), the stamping commit updates these files with it.

`tests/golden-fixtures.test.ts` copies this dir to a temp dir, points the
production stores at it via the `LH_DATA_DIR` seam, and reads EVERYTHING
through the real read paths — chat records (contract folds + the LLM wire
flattening), graph ledgers (shape guards + the full derivation), jobs,
settings. It also pins marker COVERAGE: every custom-marker kind and the
core tool surface must appear in real data here.

## What's inside

- `chats/chat_mv27rrra_feff23b6.json` — the teach-side master (owner-built,
  2026-10-10): probe-handoff, plan-block, compaction, subagent-steer,
  subagent-abort, and every teach tool (quiz, ask_user_question, plan_init,
  probe, probe_done, recall, explain, research, demo, visual, pdf, find,
  grep, ls, read, list_sessions, list_propositions). Plan tree + 25 turn
  records + a per-chat model override.
- `chats/chat_mv293wv5_10656952.json` — the practice lifecycle (owner-built,
  2026-10-10): graph-context (the bracketed preamble), problem ×2,
  practice-thinking ×2, conclude ×2, practice-next, problem-dismissed — the
  full marker cycle of a practice session, including the dismissal.
- `chats/chat_mwflszug_5a1f29dc.json` — a course unit session (fork plan
  04): unit 3 ("Determinants") of the golden course below, opened by its
  `unit-start` marker, through the unit prober's probe and `probe_done`, the
  teacher's `plan_init` and a graded check, to `goal_reached`. Written by
  the real course service (`startUnit`) and the real turn handler against a
  scratch copy of this directory, with a scripted (faux) model in place of
  a provider. Only the chat record was copied in: the course record keeps
  its earlier fixture state (unit 3 not started), so reading the pair
  through the course service adopts this session as an interrupted start.
- `graph/` — the real ledgers: nodes (282 lines), chains (160), sessions (8),
  coverage (93), sources (4), render-settings, positions.
- `jobs/` — five records covering kind × status: research done + aborted by
  learner, demo done, visual done, pdf error.
- `settings.json` — the stamped settings record (version 1, model slots).
- `notes/chat_mv27rrra_feff23b6/notes.json` — the fork's notes index (plan
  03, version 2) for the teach master: a ready note whose rewrite failed
  (old version kept, error recorded) and a stopped interactive note. Written
  by the real notes service and store against a scratch copy of this
  directory, with a scripted (faux) model in place of a provider; the note
  HTML files are omitted to keep the fixture small. The index was upgraded
  through the real store's publication path after the review repair; its
  `htmlRevision` selects that immutable publication. Legacy v1 HTML reads
  and publication upgrades are covered in `tests/notes.test.ts`.

- `courses/course_mvgold00_9f3a1c2e/` — the fork's course record (plan 04,
  version 1) with its regenerated `progress.md`: four units in every status
  but one completed unit's handoff (all four topic statuses, model-written
  observations), an accepted and a pending proposal, and every evidence type
  and answer result. Written by the real course store from a scripted record
  (the handoff topics computed by the real topic rule from the fixture's own
  answers), since no session produced it.

- `books/book_mwgblp43_abf834a5/` — a library book (fork plan 05, version
  1): a small generated EPUB 3 with a table of contents, a print page mark,
  and §1–§14 numbered paragraphs. Imported by the real books service
  (`importBook`) against a scratch copy of this directory, with no model:
  the contents were accepted automatically (bookmarks with numbered
  paragraphs nested inside), and the map writer is "not-needed" for a book
  this short. All five files are the service's own output.

## Regenerating / extending

Run the app (`npm run dev`), exercise the feature against `data/`, then copy
the produced record in verbatim. Do not hand-edit content; if a record needs
pruning, re-run the flow instead.

## Stamps

These files are deliberately the UNSTAMPED legacy shape (schema-stamp wave,
2026-10-10): lazy v1 means absence reads as current-valid, so this set pins
the pre-stamp read path forever. Stamped writes (chat `version: 1`, the
`graph/format.json` sidecar) are pinned by `tests/schema-stamps.test.ts`.
New records copied in after their first post-stamp write will carry the
stamps — that shape is equally current-valid.
