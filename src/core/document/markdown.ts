import { toHtml } from "hast-util-to-html";
import rehypeKatex from "rehype-katex";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { transformMathDelimiters } from "../math-delims.ts";

/**
 * Teacher Markdown → HTML for conversation exports, read the way the chat
 * reads it (components/ai-elements/message.tsx): GFM, `$…$` and `$$…$$`
 * math with single-dollar text math, the legacy `\(…\)`/`\[…\]` reader,
 * remark-breaks line breaks, and KaTeX. Differences are deliberate and
 * stricter: raw HTML shows as literal text, images never load (the chat's
 * "[Image blocked: alt]" badge), links keep only web, mail and in-page
 * targets, and Mermaid fences become `<pre class="mermaid">` for the
 * document renderer. Code is not syntax-highlighted.
 */

type MdNode = { type: string; value?: string; alt?: string | null; children?: MdNode[] };
type HastNode = {
	type: string;
	tagName?: string;
	value?: string;
	properties?: Record<string, unknown>;
	children?: HastNode[];
};

/** Raw HTML is shown, never interpreted; images are reduced to their badge. */
function remarkLiteralHtml() {
	const visit = (node: MdNode) => {
		if (!node.children) return;
		node.children = node.children.map((child): MdNode => {
			if (child.type === "html") return { type: "text", value: child.value ?? "" };
			if (child.type === "image") return { type: "text", value: `[Image blocked: ${child.alt ?? ""}]` };
			visit(child);
			return child;
		});
	};
	return (tree: MdNode) => visit(tree);
}

const SAFE_LINK = /^(?:https?:|mailto:|#)/i;

function textOf(node: HastNode): string {
	if (node.type === "text") return node.value ?? "";
	return (node.children ?? []).map(textOf).join("");
}

/** Mermaid fences become the document renderer's diagram blocks; unsafe
 * link targets are dropped (the text stays). */
function rehypeDocument() {
	const visit = (node: HastNode) => {
		if (!node.children) return;
		node.children = node.children.map((child): HastNode => {
			if (child.type === "element" && child.tagName === "pre") {
				const code = child.children?.find((c) => c.type === "element" && c.tagName === "code");
				const classes = code?.properties?.className;
				if (code && Array.isArray(classes) && classes.includes("language-mermaid")) {
					return {
						type: "element",
						tagName: "pre",
						properties: { className: ["mermaid"] },
						children: [{ type: "text", value: textOf(code) }],
					};
				}
			}
			if (child.type === "element" && child.tagName === "a") {
				const href = child.properties?.href;
				if (typeof href !== "string" || !SAFE_LINK.test(href.trim())) {
					const { href: _dropped, ...rest } = child.properties ?? {};
					void _dropped;
					child.properties = rest;
				}
			}
			visit(child);
			return child;
		});
	};
	return (tree: HastNode) => visit(tree);
}

const processor = unified()
	.use(remarkParse)
	.use(remarkGfm)
	.use(remarkMath, { singleDollarTextMath: true })
	.use(remarkBreaks)
	.use(remarkLiteralHtml)
	.use(remarkRehype)
	.use(rehypeDocument)
	.use(rehypeKatex, { strict: "ignore" });

/** Render teacher Markdown as body HTML (math already rendered). */
export function markdownToHtml(markdown: string): string {
	const tree = processor.runSync(processor.parse(transformMathDelimiters(markdown)));
	return toHtml(tree as Parameters<typeof toHtml>[0]);
}
