import { parseHTML } from "linkedom";
import { escapeHtml } from "./html.ts";

/**
 * The note writer's body rules (fork plan 03 item 3). Every problem goes
 * back to the model as text it can act on. A plain note is static: no
 * script, no style element, no event handlers, no javascript: URLs. An
 * interactive note may script itself. Neither may load anything from
 * outside the page; only `<a href>` may point to the web.
 */

export const MAX_NOTE_BODY_BYTES = 500 * 1024;

const PAGE_ELEMENTS = ["html", "head", "body", "base", "meta", "link"];
const EMBEDDING_ELEMENTS = ["iframe", "object", "embed"];
const REFUSED_TAG = new RegExp(`<\\s*/?\\s*(${[...PAGE_ELEMENTS, ...EMBEDDING_ELEMENTS].join("|")})(?=[\\s/>])`, "gi");
const EXTERNAL = /^\s*(?:https?:|\/\/|file:)/i;
const CSS_EXTERNAL = /url\(\s*["']?\s*(?:https?:|\/\/|file:)|@import\b/i;
const RESOURCE_ATTRIBUTES = new Set(["src", "srcset", "poster", "data", "background", "action", "formaction", "href", "xlink:href"]);

type Element = {
	localName: string;
	attributes: ArrayLike<{ name: string; value: string }>;
	textContent: string | null;
	querySelectorAll(selector: string): ArrayLike<Element>;
};

function resourceUrls(name: string, value: string): string[] {
	if (name === "srcset") return value.split(",").map((candidate) => candidate.trim().split(/\s+/)[0] ?? "").filter(Boolean);
	return [value];
}

export function noteBodyProblems(
	body: string,
	options: { interactive: boolean; figureIds: ReadonlySet<string> },
): string[] {
	const problems = new Set<string>();
	if (Buffer.byteLength(body, "utf8") > MAX_NOTE_BODY_BYTES) {
		problems.add(`The body is over ${MAX_NOTE_BODY_BYTES / 1024} KB. Make the note shorter.`);
	}
	for (const match of body.matchAll(REFUSED_TAG)) {
		const tag = match[1]!.toLowerCase();
		problems.add(PAGE_ELEMENTS.includes(tag)
			? `<${tag}> isn't allowed: write only the body's content; the app supplies the page around it.`
			: `<${tag}> isn't allowed: notes can't embed other pages or plugins.`);
	}

	const { document } = parseHTML(`<!doctype html><html><head></head><body>${body}</body></html>`);
	const root = document.body as unknown as Element;
	if (!(root.textContent ?? "").trim() && root.querySelectorAll("img, svg, figure").length === 0) {
		problems.add("The body is empty. Write the note's content.");
	}

	for (const element of Array.from(root.querySelectorAll("*"))) {
		const tag = element.localName.toLowerCase();
		if (!options.interactive && (tag === "script" || tag === "style")) {
			problems.add(`<${tag}> is only allowed in an interactive note. Use inline style attributes for layout.`);
		}
		if (tag === "style" && CSS_EXTERNAL.test(element.textContent ?? "")) {
			problems.add("A <style> element loads something from outside the page (url(…) or @import). Everything must be self-contained.");
		}
		for (const { name, value } of Array.from(element.attributes)) {
			const attribute = name.toLowerCase();
			if (!options.interactive && attribute.startsWith("on")) {
				problems.add(`Event-handler attributes such as ${attribute} are only allowed in an interactive note.`);
			}
			if (!options.interactive && /^\s*javascript:/i.test(value)) {
				problems.add("javascript: URLs are only allowed in an interactive note.");
			}
			if (attribute === "style" && CSS_EXTERNAL.test(value)) {
				problems.add(`A style attribute loads something from outside the page: "${value.slice(0, 120)}". Everything must be self-contained.`);
			}
			if (RESOURCE_ATTRIBUTES.has(attribute) && !(tag === "a" && (attribute === "href" || attribute === "xlink:href"))) {
				for (const url of resourceUrls(attribute, value)) {
					if (EXTERNAL.test(url)) {
						problems.add(`External resource "${url.slice(0, 200)}" in <${tag} ${attribute}>: everything must be self-contained (inline SVG or data: URIs). Only <a href> may link to the web.`);
					}
				}
			}
			if (attribute === "data-figure" && !options.figureIds.has(value.trim())) {
				const listed = [...options.figureIds].join(", ") || "none";
				problems.add(`data-figure="${value}" names no figure from the session. Listed figures: ${listed}.`);
			}
		}
	}
	return [...problems];
}

/** Put each session figure into the element that names it, as its first child. */
export function insertFigures(body: string, figures: ReadonlyMap<string, { src: string; alt: string }>): string {
	if (!/data-figure/i.test(body)) return body;
	const { document } = parseHTML(`<!doctype html><html><head></head><body>${body}</body></html>`);
	for (const element of Array.from(document.body.querySelectorAll("[data-figure]"))) {
		const figure = figures.get((element.getAttribute("data-figure") ?? "").trim());
		if (!figure) continue;
		const holder = document.createElement("template");
		holder.innerHTML = `<img src="${escapeHtml(figure.src)}" alt="${escapeHtml(figure.alt)}">`;
		element.insertBefore(holder.content.firstChild!, element.firstChild);
	}
	return document.body.innerHTML;
}
