/**
 * The one stylesheet every note and export carries. Files are always a
 * light, print-friendly page (fork decision, plan 03); the app's notes page
 * inverts the frame for dark reading, the way demo cards do.
 *
 * Body rules sit under `.lh-doc-body` with zero-specificity `:where()`, so
 * a Mermaid diagram's own id-scoped styles and a note's inline `style`
 * attributes always win.
 */
export const DOCUMENT_FONTS = {
	text: `"Source Sans 3", "Source Sans Pro", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`,
	title: `"CMU Serif", "Latin Modern Roman", "Computer Modern Serif", Georgia, "Times New Roman", serif`,
	code: `"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace`,
};

export const DOCUMENT_STYLESHEET = String.raw`
:root {
	color-scheme: light;
	--lh-ink: #23221f;
	--lh-ink-soft: #3d3c38;
	--lh-muted: #74726b;
	--lh-rule: #e3e0d6;
	--lh-surface: #f5f3ed;
	--lh-code: #a84f2f;
	--lh-link: #2b5fb8;
	--lh-blue: #3266c9;
	--lh-blue-tint: #eef3fc;
	--lh-green: #3f8f6b;
	--lh-green-tint: #edf6f1;
	--lh-red: #c0453b;
	--lh-red-tint: #fcf0ee;
	--lh-amber: #b8822a;
	--lh-amber-tint: #fbf4e6;
	--lh-font-text: ${DOCUMENT_FONTS.text};
	--lh-font-title: ${DOCUMENT_FONTS.title};
	--lh-font-code: ${DOCUMENT_FONTS.code};
}

*, *::before, *::after { box-sizing: border-box; }

html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }

body {
	margin: 0;
	background: #ffffff;
	color: var(--lh-ink);
	font-family: var(--lh-font-text);
	font-size: 17px;
	line-height: 1.6;
	font-kerning: normal;
	overflow-wrap: break-word;
}

.lh-doc {
	max-width: 46rem;
	margin: 0 auto;
	padding: 3rem 1.5rem 4rem;
}

.lh-doc-header {
	margin-bottom: 2.25rem;
	padding-bottom: 1.25rem;
	border-bottom: 1px solid var(--lh-rule);
}

.lh-doc-title {
	margin: 0;
	font-family: var(--lh-font-title);
	font-weight: 700;
	font-size: 2.1rem;
	line-height: 1.15;
	letter-spacing: -0.005em;
	color: var(--lh-ink);
}

.lh-doc-subtitle {
	margin: 0.6rem 0 0;
	color: var(--lh-muted);
	font-size: 0.95rem;
	line-height: 1.45;
}

/* ─── body text ─────────────────────────────────────────────── */

.lh-doc-body :where(h2, h3, h4) {
	color: var(--lh-ink);
	line-height: 1.25;
	margin: 2.2rem 0 0.7rem;
}
.lh-doc-body :where(h2) { font-size: 1.5rem; font-weight: 800; letter-spacing: -0.01em; }
.lh-doc-body :where(h3) { font-size: 1.2rem; font-weight: 700; margin-top: 1.8rem; }
.lh-doc-body :where(h4) { font-size: 1.05rem; font-weight: 700; margin-top: 1.5rem; }
.lh-doc-body > :where(:first-child) { margin-top: 0; }

.lh-doc-body :where(p) { margin: 0 0 1rem; }
.lh-doc-body :where(strong, b) { font-weight: 700; color: var(--lh-ink); }
.lh-doc-body :where(ul, ol) { margin: 0 0 1rem; padding-left: 1.5rem; }
.lh-doc-body :where(li) { margin: 0.25rem 0; }
.lh-doc-body :where(li > ul, li > ol) { margin: 0.25rem 0 0.4rem; }
.lh-doc-body :where(hr) { border: 0; border-top: 1px solid var(--lh-rule); margin: 2rem 0; }

.lh-doc-body :where(a) {
	color: var(--lh-link);
	text-decoration: underline;
	text-decoration-thickness: 1px;
	text-underline-offset: 0.15em;
}

.lh-doc-body :where(blockquote) {
	margin: 0 0 1rem;
	padding: 0.1rem 0 0.1rem 1rem;
	border-left: 3px solid var(--lh-rule);
	color: var(--lh-ink-soft);
}

/* ─── code ──────────────────────────────────────────────────── */

.lh-doc :where(code, kbd, samp, pre) {
	font-family: var(--lh-font-code);
	font-variant-ligatures: none;
}
.lh-doc-body :where(:not(pre) > code) {
	font-size: 0.86em;
	color: var(--lh-code);
	background: var(--lh-surface);
	border-radius: 4px;
	padding: 0.1em 0.35em;
}
.lh-doc-body :where(pre) {
	margin: 0 0 1.1rem;
	padding: 0.85rem 1rem;
	background: var(--lh-surface);
	border: 1px solid var(--lh-rule);
	border-radius: 8px;
	font-size: 0.82rem;
	line-height: 1.55;
	overflow-x: auto;
	white-space: pre;
}
.lh-doc-body :where(pre code) { font-size: inherit; color: inherit; background: none; padding: 0; }

/* ─── tables ────────────────────────────────────────────────── */

.lh-doc-body :where(table) {
	display: block;
	max-width: 100%;
	overflow-x: auto;
	margin: 0 0 1.2rem;
	border-collapse: collapse;
	font-size: 0.95em;
	line-height: 1.45;
}
.lh-doc-body :where(th, td) {
	border: 1px solid var(--lh-rule);
	padding: 0.45rem 0.7rem;
	text-align: left;
	vertical-align: top;
}
.lh-doc-body :where(th) { background: var(--lh-surface); font-weight: 700; }

/* ─── figures, diagrams, math ───────────────────────────────── */

.lh-doc-body :where(figure) { margin: 1.6rem 0; text-align: center; }
.lh-doc-body :where(img) { max-width: 100%; height: auto; }
.lh-doc-body :where(figure > img, figure > svg) { display: block; margin: 0 auto; }
.lh-doc-body :where(figcaption) {
	margin-top: 0.55rem;
	color: var(--lh-muted);
	font-size: 0.9rem;
	line-height: 1.4;
}
.lh-doc-body :where(svg) { max-width: 100%; height: auto; }
.lh-diagram { margin: 1.6rem 0; text-align: center; }
/* Mermaid gives each SVG width="100%" plus an inline max-width at its natural
   size: wide diagrams shrink to the column, small ones keep their size. */
.lh-diagram > svg { height: auto; }

.lh-doc-body .katex { font-size: 1.1em; }
.lh-doc-body .katex-display {
	margin: 1rem 0;
	overflow-x: auto;
	overflow-y: hidden;
	padding: 0.15rem 0;
}

/* ─── callouts ──────────────────────────────────────────────── */

.lh-doc-body :where(.definition, .example, .misconception, .key-idea) {
	margin: 1.3rem 0;
	padding: 0.85rem 1.1rem 0.8rem;
	border-left: 4px solid var(--lh-callout);
	border-radius: 0 8px 8px 0;
	background: var(--lh-callout-tint);
	-webkit-print-color-adjust: exact;
	print-color-adjust: exact;
}
.lh-doc-body :where(.definition, .example, .misconception, .key-idea)::before {
	display: block;
	margin-bottom: 0.3rem;
	color: var(--lh-callout);
	font-size: 0.72rem;
	font-weight: 700;
	letter-spacing: 0.08em;
	text-transform: uppercase;
}
.lh-doc-body :where(.definition, .example, .misconception, .key-idea) > :where(:last-child) { margin-bottom: 0; }
.lh-doc-body :where(.definition) { --lh-callout: var(--lh-blue); --lh-callout-tint: var(--lh-blue-tint); }
.lh-doc-body :where(.definition)::before { content: "Definition"; }
.lh-doc-body :where(.example) { --lh-callout: var(--lh-green); --lh-callout-tint: var(--lh-green-tint); }
.lh-doc-body :where(.example)::before { content: "Example"; }
.lh-doc-body :where(.misconception) { --lh-callout: var(--lh-red); --lh-callout-tint: var(--lh-red-tint); }
.lh-doc-body :where(.misconception)::before { content: "Misconception"; }
.lh-doc-body :where(.key-idea) { --lh-callout: var(--lh-amber); --lh-callout-tint: var(--lh-amber-tint); }
.lh-doc-body :where(.key-idea)::before { content: "Key idea"; }

/* ─── collapsible sections ──────────────────────────────────── */

.lh-doc-body :where(details) {
	margin: 1rem 0;
	padding: 0.55rem 0.9rem;
	border: 1px solid var(--lh-rule);
	border-radius: 8px;
}
.lh-doc-body :where(details[open]) { padding-bottom: 0.8rem; }
.lh-doc-body :where(summary) {
	cursor: pointer;
	font-weight: 600;
	color: var(--lh-ink-soft);
}
.lh-doc-body :where(details[open] > summary) { margin-bottom: 0.6rem; }
.lh-doc-body :where(details) > :where(:last-child) { margin-bottom: 0; }

/* ─── conversation exports ──────────────────────────────────── */

.lh-learner {
	margin: 1.6rem 0 1.4rem;
	padding: 0.7rem 1rem;
	border-radius: 10px;
	background: var(--lh-surface);
	color: var(--lh-ink-soft);
	-webkit-print-color-adjust: exact;
	print-color-adjust: exact;
}
.lh-learner > :where(:last-child) { margin-bottom: 0; }
.lh-label {
	display: block;
	margin-bottom: 0.25rem;
	color: var(--lh-muted);
	font-size: 0.72rem;
	font-weight: 700;
	letter-spacing: 0.08em;
	text-transform: uppercase;
}

.lh-question {
	margin: 1.4rem 0;
	padding: 0.85rem 1.1rem;
	border: 1px solid var(--lh-rule);
	border-radius: 10px;
}
.lh-question-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
.lh-question-prompt { margin: 0.2rem 0 0.6rem; font-weight: 600; }
.lh-question-prompt > :where(:last-child) { margin-bottom: 0; }
.lh-result {
	flex: none;
	padding: 0.05rem 0.55rem;
	border-radius: 999px;
	font-size: 0.78rem;
	font-weight: 700;
	-webkit-print-color-adjust: exact;
	print-color-adjust: exact;
}
.lh-result-right { color: var(--lh-green); background: var(--lh-green-tint); }
.lh-result-wrong { color: var(--lh-red); background: var(--lh-red-tint); }
.lh-result-dontknow { color: var(--lh-amber); background: var(--lh-amber-tint); }
.lh-result-skipped, .lh-result-answered { color: var(--lh-muted); background: var(--lh-surface); }
.lh-options { list-style: none; margin: 0 0 0.6rem; padding: 0; }
.lh-option {
	position: relative;
	margin: 0.3rem 0;
	padding: 0.3rem 0.6rem 0.3rem 2rem;
	border-radius: 6px;
}
.lh-option::before {
	position: absolute;
	left: 0.6rem;
	top: 0.3rem;
	width: 1rem;
	text-align: center;
	color: var(--lh-muted);
	content: "○";
}
.lh-option-chosen::before { content: "●"; color: var(--lh-ink-soft); }
.lh-option-correct { background: var(--lh-green-tint); -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.lh-option-correct::before { content: "✓"; color: var(--lh-green); font-weight: 700; }
.lh-option-chosen.lh-option-wrong { background: var(--lh-red-tint); -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.lh-option-chosen.lh-option-wrong::before { content: "✗"; color: var(--lh-red); font-weight: 700; }
.lh-option-note { color: var(--lh-muted); font-size: 0.85rem; margin-left: 0.4rem; }
.lh-question-answer { margin: 0 0 0.5rem; }
.lh-question-meta { margin: 0; color: var(--lh-muted); font-size: 0.9rem; }
.lh-question-meta + .lh-question-meta { margin-top: 0.2rem; }

.lh-verbatim { white-space: pre-wrap; }
.lh-learner-text { margin: 0; }
.lh-images { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.6rem; }
.lh-images > img { max-width: 100%; max-height: 18rem; border-radius: 6px; border: 1px solid var(--lh-rule); }
.lh-quote {
	margin: 0.5rem 0;
	padding: 0.1rem 0 0.1rem 0.8rem;
	border-left: 3px solid var(--lh-rule);
	color: var(--lh-ink-soft);
}
.lh-quote-comment { margin: 0.35rem 0 0; }
.lh-question-details { margin: -0.3rem 0 0.6rem; color: var(--lh-muted); font-size: 0.92rem; }
.lh-question-details > :where(:last-child) { margin-bottom: 0; }
.lh-option-description { display: block; color: var(--lh-muted); font-size: 0.85rem; }
.lh-question .lh-why { margin: 0.6rem 0 0; padding: 0.4rem 0.8rem; }
.lh-question .lh-why > summary { font-weight: 600; font-size: 0.9rem; }
.lh-answer-key { margin-top: 0.7rem; padding: 0.6rem 0.85rem; border-radius: 8px; background: var(--lh-surface); }
.lh-answer-key > :where(:last-child) { margin-bottom: 0; }
.lh-artifact-failed { margin: 1.2rem 0; color: var(--lh-muted); }
.lh-artifact-failed > p { margin: 0; }
.lh-side-answer > :where(:last-child) { margin-bottom: 0; }
.lh-side .lh-learner { margin: 0.6rem 0; }

.lh-plan { margin: 1.6rem 0; }
.lh-plan > svg { display: block; width: 100%; height: auto; margin: 0 auto; }

.lh-demo { margin: 1.6rem 0; text-align: left; }
.lh-demo > iframe {
	display: block;
	width: 100%;
	height: 420px;
	border: 1px solid var(--lh-rule);
	border-radius: 10px;
	background: #ffffff;
}
.lh-demo > figcaption { text-align: left; margin: 0 0 0.45rem; }

.lh-side > summary, .lh-brief > summary { font-weight: 600; }
.lh-side-quote { color: var(--lh-muted); font-weight: 400; font-style: italic; }
.lh-brief-sources { color: var(--lh-muted); font-size: 0.9rem; }

/* ─── items that could not be rendered ──────────────────────── */

.lh-failed {
	display: block;
	margin: 1rem 0;
	padding: 0.65rem 0.9rem;
	border: 1px dashed var(--lh-red);
	border-radius: 8px;
	background: var(--lh-red-tint);
	text-align: left;
}
.lh-failed-label {
	display: block;
	margin: 0 0 0.4rem;
	color: var(--lh-red);
	font-size: 0.85rem;
	font-weight: 600;
}
.lh-failed pre, .lh-failed code {
	display: block;
	margin: 0;
	padding: 0;
	border: 0;
	background: none;
	color: var(--lh-ink-soft);
	font-size: 0.8rem;
	white-space: pre-wrap;
}
.lh-doc-body code.lh-failed-inline {
	color: var(--lh-red);
	background: var(--lh-red-tint);
	outline: 1px dashed var(--lh-red);
}

/* ─── print ─────────────────────────────────────────────────── */

@page { margin: 16mm 15mm 18mm; }

@media print {
	body { font-size: 11pt; }
	.lh-doc { max-width: none; padding: 0; }
	.lh-doc-header { margin-bottom: 1.5rem; }
	.lh-doc-body :where(h2, h3, h4) { break-after: avoid; page-break-after: avoid; }
	.lh-doc-body :where(figure, pre, blockquote, tr, .lh-diagram, .definition, .example, .misconception, .key-idea, .lh-failed, .katex-display) {
		break-inside: avoid;
		page-break-inside: avoid;
	}
	.lh-doc-body :where(pre) { white-space: pre-wrap; overflow-wrap: anywhere; overflow: visible; }
	.lh-doc-body :where(table) { display: table; overflow: visible; }
	.lh-doc-body .katex-display { overflow: visible; }
	.lh-doc-body :where(details) { border-color: var(--lh-rule); }
	.lh-doc-body details::details-content { content-visibility: visible; display: block; }
}
`;
