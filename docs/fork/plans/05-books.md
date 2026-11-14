# Plan 05: books (roadmap step 5)

**Status:** approved by the human 2026-11-14, including its Proposed items. Item 1 is implemented, including review repairs, and item 2 is implemented; items 3–8 remain. Work happens on the books branch off `main`, one commit per item when requested. Checkpoints after items 3 and 5 are approved before work continues. Progress is recorded under [Outcome](#outcome).

Designs: [fork README](../README.md), "Books". Choices made in this plan's interview are marked **Decided (human)**. **Proposed** items are product choices the agent filled in (wording, UI details, small rules); approving the plan approves them, or the human edits them. *Agent-selected* items are implementation details, reported again at completion.

**Scope:**
- A Books library: import (PDF with a text layer, EPUB, plain text and Markdown), a stored copy, detected structure, and a model-written map.
- Attaching one library book when starting a Teach session or a course.
- The book in agents' prompts (outline, plus a unit's own reading), and synchronous retrieval tools.
- Verbatim quotes as cards with citations, and an in-app reader (side panel and full page).
- Courses that follow a book: units tied to reading ranges.
- "Practice this unit" with the unit's book, and book context for side questions.

**Not in this plan:**
- OCR, embeddings, or any new model provider.
- Graph extraction at import (settled). The existing "Extract files" stays the way to extract a whole book.
- Books in standalone Practice sessions.
- Adding, removing or swapping a book after a session or course has started (decided, question 5).
- Tools in side questions (decided, follow-up to question 7).
- Annotations, highlights or bookmarks made by the learner in the reader.
- Mastery gates (phase 2), competency views (phase 3), release and install (step 8).
- No new dependencies. EPUB reading uses `node:zlib` with the existing `linkedom` and `turndown`.

## Decisions settled before this plan (2026-11-12, human; not reopened)

Book map, not embeddings RAG; the Cheap model writes a short summary and key terms per section; agents receive the relevant part of the map, read exact text with a "read section" tool, and fall back to keyword search. PDF (text layer only), EPUB and plain text/Markdown. A library in the data folder; the map is built in the background at import; one book serves many courses and sessions. Courses started with a book get units that follow its structure, adjusted by the probe, each tied to its sections; a book can also be reference only. The teacher quotes short key passages verbatim with clickable citations (§187, p. 114) that open an in-app reader, and teaches through the quote. No graph extraction at import.

## Decisions from the interview (2026-11-14, human)

1. **Verbatim quotes:** the teacher calls a quote tool with the book location and the passage. The server checks the passage against the stored text and refuses a mismatch back to the teacher. The chat shows a **quote card** whose text comes from the stored book, so it is verbatim by construction, with a clickable citation.
2. **Map in prompts:** every turn gets the whole-book **outline** down to section headings, each with its one-line summary (about 3k tokens at most; deeper levels collapse when over). A course unit also gets **full detail** (summaries and key terms down to the finest level) for its own reading (about 4k tokens at most). Anything else the agent opens with `book_map`, then reads exact text with `read_section` or `search_book`.
3. **Books without detectable structure:** the importer splits the text at paragraph breaks into **app-made parts** of roughly 2,000 words. The Cheap model gives each a short title along with its summary. The book page marks the structure "Divided by the app", and citations use page numbers (PDF) or part numbers (EPUB and text), never invented §s.
4. **Reader:** a citation opens a resizable **reader panel** on the right of the chat, scrolled to the passage with the quoted words highlighted. The reader shows the stored text reflowed, a collapsible contents list, and section and page labels in the margin. PDFs have "Show original page", which renders the real page. "Open full page" expands it to `/books/<id>`, where the library also opens a book. Narrow windows get the full page instead of the panel.
5. **Attaching:** a course or Teach session has **at most one book, chosen when it starts**. A course either follows the book or keeps it as reference.
6. **Unit readings:** a unit of a course that follows its book has a **reading**: one or more contiguous ranges of the map ("§166–§177", "IV.A"), or none (a background unit). The setup card and the overview's "Edit units" show it as "Reads: §178–§196 (Lordship and bondage)" with a picker over the book's contents. Ranges may overlap or skip parts; the overview shows which parts no unit reads. Teacher proposals that insert or merge units carry readings too.
7. **Who reads the book:** the prober, the teacher, the setup agent, and the practitioner of a "Practice this unit" session (it can pose problems on a passage, shown as a quote card). The note and handoff writers get no tools; their input already holds the quote cards. Standalone Practice sessions have no book.
   - *Follow-up, side questions:* they stay tool-less. When a side question is asked on a message holding quote cards, the app adds each quoted passage's surrounding text (about 2k tokens in all) and the book's outline to the side question's prompt.
8. **Deleting a book:** refused while any course or session uses it. The dialog lists them by name with links. Once nothing uses it, Delete removes the copy and its map.
9. **Import flow** (the human's request after the first draft, refined with the agent): anything that can be done without a model is done without one.
   - The **contents** (index) are always found without a model. The app judges its own confidence (item 1) and always shows what it found.
   - *Confident:* the contents are accepted automatically and shown on the book page.
   - *Unsure:* the import stops at **"Check the contents"** with "Looks right" and "Not right". "Not right" first offers the other methods that need no model. Only after that does it offer, and ask before running, a model pass that reads a compact digest of candidate heading lines with their pages, never the whole book.
   - *Broken:* the file can't be read, has no text layer, or yields garbled text. The learner is told plainly what is wrong. Nothing is requested and no model is called.
10. **Summaries:** once the contents are accepted, the Cheap model writes the summaries **automatically**, as the 2026-11-12 design said. Stop stays available in Background agents. **Short books** (under about 20,000 words) get no summaries, because the agent can simply read their text.

## Facts this plan relies on (verified 2026-11-14)

- **PDF reading today.** `pdf-ops.ts` wraps `pdfjs-dist` 6.3.289 (legacy build, in-process, no worker). `pdf-markdown.ts` turns positioned text into Markdown by rule (headings from font size, lines, lists) and reports image-only and empty pages. `convertPdf` takes a page cap and an abort signal; cancellation is cooperative.
  - The teacher's `pdf` tool dispatches the `pdfReader` job (Vision slot, `pdf-reader.ts`). It is fire-and-forget: the brief arrives later as a steer message. Every job re-opens the file; `pdfInfo` walks every page's operator list and `pdfSearch` converts the whole document per call, so long books are slow and nothing persists.
  - pdfjs exposes `getOutline` (bookmarks), `getPageLabels` (printed page numbers) and `getMetadata`.
  - Page rendering (`headless.renderPdfPages`) runs in-process on `@napi-rs/canvas`, with no browser.
- **Notes import ("Extract files").** `POST /api/graph/import` accepts PDFs and text files (25 MB body, 1,000 PDF pages), converts PDFs with `convertPdf`, and discards the text after extraction.
- **HTML to Markdown.** `web_fetch` already uses `linkedom` + `turndown` (+ `@mozilla/readability`). No zip reader exists in `src/`; `src/server/zip.ts` is a writer, and two tests read zips with `inflateRawSync`.
- **Learner files.** `read`/`ls`/`find`/`grep` follow the File access policy and denials in `fs-shared.ts`. The data folder is readable by policy. Book tools read the library directly by book id and never take paths.
- **Agents and prompts.** `handleChatInput` builds a fresh agent every turn. A unit's course section is appended to the prober's or teacher's system prompt each turn (`teacher-agent.ts`, `unitCourseSection`), and its size is counted in compaction accounting (`coursePromptTokens`, the dynamic-prompt baselines of plan 04 item 4). Server-side tools that don't end the turn are the norm (`propose_course`, `goal_reached`, `plan_init`).
- **Side questions.** `src/agent/side-chat.ts` is one streamed model call with no tools and no session identity. Its prompt is built from the lesson document and the learner's selected quotes (up to 5).
- **Courses.** The setup agent's `propose_course` input has `key`, `title`, `goal`, `prerequisites`, `startingPoint` per unit; `createCourseFromSetup` builds the record from the edited card. Unit edits go through `applyUnitEdit`, revisions through `applyCourseChanges`. The course store keeps unknown fields on rewrite; the course record is version 1 and the chat record version 2.
- **Workers.** The handoff writer (`src/server/handoffs.ts`) is the model for a learner-started background writer: purpose `user`, the shared worker-request pool, a Background agents row with Stop, interruption read as failure on the next read, and Try again. `runSubmitAgent` runs one validated submit call with fixes.
- **Model roles.** `ROLE_SLOT` maps roles to slots; `noteWriter` and `handoffWriter` are Strong-slot roles with schema-level overrides and no Settings row. Background-purpose requests are blocked on subscriptions whose background use is off; `user` purpose is not.
- **Citations precedent.** Learner "Tutor quote" citations are markdown links with an `lh-citation:` scheme (`src/core/citations.ts`).
- **Home composer.** A Teach | Practice | Course switch (`components/home.tsx`) creates sessions through `POST /api/chats`, which already accepts `kind`, `course` and `graphContext`.

## Assumptions (checked during implementation)

- pdfjs resolves outline destinations to page indexes for common PDFs (`getDestination` + `getPageIndex`). Where it can't, the importer falls back to heading detection.
- Converting a 600-page text PDF page by page, yielding between pages, keeps the server responsive. It is measured on a generated fixture.
- A side question's anchor can point at a message whose quote cards are tool parts. If anchors only reach prose, item 7 extends them (no storage-format change expected; if one is needed, work stops and the question goes to the human).
- The local fake OpenAI-compatible endpoint from plans 03 and 04 can script the map writer's submit calls and the teacher's book tool calls.

## Storage (agent-selected layout; covered by this plan's approval)

```text
data/books/<bookId>/
  book.json       the book record (version 1)
  original.<ext>  the imported file, byte for byte (pdf, epub, txt, md)
  text.json       the converted text as ordered blocks
  map.json        the structure tree and its summaries
```

- **`book.json`**, written by temp file and rename, refused (409) when newer or damaged, unknown fields kept: `id`, `title`, `author?`, `format` (`pdf` | `epub` | `text` | `markdown`), `fileName`, `sha256`, `bytes`, `importedAt`, `updatedAt`, `pageCount?`, `words`, `structure` (`outline` | `headings` | `numbered` | `app-made` | `model`), `confidence` (`confident` | `unsure`, with `reasons[]`), `contentsAccepted` (`auto` | `learner`, absent while in review), `import` (`importing` | `review` | `ready` | `failed`, `error?`, `notice?`), `structureWriter?` (the optional model pass: `writing` | `ready` | `failed`, `error?`, `stopped?`, `model?`, `usage?`), and `mapWriter` (`waiting` | `not-needed` | `writing` | `ready` | `failed`, `done`, `total`, `error?`, `stopped?`, `model?`, `usage?`).
- **`candidates.json`**: the structures each method found at import (bookmarks or EPUB contents, numbered paragraphs, headings, app-made parts), so "Not right" can switch between them without reconverting. *Agent-selected correction (item 1):* it is kept after acceptance, because item 3 keeps "Not right" available until a session or course uses the book.
- **`text.json`**: `{ version: 1, blocks: [{ id, kind: "heading" | "paragraph", text, page?, pageLabel? }] }`. Block ids are their index. The text is never rewritten after import.
- **`map.json`**: `{ version: 1, nodes: [{ id, parentId?, label, title, kind, level, firstBlock, lastBlock, pages?, summary?, terms? }] }` in book order. `label` is what citations show: "§187", "IV.A", "Chapter 2", "Part 14" (app-made). `kind` is `part` | `chapter` | `section` | `paragraph` | `app-part`.
- **Chat records** gain one optional field, `book: { bookId }`, on standalone Teach sessions and course setup sessions. The chat version stays 2.
- **Course records** gain `book?: { bookId, mode: "follow" | "reference" }`, and units gain `reading?: { from, to }[]` (map node ids, inclusive). The course version stays 1. Unit and unit-practice sessions resolve the book through their course.
- **Quote results** are self-contained in the transcript: the tool result's details hold `bookId`, `bookTitle`, `nodeId`, `label`, `pages?`, the start and end positions (block and offset), and the stored text. Exports, notes and compaction never need the library.
- **Golden fixtures:** a book folder (record, text, map) and a course record with a followed book and unit readings under `tests/fixtures/golden-data/`.

## 1. Book record, store, and import (no model)

**Change:**
- Contracts in `src/core/contracts/book.ts`: the record, blocks, map nodes, ranges, the chat and course fields, and quote details.
- Pure core helpers (`src/core/book.ts`):
  - structure detection over blocks, in order of preference: the PDF outline or EPUB table of contents; numbered paragraphs (a sequential run like "§1"…"§808" or "1."…"808." at paragraph starts, nested under the detected headings); Markdown or detected headings; otherwise app-made parts (decision 3) split at paragraph breaks near 2,000 words;
  - location parsing and resolution ("§187", "§178–§196", "IV.A", "p. 114", "p. 114–116", node ids);
  - text normalization for search and quote matching (below);
  - the outline and detail renderings with their budgets (item 4).
- Converters (`src/server/book-import.ts`):
  - **PDF:** `documentToMarkdown` page by page with yields, then blocks with their page and page label. The outline comes from `getOutline`, title and author from metadata, else the first heading, else the file name.
  - **EPUB:** a minimal zip reader (central directory, stored and deflated entries) in `src/server/unzip.ts`; `META-INF/container.xml` → the OPF; spine order; the EPUB 3 nav or EPUB 2 NCX as the outline; each XHTML document through `linkedom` + `turndown` into blocks. Title and author from the OPF.
  - **Text and Markdown:** decoded as UTF-8 (refused when a zero byte appears in the first 8 KiB, as the notes import does); Markdown headings become headings.
- Store `src/store/books.ts` (`PATHS.books`): create, get, list, update, remove, read text and map, with the version guard and atomic writes. The `books-changed` server event.
- **Confidence (decision 9; agent-selected signals, all without a model).** Every method runs, and each result is scored:
  - *Bookmarks or EPUB contents* are confident when their destinations resolve, they run in book order, they cover the text from near its start to near its end with no gap over a quarter of the book, and most entry titles are found in the text at their destination.
  - *Numbered paragraphs* are confident when the run is sequential (at least 95% of 1…N present in order, few repeats) and starts near the text's start.
  - *Headings* found from font size or plain-text patterns are always unsure.
  - *App-made parts* are the fallback and always unsure.
  - The best confident result wins; otherwise the best unsure one is shown for review. The reasons are kept for the review screen ("The bookmarks cover only pages 1–140 of 610.").
- **Broken files (decision 9).** Refused before any structure is shown, with the reason:
  - the existing unreadable and no-text-layer cases;
  - **garbled text**: most sampled pages are made of private-use or replacement characters, or few of their tokens look like words. "This PDF's text is garbled, probably because of how its fonts are encoded. OCR isn't supported, so it can't be imported."
- Import service: `POST /api/books` (multipart, one file) stores the original, creates the record as `importing`, converts in the background, and writes `text.json`, `candidates.json` and the titles-only `map.json`.
  - A confident result is accepted (`contentsAccepted: "auto"`) and the import becomes `ready`.
  - An unsure one leaves the import in `review`.
  - An import left `importing` by a closed app reads as failed ("The import was interrupted."), and Try again reconverts the stored original.
- **Review routes:** `PUT /api/books/:id/contents` accepts the shown structure or switches to another candidate. `POST /api/books/:id/structure-writer` runs the optional model pass (item 2) when the learner asks.
- Routes: `GET /api/books`, `GET/PUT /api/books/:id` (read, rename title and author), `POST /api/books/:id/retry-import`.

**Proposed rules and wording:**
- Limits: 100 MB per file and 3,000 PDF pages. "Too big. Max 100 MB." / "Too long. Max 3,000 pages."
- Refusals: "This PDF has no text layer. OCR isn't supported." (no page has text); "This EPUB is protected (DRM) and can't be read." (`META-INF/encryption.xml` covers content documents); "This file isn't plain text."; "Could not open this file."; a same-content file: "This book is already in your library: <title>." with a link.
- A PDF with some image-only pages imports with the notice "<n> pages have no text and are skipped. OCR isn't supported."

**Text normalization (agent-selected, shared by search and quotes):** Unicode NFKC on ligatures, whitespace collapsed, a hyphen at a line end joined with the next word, typographic quotes, apostrophes and dashes folded to one form. Search is also case- and accent-insensitive; quote matching is not.

**Tests:**
- detection on hand-written block lists: an outline; a §1–§30 numbered run nested under two headings; "1." list items inside a paragraph not taken for numbered paragraphs; headings only; nothing (app-made parts at paragraph breaks, sizes within bounds);
- location parsing and resolution, including unknown labels and reversed ranges;
- normalization cases (line-end hyphen, curly quotes, ligature);
- converters on generated fixtures: a PDF with bookmarks and page labels (generated by a small test-side PDF writer), the existing `sample-3page.pdf`, an EPUB 3 and an EPUB 2 built with `zipFiles`, a DRM-marked EPUB, Markdown and text;
- confidence on hand-built cases: full bookmarks are confident; bookmarks covering only the first quarter, out-of-order bookmarks, and bookmarks whose titles aren't in the text are unsure with their reasons; a clean §1–§200 run is confident, while one with gaps is unsure; headings-only is unsure; garbled text (private-use glyphs, non-words) is refused with its message;
- review: accepting, switching candidates, and refusing to attach a book still in review;
- the store: round trip, version guard, damaged file, unknown fields kept, path safety;
- the import route: limits, duplicate refusal, interruption and retry;
- the golden fixture loads.

## 2. The map writer

**Change:**
- A `bookMapper` model role on the **Cheap** slot, with the schema-level override `agent.models.bookMapper` and no Settings row, like `noteWriter`.
- `src/agent/subagents/book-mapper.ts`: batches leaf nodes in book order into calls of at most about 12k tokens of text and makes one `submit_summaries` call per batch through `runSubmitAgent` (up to 3 fixes). Each leaf gets a `summary` (one line, at most 200 characters) and up to 6 `terms`; app-made parts also get a `title` (at most 60 characters). Validation: every id of the batch exactly once, no unknown ids, the length limits. Parents are then summarized bottom-up from their children's summaries, one level at a time. A leaf longer than one batch is summarized from consecutive windows, the later ones given the earlier summary.
- **When it runs (decision 10):** automatically once the contents are accepted, whether automatically or by the learner. A book under about 20,000 words is marked `not-needed` and gets none; its outline keeps the titles.
- **The optional structure pass (decision 9):** only when the learner chooses it on "Check the contents". It makes one `submit_structure` call on the same role, given a digest of candidate heading lines (short lines, lines in larger type, lines matching chapter or numbering patterns, each with its block id and page; capped at about 8k tokens). It returns the headings as block ids with their levels and labels. Validation: known block ids in book order, consistent levels, up to 3 fixes. The result becomes the `model` candidate, shown for review like any other, and it costs no summaries until accepted.
- `src/server/book-maps.ts`: starts with purpose `user` (the learner imported the book) in the shared worker-request pool. Each finished batch is written to `map.json` at once, so Stop, a failure or a closed app keeps finished summaries, and Try again continues with the rest. Background agents shows "Book map · <title>" with Stop and the activity "<done> of <total> sections". A writer left `writing` by a closed app reads as failed ("Interrupted.") on the next read.
- With no Cheap model configured the import still succeeds and the writer fails at once with the usual "No model configured" message; Try again applies once a model is set.
- The book is usable while its map is incomplete: agents see titles without summaries where none exist yet.
- `LH_BACKGROUND_CAPTURE` accepts `bookMapper`.

**Proposed writer prompt (approve or edit):**

> You write the map of a book that a learner studies with a tutor. For each section you receive, write one line saying what the section does in the book's argument or exposition (not a paraphrase of its first sentence), and up to six key terms exactly as the book uses them. For a section marked "untitled", also give a short title naming its content. Use only the text given. Call `submit_summaries` once, with every section id given.

For parent levels: "…You receive the summaries of a part's subsections. Write one line saying what the part as a whole does, and up to six key terms."

**Tests:** automatic start on acceptance (both kinds) and none while in review; a short book marked `not-needed`; the structure pass's digest cap, a scripted submit becoming a reviewable candidate, and invalid block ids or levels refused back to the model; batching against a token budget; a scripted submit stored; a missing or unknown id refused back to the model; the length limits; Stop and resume (finished batches kept, the rest written on retry); interruption on restart; no Cheap model; the engine resolved through `bookMapper` from the Cheap slot with purpose `user`.

## 3. Library and book pages

**Change:**
- **Sidebar:** a "Books" door below "Course" (book icon), opening `/books`.
- **`/books`:** "Import book" (file picker; PDF, EPUB, TXT, MD), and the books newest first. Each row shows the title, author, format, size (pages or sections), and the state: "Importing…", "Check the contents", "Mapping 120 of 808 sections", "Map ready", "Short book: no map needed", or the failure with Try again. A row opens the book page.
- **"Check the contents"** (decision 9; *Proposed wording*):
  - The book page opens on the found contents as a tree with labels, titles and pages, under "We're not sure these contents are right." and the reasons ("The bookmarks cover only pages 1–140 of 610.").
  - Buttons "Looks right" and "Not right". "Not right" lists the other methods with what each found ("Numbered paragraphs: §1–§808 under 12 headings", "Headings: 31", "Parts of about 2,000 words: 96"), each selectable to view, then "Use these".
  - Last comes "Find the contents with the model (about <n>k tokens on <Cheap model>)". It asks first and shows its result for the same review.
  - A confident import shows its contents on the book page with "Contents from the PDF's bookmarks" (or the method used), and the same "Not right" path stays available until a session or course uses the book.
- A book in review can't be attached until its contents are accepted; the composer's Book control lists it as "Check its contents first".
- **`/books/<id>`:** the full-page reader (item 5 fills in quotes and highlights): the header with title (click to rename), author, format, "Divided by the app" when `structure` is `app-made`, the map's state and usage, and "Used by" (courses and sessions, linked). The contents on the left (each entry's summary in muted text once written), the text on the right with labels and page numbers in the margin, and a search box over the book.
- **Delete book…** in the header's menu (decision 8): refused while used, listing the users with links ("This book is used by: <course>, <session>. Delete them first, or keep the book."). Otherwise "Delete book?" with "This deletes the book's copy and its map. Your sessions and courses are not affected." It stops a running map writer first.
- Routes: `GET /api/books/:id/text?around=<nodeId>|from=<block>` (windows of blocks for the reader), `GET /api/books/:id/search?q=`, `DELETE /api/books/:id`.

**Proposed:** the reader follows the app's theme (unlike notes, which are always light), in the notes typography (Source Sans 3 body, CMU Serif headings).

**Checkpoint (human), after items 1–3:** screenshots of the library (importing, check the contents, mapping, ready, short book, failed), the "Check the contents" screen and its alternatives, a garbled-PDF refusal, the book page with contents and text, an app-made book, and the delete refusal, in light and dark. The look is approved before item 4.

**Tests:** render tests for each row state and the book page's header; the "Used by" scan over chats and courses; the delete refusal and success (folder gone, writer stopped); text windows and search through the routes.

## 4. Attaching a book; the book in prompts; retrieval tools

**Change:**
- **Start:** the home composer's Teach and Course modes get a "Book" control beside the node picker, choosing one library book whose import is ready (decision 5). In Course mode the chip adds "Follow its structure" (default) or "Reference only". `POST /api/chats` stores `book` on the Teach or setup chat; creating the course copies it into the course record with its mode. The control is hidden in Practice mode.
- **Top bar:** a session or course with a book shows a book chip ("Phenomenology of Spirit") that opens the reader panel at the start of the unit's reading, or the book's beginning.
- **Prompt section:** each turn of a session with a book appends a book section to the prober's, teacher's or setup agent's system prompt, after the course section: the book doctrine (below), the title and author, how citations look in this book, and the outline (decision 2). Unit sessions of a followed book add the unit's reading and its full detail. Sizes join the dynamic-prompt accounting already used for the course section, because summaries arrive while the map is written.
- **Budgets (agent-selected within decision 2):** the outline includes whole levels from the top down while they fit 3k tokens (estimated at 4 characters per token); a level that doesn't fit shows each parent as "<label> <title> (<n> sections)". The unit's detail includes its reading's nodes down to the leaves while they fit 4k tokens, otherwise one level less, with the rest reachable by `book_map`.
- **Tools** (server-side, non-terminating, for the prober, teacher and setup agent of a session with a book):
  - `book_map({ at? })`: the map under a node, with summaries and terms, capped at about 4k tokens with "narrow to one of: …" when over.
  - `read_section({ at })`: the exact text of a location, with labels and page markers, capped at about 8k tokens per call; a longer location ends with "Continues: call read_section with at "<next>"".
  - `search_book({ query })`: case- and accent-insensitive search, up to 20 hits, each with its label, page and a snippet.
  - The `pdf` job stays as it is for the learner's other PDFs. The doctrine points the agent at the book tools for the attached book.

**Proposed book doctrine (approve or edit):**

> # The learner's book
>
> This session studies a book from the learner's library. The outline below shows its structure; open any part with `book_map`, read exact text with `read_section`, and find passages with `search_book`. Never rely on memory of the book: read before you state what it says.
>
> Teach through the text. When a passage carries the idea, quote it with `quote_passage` (a short key passage, read first, copied exactly) and work from it: often ask him to predict or interpret before you explain. Cite locations as the book does (§187, p. 114). Keep quotes short and few; summarize the rest in your own words, marked as yours.

**Proposed additions:** to the prober, "For a session with a book, probe what the book demands of a reader at this point: its terms, and the background it assumes." To the unit teacher of a followed book, "This unit reads the range below. Plan from its text: read it before plan_init, and let the plan follow its argument."

**Proposed tool descriptions:** "Show the book's map under a location: titles, one-line summaries and key terms." / "Read the exact text of a location in the book (a section, a numbered paragraph, or pages)." / "Search the book's text for a word or phrase; returns locations with snippets."

**Tests:** composition (the book section present for each of the three agents, absent without a book; after the course section; outline budget and collapse on a large fixture map; unit detail only for followed books); each tool against the fixture book, including caps and continuation; the composer control and the stored fields; the course copying the book and mode; compaction accounting counting the book section.

## 5. Quotes, citations, and the reader panel

**Change:**
- **`quote_passage({ at, text })`** (decision 1): normalizes both sides (item 1) and looks for `text` within the location, extended to its immediate neighbors so a passage crossing a boundary still matches. An ellipsis ("…" or "...") splits the quote into fragments found in order within the location. A refusal reads, for example, "The quoted text isn't in §187. Read it with read_section and copy the passage exactly." On success the result details hold the stored span (Storage), and the model reads "Quoted §187 (p. 114). The learner sees the passage as a card."
- **Quote card:** the tool part renders the stored text as a block quote with the citation below, right-aligned: "<short title>, §187 · p. 114 ↗" (the page part only for PDFs). It also renders in practice sessions (item 7).
- **Reader panel** (decision 4): clicking a citation opens a resizable panel on the right of the session (width remembered on this device), scrolled to the passage with the quoted words highlighted. The panel has Contents, "Open full page" and close. A window narrower than 1,000 px opens the full page instead. `/books/<id>?at=<nodeId>&from=<pos>&to=<pos>` highlights the same span.
- **"Show original page"** (PDFs): renders the page at 150 DPI through `renderPdfPages`, `GET /api/books/:id/page/<n>`.
- **Exports and notes:** the conversation export, Markdown export, note-writer input and compaction text render a quote as a block quote followed by "— <title>, §187 (p. 114)". Session extraction reads it as quoted text, so what was taught from it can enter the graph.

**Proposed limits:** a quote of at most 1,200 characters ("short key passages"); longer quotes are refused with "Quote at most 1,200 characters; summarize the rest."

**Checkpoint (human), after items 4–5:** screenshots of the composer's book control in both modes, a lesson with quote cards, the reader panel with a highlight, the original-page view, and the narrow-window full page, in light and dark. The look is approved before item 6.

**Tests:** quote matching (exact, line-end hyphen, curly quotes, a boundary crossing, ellipsis fragments in order and out of order, a wrong location, a case change refused); the card from a fixture transcript; the panel opening, highlighting and narrow-window navigation (render and interaction tests); export and note-source rendering against hand-written expected text; the page image route.

## 6. Courses that follow a book

**Change:**
- **Setup:** with a followed book, the setup agent gets the book section (item 4) and the setup addition below. `propose_course` gains an optional `reading` per unit (ranges by label or node id), validated against the map; an unknown location or a reversed range goes back to the model. With a reference book there are no readings.
- **Card and "Edit units"** (decision 6): under each unit's goal, "Reads: §178–§196 (Lordship and bondage)", or "Reads: nothing from the book". "Change" opens a picker over the contents: click the start, then the end; "Add range" for another. Started units can change their reading, as they can their goal (decision 5 of plan 04).
- **Proposals:** `insert` and `merge` changes take an optional `reading`; a merge without one joins its units' readings. Change lines add "(reads §…)".
- **Overview:** below the goal, "Follows: <title>" or "Reference: <title>", linked to the book page. When the course follows its book, "Not read by any unit: …" lists the uncovered top-level ranges, or nothing when all is covered.
- **Unit context:** the course context's unit lines add each unit's reading, and the unit's book section (item 4) holds its reading's detail.
- **`progress.md`:** the units table gains a "Reads" column when the course follows a book.

**Proposed setup addition:**

> The learner wants to study this book. Plan units that follow its structure: usually one unit per major part or chapter, split or joined so each is one session's work. Add units the probe shows he needs before the text (for example, background the author assumes), with no reading. Give each book unit its `reading`: the ranges of the map it covers.

**Tests:** readings validated in `propose_course`, the card, learner edits and proposals; a merge joining readings; the uncovered-ranges rule on hand-worked cases; the unit context lines; `progress.md` against a hand-written expected file; the golden course with a followed book loads.

## 7. "Practice this unit" and side questions

**Change:**
- **Practice:** a "Practice this unit" session of a unit whose course has a book gets the book section (the outline and the unit's reading detail), the three retrieval tools and `quote_passage` (decision 7). The practice context marker adds "Reading: §178–§196". Standalone Practice sessions never have a book.
- **Side questions** (follow-up to decision 7): when the side question's anchor message holds quote cards, the side prompt adds each quoted location's text (the location and its neighbors, trimmed to about 2k tokens in all) and the book's outline without summaries (about 1k tokens), labeled "From the book". The side call stays tool-less.

**Proposed practice addition:** "This unit read a book. A problem may work from a passage: quote it with `quote_passage` first, then pose the problem about it."

**Tests:** the practitioner's tools and prompt with and without a book; the marker line; the side prompt with and without quote cards, its trimming, and no tools in the side call.

## 8. Docs

- **Fork README:** the decisions, the Books status, roadmap step 5, and the human checks.
- **`docs/architecture.md`:** the books storage row and version guard; import and recovery; the map writer in the worker pool and Background agents; the book section and tools; quotes and the reader; courses following a book.
- **`docs/development.md`:** `bookMapper` in `LH_BACKGROUND_CAPTURE`.
- **`src/agent/prompts/README.md`:** where the book doctrine, the additions, the tool descriptions and the writer prompt live. *Proposed:* fixed in code like the course prompts, not Settings → Prompts segments.

## Verification

- **After each item:** the required gate (typecheck, tests, lint), with scratch `LH_DATA_DIR` and `LH_AUTH_FILE`.
- **After items 3, 5 and 7:** `npm run build` and `scripts/smoke-server.mjs`, from a fresh isolated copy of the working tree that excludes `data/`, `auth.json` and credential files. The earlier saved-copy staging script is stale and is not reused unchanged.
- **Performance check (agent), after item 2:** a generated 600-page text PDF with bookmarks and §-numbered paragraphs: import time, server responsiveness during import (a concurrent `/api/books` read), `text.json` and `map.json` sizes, outline size against the 3k budget, and `read_section`/`search_book` latency.
- **Browser check (agent), after items 3, 5, 6 and 7:** a dev server on a scratch profile driven by the local fake OpenAI-compatible endpoint, covering: importing each format; a confident import accepted automatically; an unsure import reviewed, switched to another method and accepted; the structure pass run from review; a garbled PDF refused; the map writer starting by itself, its progress, Stop and Try again; a Teach session with a book where the teacher reads, quotes and is refused once for a misquote; the citation opening the panel and the highlight; a course following the book with readings edited in the card; unit 2's request holding its reading detail (checked in the fake endpoint's received system prompt); "Practice this unit" with a quote; a side question on a quote card (its prompt checked in the fake endpoint); the delete refusal, then deletion after the users are gone.
- **Human checks:** import your own copy of a real book (for example the *Phenomenology*) and judge the confidence call, the detected structure (or the review screen) and the map; run a Teach session and a course with it on your own provider, judging the quotes, citations and reader; check "Show original page" on a math-heavy PDF.
- **Safety:** nothing reads or writes `~/.config/LearnHarness` or `~/.config/LearnHarness-Fork`, the repo's `data/` or `auth.json`. Tests use fakes and generated fixtures. No paid providers, no real sign-ins, and no dependencies added.

## Implementation order

1. Book record, store, import (no model).
2. The map writer.
3. Library and book pages. **Checkpoint 1.**
4. Attaching a book; the book in prompts; retrieval tools.
5. Quotes, citations, the reader panel. **Checkpoint 2.**
6. Courses that follow a book.
7. "Practice this unit" and side questions.
8. Docs.

Items 1–3 stand alone (a library with no agent use). Items 4–5 give standalone Teach sessions the full feature; items 6–7 extend it to courses.

## Finishing

- **Commits:** one per item, in order, on the books branch.
- **Completion report per item:** what changed, checks and results, human checks still owed, and agent-selected choices.
- If implementation raises a product question this plan doesn't settle, work stops and the question goes to the human.

## Outcome

### Item 1 (2026-11-14)

- **Built:**
  - Contracts in `src/core/contracts/book.ts`: the record, blocks with page breaks, map nodes, candidates, ranges, the chat's `book` field and the course's `book` and units' `reading` (declared only; nothing sets them before item 4), and quote details for item 5.
  - Pure rules in `src/core/book.ts`, exported through the core barrel: normalization with an offset map, word counts, the garbled-text check, numbered-paragraph runs, the four candidates and their confidence, the choice, location resolution, and the outline, detail and range texts with their budgets.
  - Converters in `src/server/book-import.ts`:
    - PDF, through a new `pageLines` export of `pdf-markdown.ts` (the same lines and heading levels the notes converter uses, plus each line's right edge) and a `withPdfDocument` helper in `pdf-ops.ts`;
    - EPUB, through a new minimal zip reader (`src/server/unzip.ts`);
    - text and Markdown.
  - The store `src/store/books.ts` (`PATHS.books`) with the version guard on the record and data files, and the `books-changed` event. `writeFileAtomicSync` now also takes bytes, for the original file.
  - The service `src/server/books.ts`: import with up-front refusals, background conversion, automatic acceptance of confident contents, review, switching, interruption and Try again, rename, and the library summaries. A `contentsAccepted` seam is where item 2 starts the map writer.
  - Routes: `GET/POST /api/books`, `GET/PUT /api/books/:id`, `GET/PUT /api/books/:id/contents`, `POST /api/books/:id/retry-import`.
  - The plugin API reference was regenerated (`docs/plugin-api/`): the chat record's `book` field and `books-changed`. No callable API was added.
  - A golden book under `tests/fixtures/golden-data/books/`, written by the real import service.
- **Agent-selected:**
  - **PDF paragraphs:** a paragraph breaks at a heading, a gap over 1.6 line spacings, a first-line indent, a short line ending in punctuation, or a numbered start after a finished sentence. It continues onto the next page when it doesn't end a sentence and the next page's first line isn't indented, recording the page break's offset.
  - **Running heads:** a line in a page's top or bottom two positions is dropped when its text (digits and roman numerals ignored) appears there on at least 3 pages and a fifth of the book, or when it is only a page number. Lines set as level-1 or level-2 headings are never dropped.
  - **Line-end hyphens:** kept when the joined word appears hyphenated elsewhere in the book ("well-known"), else dropped ("hyphen-ated" becomes "hyphenated"). Quote and search normalization drop hyphens between letters on both sides, so either reading matches.
  - **EPUB:** XHTML content documents parse as XML, so a self-closing print page mark stays empty; `text/html` items parse as HTML. Text is kept plain (emphasis markup is not kept). Font obfuscation (IDPF and Adobe) is allowed; any other encryption, or `META-INF/rights.xml`, is refused as DRM.
  - **Confidence of a file's own contents:** a stretch counts as a gap only when it is over a quarter of the book **and** over four times the outline's typical entry. A book of two halves is fine; forty bookmarks in its first fifth are not. The plan's flat quarter rule called a correct two-part outline unsure. Titles must appear near their destination for 70% of entries.
  - **Numbered runs:** start at 1–3, accept the next number or up to three ahead, and resync after a larger jump only when the next two starts continue from it. At least 10 starts make a candidate.
  - **Labels:** a title's numbering when it has one ("IV", "Chapter 2", "1.3"), else the title shortened to 40 characters. Numbered paragraphs are cited "§N" whatever their printed form.
  - **Refusals before a record exists:** type, size, duplicate content, an unreadable PDF, too many pages, a protected EPUB, binary text. The no-text-layer and garbled checks need the whole conversion, so they settle on the record as a failed import with the reason.
  - **Short books:** `mapWriter` is `not-needed` when the accepted contents' book has fewer than 20,000 words.
  - **Wording the plan didn't specify:** reasons such as "The bookmarks aren't in the text's order.", "Only 2 of 4 bookmarks point to a place in the text.", "The table of contents has only 1 entry.", "The paragraph numbers have gaps: 25 of 1–30 found.", "Some paragraph numbers repeat or run backwards (3 times), for example in notes or lists.", "The numbered paragraphs start late in the text.", "This file has no readable text.", "The import failed. Try again.", "The import was interrupted.", and descriptions such as "§1–§30 under 2 headings", "2 entries, §1–§30 within them", "3 headings", "5 parts of about 2,000 words".
- **Checks:**
  - Typecheck passed. Lint passed with the inherited warning in `tests/source-name-ui.test.tsx`.
  - Full suite: **5,670 passed, 0 failed, 4 skipped** (5,674 tests), with scratch `LH_DATA_DIR` and `LH_AUTH_FILE`.
  - New: `tests/books.test.ts` (32) and `tests/book-import.test.ts` (21), with expected values worked by hand, plus a golden case in `tests/golden-fixtures.test.ts`. `tests/helpers/tiny-pdf.ts` gained bookmarks, page labels and document info.
  - **Mutation checks:** each of these fails its targeted test: the flat quarter gap rule; no resync in numbered runs; keeping running heads; always dropping line-end hyphens.
  - The EPUB walker's first draft lost the text after a self-closing page mark; the converter test caught it, which led to parsing XHTML as XML.
- **Moved to item 4:** the test "refusing to attach a book still in review" needs attaching, which item 4 builds.
- **Not done in this item:** no build or browser check (no UI yet); the performance check on a 600-page PDF follows item 2, as planned.

### Item 1 review repairs (2026-11-14)

The human approved fixing all thirteen findings within item 1, without new dependencies, storage-format or UI changes, commits, or access to real learning data.

- **PDF fidelity:** the garbled-text check accepts Cyrillic/CJK prose while retaining Latin nonword, symbol and broken-glyph checks. Rotated text is retained, excluded from repeated-margin removal, and kept separate from differently oriented paragraphs.
- **EPUB fidelity:** MathML/SVG retain text or one accessible alternative without repeated metadata; XML decoding handles UTF-8 and UTF-16 in either byte order; missing spine content is refused with the existing unreadable-file message. Inline print-page marks retain the starting page and normalized UTF-16 boundary offsets. URI fragments are decoded before anchor lookup.
- **Structure and locations:** leading outline coverage is checked even for two entries, without rejecting two valid halves. Printed labels take precedence consistently across a page range; omitted labels still mean the printed number equals the physical number. Compound labels such as `IV.A` and ranges containing hyphenated endpoint labels resolve correctly. Selected reading roots retain their relative hierarchy during budget collapse.
- **Map guard:** accepting the shown contents, explicitly reaccepting its method, and switching candidates all check the existing map before any write or writer callback. Newer and damaged maps return 409 and leave the record and map byte-identical.
- **Agent-selected implementation:** preserve plain text rather than adding a math renderer; normalize EPUB whitespace while recording boundaries; resolve ranges by their valid endpoint pairs; compute detail depth within the selected forest. Storage versions and exported signatures are unchanged.
- **Additional wording approval:** the human approved `"<input>" matches several ranges. Use section ids with "to".` for ambiguous endpoint splits.
- **Regression proof:** fourteen added cases cover all thirteen findings (the map guard covers newer and damaged files separately). Restoring the six former core failure mechanisms in an isolated copy fails all six corresponding cases, while its 32 pre-existing core cases pass. Replaying the preserved original converter and unguarded acceptance service fails the eight converter/map-guard cases while the 21 pre-existing import cases pass. The repaired books/import/golden checks pass all 81 cases.
- **Runtime proof:** a generated PDF containing only rotated text imports as one page with its full extracted sentence. The first rotated regression fixture placed text outside the page; correcting its coordinates kept the expected text intact rather than weakening the assertion.
- **Focused checks:** typecheck passed. Lint passed with the inherited `tests/source-name-ui.test.tsx` warning. The books/import/golden run passed 81 cases; the shared PDF and atomic-write checks passed 60 cases with one Windows-only skip. All runs used scratch data/auth paths.
- **Required full test gate:** 5,684 passed, 0 failed, 4 skipped (5,688 tests), with scratch `LH_DATA_DIR` and `LH_AUTH_FILE`. No build or browser check was run for these backend-only repairs. The existing item-2 performance check and later UI checkpoints remain unchanged.

### Item 2 (2026-11-14)

- **Built:**
  - The `bookMapper` role on the Cheap slot, with the schema-level override `agent.models.bookMapper` and no Settings row. The plugin API reference was regenerated (`BACKGROUND_MODEL_ROLES`).
  - The writer in `src/agent/subagents/book-mapper.ts`: leaves in book order, batched into `submit_summaries` calls (up to 3 fixes each), then parents bottom-up from their children's summaries, deepest level first. A section longer than one batch is read in windows, each later window given the summary, terms (and title) so far. Validation: every id once, no unknown ids, a summary of at most 200 characters, at most 6 terms, and a title of at most 60 characters for an untitled part.
  - The optional contents pass in the same module: one `submit_structure` call over a digest of candidate heading lines (core `structureDigest`), validated (lines given, book order, levels, lengths), whose headings become the `model` candidate (core `modelCandidate`).
  - The lifecycle in `src/server/book-maps.ts`: purpose `user`, the shared worker pool, each finished batch written to `map.json` and the record at once, Stop, interruption read as "Interrupted.", Try again continuing with what's left, and no Cheap model failing the writer at once. Background agents rows "Book map · <title>" ("<done> of <total> sections") and "Book contents · <title>" ("Finding the contents"), each with Stop.
  - Wiring in `src/server/books.ts`: accepted contents (automatically or by the learner) start the writer; switching the contents discards a running writer before the map is replaced; reads settle interrupted writers.
  - Routes: `POST /api/books/:id/map-writer` (Try again), `GET /api/books/:id/structure-writer` (the estimate for "about <n>k tokens on <model>") and `POST` (run the pass). The activity abort route takes `book-map-writer` and `book-contents-writer`.
  - `LH_BACKGROUND_CAPTURE=bookMapper` works through the role (checked on a scratch profile: one `bookMapper-<run>.json` capture with the book as its source). `docs/development.md` and `src/agent/prompts/README.md` name the role and the prompts.
- **Human decisions during implementation (2026-11-14):**
  - The contents pass's prompt: the agent's draft, approved as written (`BOOK_STRUCTURE_PROMPT`).
  - The contents pass shows in Background agents as "Book contents · <title>" with "Finding the contents", its live cost and Stop. Stopped, it fails as "Stopped" and the review screen keeps the other methods.
- **Agent-selected:**
  - **Batches (updated by the item-2 review repairs):** at most about 12k tokens of text and 40 sections per call. Smaller batches and windows are chosen against the complete native request (system prompt, tool schema, book/section metadata and prior window summary), the production provider's context clamp, and space for a full legal answer. Output limits can reduce the section count too.
  - **Windows:** whole lines while they fit, a longer line word by word; only the last window's result is stored.
  - **Parents** read one line per subsection: its label, title, summary and terms. Only app-made parts are "untitled"; numbered paragraphs keep their labels and get no titles.
  - **Limits not in the plan:** a term of at most 60 characters; for the contents pass, labels of at most 40 characters, titles of at most 150, and levels 1–6. A title the model leaves out is the line's text, and a missing label comes from the title's numbering. The first heading must be level 1, and a level goes at most one deeper than the one before.
  - **Digest (updated by the item-2 review repairs):** strong lines are the converter's headings, lines starting with a chapter word, and short numbered lines; weak lines are other paragraphs of at most 80 characters and 12 words. Strong lines are kept first, each kind spread evenly over the book, and the model is told how many were left out. The about-8k-token ceiling is reduced for the selected model's context and output limits, including the full prompt, tool schema and answer. Lines are shortened to 120 characters.
  - **The `model` candidate** nests confident numbered paragraphs under its headings, as the file's own contents do. A new pass replaces an earlier `model` candidate. It is always unsure, with the reason "The model chose these contents from the text's likely heading lines."
  - **Usage:** the record's usage carries over a Try again on the same model, so it shows the whole map's cost; the activity row shows the current run's.
  - **A discarded writer** (contents switched; later, a deleted book) is aborted and never writes again: the writer belongs to the registry entry, and every write checks it.
  - **Ids and labels:** activity ids `<bookId>:map` and `<bookId>:contents`; dock labels "Book map writer" and "Contents finder", with book and list icons.
  - **Wording not in the plan:** "Accept the book's contents first.", "The map is already being written.", "The map is already written.", "This book is short: it needs no map.", "This book has no lines that look like headings.", "The contents are already being found.", "The model found no headings in this book.", "The book's contents changed while its map was written.", "This book's text can't be read.", and the model's problem messages in `book-mapper.ts`.
  - **The estimate (updated by the item-2 review repairs)** uses the same selected digest as execution and includes the native prompt, tool schema and reserved answer space.
- **Performance check** (a generated 600-page text PDF: 4.2 MB, 8 parts and 48 chapters as bookmarks, §1–§808, 324,424 words; scratch profile; the script is not committed):
  - *First run:* the import settled in 6.2 s, but one stretch held the event loop for 3.2 s: building the candidates took 2.0 s, almost all in `normalizeBookText`, and the PDF post-pass ran 1.4 s without yielding. The plan's assumption that page-by-page conversion keeps the server responsive held only for the page reading.
  - *Fixes (agent-selected; results unchanged):* an ASCII fast path in `normalizeBookText` (identical output on 400,000 random strings and the whole book; search normalization of the book went from 1.4 s to 0.17 s); the garbled-page rule with one regex per token instead of one per letter, stripping accents only when no plain vowel is found (identical on 100,000 random pages, including 2,769 garbled ones, and the book), evaluated in 32-page chunks; yields between the PDF post-pass steps and every 16 pages, and between building candidates and writing the files.
  - *After:* the import settles in 3.4 s; the longest stall during background conversion is about 330 ms; concurrent library reads take a median of 0.3 ms. The upload request itself takes about 1–1.7 s on a server's first PDF because pdfjs loads cold, and holds the server for that long once per process. This is how the existing in-process PDF reading already behaves, and it is not changed here.
  - *Sizes:* `text.json` 2.71 MB, `map.json` 0.13 MB (0.21 MB with summaries), `candidates.json` 0.30 MB.
  - *Outline:* about 694 tokens of the 3,000 with titles only, showing parts and chapters with § counts; about 2,836 with a 150-character summary on every node; about 1,350 with the fake writer's summaries.
  - *Reads (proxies; item 4 builds the tools):* resolving §187 and slicing its text 3.4 ms; pp. 114–116 0.5 ms; Chapter 12 2.9 ms. Searching by normalizing every block per query costs 116 ms against 1.1 ms over a book normalized once, so item 4's `search_book` should normalize a book once and cache it.
  - *Map writer on a fake engine:* 66 calls for 864 sections (about 17 numbered paragraphs per call, four long chapters at the end read in windows), about 698k prompt tokens in all, close to the book's own size.
- **Checks:**
  - Typecheck passed. Lint passed with the inherited warning in `tests/source-name-ui.test.tsx`.
  - New `tests/book-maps.test.ts` (18), with expected values worked by hand, plus a dock case in `tests/render-activity-dock.test.tsx`; role lists updated in the settings and catalog tests.
  - **Mutation checks:** each of these fails its targeted test: parents reading their own text instead of their children's summaries; batches not written to `map.json`; Try again starting over; a discarded writer recording its Stop; no summary validation; windows without the summary so far; background purpose; the contents pass accepting its own result; a digest that doesn't keep strong lines first; no section cap per call; an untitled part allowed without a title.
  - Full suite, after every change above: **5,703 passed, 0 failed, 4 skipped** (5,707 tests), with scratch `LH_DATA_DIR` and `LH_AUTH_FILE`.
- **Initial item-2 limits:** no production build was run. Item 3 builds the library and book pages; its full writer-flow browser check remains. The focused repair browser check below verifies the existing activity sidebar. `docs/architecture.md` is updated in item 8, as planned.
- **Noted for later items:** a part's own text before its first subsection (a chapter's introduction) reaches its summary only through its subsections, as the plan specifies. If the human's real books show weak chapter summaries, the parent input could include that text.

### Item 2 review repairs (2026-11-14)

- **Request budgeting:** replaced half-context/text-only sizing with complete native requests checked against pi-ai's production context clamp and full-sized submitted answers. Long windows reserve space for the largest legal prior summary, terms and title. Requests too small to be useful fail before provider dispatch with the human-approved explanation recorded in the fork README.
- **Contents preview and execution:** `prepareStructurePass` selects one model-sized digest for the estimate, dispatched prompt and validation. Direct worker callers use the same preparation; selected blocks, page labels and omission counts stay consistent.
- **Replacing a model candidate:** explicit acceptance compares the candidate with the current map even when both methods are `model`. Changed contents discard the old writer and restart summaries. Unchanged contents keep existing summaries, terms and writer progress.
- **Stop after retry:** client abort state uses the book writer's stable abort id plus its creation time. A retry can be stopped with or without an intervening empty feed; a late response from the previous run cannot lock or unlock the new run.
- **Focused checks:** 127 tests passed across books, import, map workers, activity rendering, retry interaction and existing plugin-worker activity. Typecheck passed; lint passed with the inherited `tests/source-name-ui.test.tsx` warning.
- **Browser:** the real development sidebar in WebKit on a scratch profile, with offline activity/abort HTTP fixtures: stopped and resumed both writer kinds without remounting the sidebar, observed each retry's enabled Stop, and stopped both resumed rows. Backend worker cancellation, persistence and resume are covered separately by the real service/route tests with faux engines. No paid provider or real learning data was used. Chromium could not launch; WebKit completed the check. The first navigation exceeded the tool timeout during cold compilation; the warmed page and API both returned 200.
- **Required full gate:** 5,718 passed, 0 failed, 4 skipped (5,722 tests), using scratch data/auth paths. Typecheck and lint passed as noted above. No production build was run for these repairs.

