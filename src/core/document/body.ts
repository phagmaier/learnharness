import { parseHTML } from "linkedom";
import { escapeHtml } from "./html.ts";
import { renderTex, splitMath, type MathFailure } from "./math.ts";

/**
 * Prepare a document body (note or export) for its final file, in one parse:
 * Mermaid blocks are lifted out for the browser helper, TeX is rendered with
 * KaTeX, and links open outside the page. Rendered markup is spliced in by
 * token after serialization, so KaTeX and Mermaid output never round-trips
 * through the HTML parser.
 */

/** Text in these elements is literal: no math, no rewriting. */
const LITERAL_TAGS = new Set([
	"pre", "code", "kbd", "samp", "svg", "math", "script", "style", "textarea", "template", "noscript", "title",
]);
/** `lh-verbatim` marks learner-written text, shown as typed (as in the chat). */
const LITERAL_CLASSES = ["mermaid", "katex", "katex-display", "lh-verbatim"];
const MERMAID_SELECTOR = "pre.mermaid, div.mermaid";

export interface DiagramSlot {
	/** Stands in for the diagram in `PreparedBody.html` until it is filled. */
	token: string;
	/** The Mermaid source as written (entities decoded, trimmed). */
	source: string;
}

export interface PreparedBody {
	/** Body HTML with math rendered and one token per diagram. */
	html: string;
	mathFailures: MathFailure[];
	diagrams: DiagramSlot[];
}

type DomNode = {
	nodeType: number;
	localName?: string;
	childNodes: ArrayLike<DomNode>;
	data?: string;
	getAttribute?(name: string): string | null;
};

function isLiteral(node: DomNode): boolean {
	if (node.nodeType !== 1) return false;
	if (LITERAL_TAGS.has((node.localName ?? "").toLowerCase())) return true;
	const classes = (node.getAttribute?.("class") ?? "").split(/\s+/);
	return LITERAL_CLASSES.some((name) => classes.includes(name));
}

function textNodes(node: DomNode, out: DomNode[]): DomNode[] {
	for (const child of Array.from(node.childNodes)) {
		if (child.nodeType === 3) out.push(child);
		else if (child.nodeType === 1 && !isLiteral(child)) textNodes(child, out);
	}
	return out;
}

function randomNonce(): string {
	return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

export function prepareDocumentBody(html: string): PreparedBody {
	const nonce = randomNonce();
	const { document } = parseHTML(`<!doctype html><html><head></head><body>${html}</body></html>`);
	const root = document.body;
	const splices = new Map<string, string>();
	let counter = 0;
	const nextToken = (kind: string) => `lh${kind}${nonce}x${counter++}`;

	const diagrams: DiagramSlot[] = [];
	for (const element of Array.from(root.querySelectorAll(MERMAID_SELECTOR))) {
		const token = nextToken("diagram");
		diagrams.push({ token, source: (element.textContent ?? "").trim() });
		element.replaceWith(document.createTextNode(token));
	}

	const mathFailures: MathFailure[] = [];
	// The parser splits text at every entity (`\(a &lt; b\)` arrives as three
	// nodes); merge adjacent text so each formula is read whole.
	root.normalize();
	for (const node of textNodes(root as unknown as DomNode, [])) {
		const text = node.data ?? "";
		if (!text.includes("\\(") && !text.includes("\\[")) continue;
		const segments = splitMath(text);
		if (segments.every((segment) => segment.kind === "text")) continue;
		let replaced = "";
		for (const segment of segments) {
			if (segment.kind === "text") {
				replaced += segment.text;
				continue;
			}
			const token = nextToken("math");
			replaced += token;
			if (segment.kind === "unclosed") {
				const message = `No closing ${segment.display ? "\\]" : "\\)"}`;
				mathFailures.push({ source: segment.source, display: segment.display, message });
				splices.set(token, failedInline(segment.source, message));
				continue;
			}
			const rendered = renderTex(segment.tex, segment.display);
			if (rendered.ok) {
				splices.set(token, rendered.html);
			} else {
				mathFailures.push({ source: segment.source, display: segment.display, message: rendered.message });
				splices.set(token, segment.display ? failedDisplayMath(segment.source, rendered.message) : failedInline(segment.source, rendered.message));
			}
		}
		node.data = replaced;
	}

	for (const link of Array.from(root.querySelectorAll("a[href]"))) {
		if ((link.getAttribute("href") ?? "").trim().startsWith("#")) continue;
		link.setAttribute("target", "_blank");
		link.setAttribute("rel", "noopener");
	}

	let out = root.innerHTML;
	for (const [token, markup] of splices) out = out.replace(token, () => markup);
	return { html: out, mathFailures, diagrams };
}

export type DiagramOutcome =
	| { status: "unavailable" }
	| { status: "rendered"; diagrams: Array<{ ok: true; svg: string } | { ok: false; error: string }> };

export interface DiagramFailure {
	source: string;
	message: string;
}

/** Put rendered diagrams (or their source in a notice box) in place of their tokens. */
export function fillDiagrams(
	html: string,
	slots: DiagramSlot[],
	outcome: DiagramOutcome,
): { html: string; failures: DiagramFailure[] } {
	const failures: DiagramFailure[] = [];
	let out = html;
	slots.forEach((slot, index) => {
		let markup: string;
		if (outcome.status === "unavailable") {
			markup = failedBlock(slot.source, "Diagram not drawn: the diagram renderer wasn't available when this page was made.");
		} else {
			const result = outcome.diagrams[index];
			if (result?.ok) {
				markup = `<div class="lh-diagram">${result.svg}</div>`;
			} else {
				const message = result ? result.error : "No result from the diagram renderer";
				failures.push({ source: slot.source, message });
				markup = failedBlock(slot.source, "This diagram couldn't be rendered.");
			}
		}
		out = out.replace(slot.token, () => markup);
	});
	return { html: out, failures };
}

function failedInline(source: string, message: string): string {
	return `<code class="lh-failed-inline" title="${escapeHtml(`Couldn't be rendered: ${message}`)}">${escapeHtml(source)}</code>`;
}

/** Display math sits in paragraphs, so its box is phrasing content (spans). */
function failedDisplayMath(source: string, message: string): string {
	return `<span class="lh-failed" title="${escapeHtml(message)}"><span class="lh-failed-label">This formula couldn't be rendered.</span><code>${escapeHtml(source)}</code></span>`;
}

function failedBlock(source: string, label: string): string {
	return `<div class="lh-failed"><p class="lh-failed-label">${escapeHtml(label)}</p><pre>${escapeHtml(source)}</pre></div>`;
}
