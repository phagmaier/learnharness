/**
 * Plan 03 item 1: the shared document template and its renderers (notes and
 * conversation exports). Deterministic: Mermaid goes through the
 * headlessOverride fake; KaTeX and linkedom run for real. Results are read
 * back by parsing the produced HTML, not by comparing against KaTeX's own
 * markup.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { prepareDocumentBody } from "../src/core/document/body.ts";
import { figureImageSrc, learnerImageSrc } from "../src/core/document/figures.ts";
import { splitMath } from "../src/core/document/math.ts";
import { DOCUMENT_STYLESHEET } from "../src/core/document/stylesheet.ts";
import { INERT_PAGE_POLICY, renderDocument, SCRIPTED_PAGE_POLICY, type DocumentAssets } from "../src/core/document/template.ts";
import { LEARNER_IMAGE_HREF } from "../src/core/learner-image-svg.ts";
import { documentAssets, inlineKatexFonts } from "../src/agent/document/assets.ts";
import { renderDocumentFile } from "../src/agent/document/render.ts";
import {
	headlessOverride,
	type HeadlessApi,
	type MermaidRenderResult,
	type RenderMermaidOptions,
} from "../src/agent/subagents/headless.ts";

const ASSETS: DocumentAssets = {
	katexCss: "/*katex-assets*/",
	textFontCss: "/*text-font*/",
	codeFontCss: "/*code-font*/",
};

function body(html: string) {
	const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
	return document.body;
}

/** The TeX each rendered formula carries in its MathML annotation. */
function renderedTex(html: string): string[] {
	return Array.from(body(html).querySelectorAll('annotation[encoding="application/x-tex"]')).map((node) =>
		(node.textContent ?? "").trim(),
	);
}

function fakeMermaid(
	render: (sources: string[], opts?: RenderMermaidOptions) => Promise<MermaidRenderResult>,
): HeadlessApi & { calls: Array<{ sources: string[]; opts?: RenderMermaidOptions }> } {
	const calls: Array<{ sources: string[]; opts?: RenderMermaidOptions }> = [];
	return {
		calls,
		available: () => true,
		unavailableReason: () => null,
		runDemo: async () => { throw new Error("unexpected demo run"); },
		renderSvg: async () => { throw new Error("unexpected svg render"); },
		renderPdfPages: async () => { throw new Error("unexpected pdf render"); },
		renderMermaid: async (sources, opts) => {
			calls.push({ sources, opts });
			return render(sources, opts);
		},
	};
}

afterEach(() => {
	headlessOverride.current = undefined;
});

describe("document template", () => {
	it("adds KaTeX's assets only to pages with math, and the code font only to pages with code", async () => {
		const plain = renderDocument({ title: "T", body: "<p>No formulas here, just $5 and $10.</p>" }, ASSETS);
		assert.ok(!plain.includes("/*katex-assets*/"));
		assert.ok(!plain.includes("/*code-font*/"));
		assert.ok(plain.includes("/*text-font*/"));

		const math = await renderDocumentFile({ title: "T", body: "<p>Let \\(x^2\\) be given.</p>" }, { assets: ASSETS });
		assert.ok(math.html.includes("/*katex-assets*/"));
		assert.ok(!math.html.includes("/*code-font*/"));

		const code = renderDocument({ title: "T", body: "<pre><code>x = 1</code></pre>" }, ASSETS);
		assert.ok(code.includes("/*code-font*/"));
		assert.ok(!code.includes("/*katex-assets*/"));
	});

	it("keeps a plain page inert: no script, and a policy that forbids scripts and network loads", async () => {
		const { html } = await renderDocumentFile({ title: "T", body: "<h2>A</h2><p>Text \\(a\\).</p>" }, { assets: ASSETS });
		assert.ok(!/<script/i.test(html));
		const { document } = parseHTML(html);
		const policy = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
		assert.equal(policy?.getAttribute("content"), INERT_PAGE_POLICY);
		assert.match(INERT_PAGE_POLICY, /default-src 'none'/);
		assert.ok(!/script-src/.test(INERT_PAGE_POLICY));
		assert.equal(document.querySelector('meta[name="color-scheme"]')?.getAttribute("content"), "light");
	});

	it("lets an interactive note run its own scripts offline, and drops the policy only for framed exports", () => {
		const scripted = renderDocument({ title: "T", body: "<script>1</script>", scripted: true }, ASSETS);
		assert.ok(scripted.includes(`content="${SCRIPTED_PAGE_POLICY}"`));
		assert.match(SCRIPTED_PAGE_POLICY, /default-src 'none'/);
		assert.match(SCRIPTED_PAGE_POLICY, /script-src 'unsafe-inline'/);
		assert.ok(!/connect-src|https?:/.test(SCRIPTED_PAGE_POLICY));
		const framed = renderDocument({ title: "T", body: '<iframe sandbox="allow-scripts" srcdoc="x"></iframe>' }, ASSETS);
		assert.ok(!framed.includes("Content-Security-Policy"));
		const withApp = renderDocument({ title: "T", body: "<p>x</p>", appScript: "window.x=1" }, ASSETS);
		assert.ok(!withApp.includes("Content-Security-Policy"));
		assert.ok(withApp.includes("<script>window.x=1</script>"));
	});

	it("escapes the title and subtitle", () => {
		const html = renderDocument({ title: `<b>Sets & "maps"</b>`, subtitle: "Notes from <i>x</i> · 13 Nov", body: "<p>x</p>" }, ASSETS);
		const { document } = parseHTML(html);
		assert.equal(document.querySelector("title")?.textContent, `<b>Sets & "maps"</b>`);
		assert.equal(document.querySelector(".lh-doc-title")?.textContent, `<b>Sets & "maps"</b>`);
		assert.equal(document.querySelector(".lh-doc-title b"), null);
		assert.equal(document.querySelector(".lh-doc-subtitle")?.textContent, "Notes from <i>x</i> · 13 Nov");
		assert.equal(document.querySelector(".lh-doc-subtitle i"), null);
	});

	it("omits the subtitle line when there is none", () => {
		const html = renderDocument({ title: "T", body: "<p>x</p>" }, ASSETS);
		assert.equal(parseHTML(html).document.querySelector(".lh-doc-subtitle"), null);
	});
});

describe("math in document bodies", () => {
	it("renders inline and display formulas with KaTeX", () => {
		const { html, mathFailures } = prepareDocumentBody(
			"<p>Inline \\(x^2 + 1\\) and display:</p><p>\\[ \\frac{a}{b} \\]</p>",
		);
		assert.deepEqual(mathFailures, []);
		assert.deepEqual(renderedTex(html), ["x^2 + 1", "\\frac{a}{b}"]);
		const root = body(html);
		assert.equal(root.querySelectorAll(".katex-display").length, 1);
		assert.ok(!html.includes("\\("));
		assert.ok(!html.includes("\\["));
	});

	it("reads entity-decoded text, so a formula can contain < written as &lt;", () => {
		const { html, mathFailures } = prepareDocumentBody("<p>\\(a &lt; b\\)</p>");
		assert.deepEqual(mathFailures, []);
		assert.deepEqual(renderedTex(html), ["a < b"]);
	});

	it("keeps a TeX line break inside display math as part of one formula", () => {
		const { html, mathFailures } = prepareDocumentBody("<p>\\[ \\begin{matrix} a \\\\ b \\end{matrix} \\]</p>");
		assert.deepEqual(mathFailures, []);
		assert.deepEqual(renderedTex(html), ["\\begin{matrix} a \\\\ b \\end{matrix}"]);
	});

	it("leaves code, SVG, scripts, styles, text areas and Mermaid sources literal", () => {
		const { html } = prepareDocumentBody([
			"<pre>\\(pre\\)</pre>",
			"<p><code>\\(code\\)</code></p>",
			'<svg viewBox="0 0 10 10"><text>\\(svg\\)</text></svg>',
			"<script>var s = '\\\\(script\\\\)';</script>",
			"<style>/* \\(style\\) */</style>",
			"<textarea>\\(area\\)</textarea>",
		].join(""));
		assert.deepEqual(renderedTex(html), []);
		for (const literal of ["\\(pre\\)", "\\(code\\)", "\\(svg\\)", "\\(style\\)", "\\(area\\)"]) {
			assert.ok(html.includes(literal), literal);
		}
		const mermaid = prepareDocumentBody('<pre class="mermaid">graph LR\nA["\\(m\\)"] --> B</pre>');
		assert.equal(mermaid.diagrams[0]?.source, 'graph LR\nA["\\(m\\)"] --> B');
	});

	it("never treats dollars as math", () => {
		const { html, mathFailures } = prepareDocumentBody("<p>It costs $5, or $$10 for two; $x$ stays text.</p>");
		assert.deepEqual(mathFailures, []);
		assert.equal(body(html).textContent, "It costs $5, or $$10 for two; $x$ stays text.");
	});

	it("reports each failed formula with KaTeX's message and shows its source", () => {
		const { html, mathFailures } = prepareDocumentBody(
			"<p>Good \\(y\\), bad \\(\\nosuchcommand{x}\\), and</p><p>\\[ \\begin{matrix} a \\end{pmatrix} \\]</p><p>open \\(z + 1</p>",
		);
		assert.deepEqual(mathFailures.map(({ source, display }) => ({ source, display })), [
			{ source: "\\(\\nosuchcommand{x}\\)", display: false },
			{ source: "\\[ \\begin{matrix} a \\end{pmatrix} \\]", display: true },
			{ source: "\\(z + 1", display: false },
		]);
		assert.match(mathFailures[0]!.message, /Undefined control sequence/);
		assert.match(mathFailures[1]!.message, /KaTeX parse error/);
		assert.equal(mathFailures[2]!.message, "No closing \\)");
		assert.deepEqual(renderedTex(html), ["y"]);
		const root = body(html);
		assert.deepEqual(
			Array.from(root.querySelectorAll(".lh-failed-inline")).map((node) => node.textContent),
			["\\(\\nosuchcommand{x}\\)", "\\(z + 1"],
		);
		assert.equal(root.querySelector(".lh-failed code")?.textContent, "\\[ \\begin{matrix} a \\end{pmatrix} \\]");
	});

	it("splits text at delimiters, reading backslash pairs as one unit", () => {
		assert.deepEqual(splitMath("a \\\\(b\\\\) c"), [{ kind: "text", text: "a \\\\(b\\\\) c" }]);
		assert.deepEqual(splitMath("\\(x\\)!"), [
			{ kind: "math", tex: "x", display: false, source: "\\(x\\)" },
			{ kind: "text", text: "!" },
		]);
	});
});

describe("links in document bodies", () => {
	it("opens web links outside the page and leaves in-page anchors alone", () => {
		const { html } = prepareDocumentBody('<p><a href="https://example.com/x">web</a> <a href="#part-2">below</a></p>');
		const [web, anchor] = Array.from(body(html).querySelectorAll("a"));
		assert.equal(web?.getAttribute("target"), "_blank");
		assert.equal(web?.getAttribute("rel"), "noopener");
		assert.equal(anchor?.getAttribute("target"), null);
		assert.equal(anchor?.getAttribute("rel"), null);
	});
});

describe("Mermaid in documents", () => {
	const DIAGRAMS = '<p>First:</p><pre class="mermaid">graph LR\n  A--&gt;B</pre><p>Second:</p><div class="mermaid">graph TD; C</div>';

	it("draws each diagram through the browser helper, in order, with the page's text font", async () => {
		const fake = fakeMermaid(async (sources) => ({
			status: "rendered",
			diagrams: sources.map((_, i) => ({ ok: true as const, svg: `<svg data-fake="${i}"></svg>` })),
		}));
		headlessOverride.current = fake;
		const result = await renderDocumentFile({ title: "T", body: DIAGRAMS }, { assets: ASSETS });
		assert.equal(fake.calls.length, 1);
		assert.deepEqual(fake.calls[0]!.sources, ["graph LR\n  A-->B", "graph TD; C"]);
		assert.match(fake.calls[0]!.opts?.fontFamily ?? "", /^"Source Sans 3"/);
		assert.equal(fake.calls[0]!.opts?.fontCss, "/*text-font*/");
		assert.equal(result.diagrams, "rendered");
		assert.deepEqual(result.diagramFailures, []);
		const { document } = parseHTML(result.html);
		assert.deepEqual(
			Array.from(document.querySelectorAll(".lh-diagram svg")).map((svg) => svg.getAttribute("data-fake")),
			["0", "1"],
		);
		assert.equal(document.querySelector(".mermaid"), null);
	});

	it("reports a diagram that fails and shows its source, while the others render", async () => {
		headlessOverride.current = fakeMermaid(async () => ({
			status: "rendered",
			diagrams: [{ ok: false, error: "Parse error on line 2" }, { ok: true, svg: "<svg data-ok></svg>" }],
		}));
		const result = await renderDocumentFile({ title: "T", body: DIAGRAMS }, { assets: ASSETS });
		assert.deepEqual(result.diagramFailures, [{ source: "graph LR\n  A-->B", message: "Parse error on line 2" }]);
		const { document } = parseHTML(result.html);
		assert.equal(document.querySelector(".lh-failed pre")?.textContent, "graph LR\n  A-->B");
		assert.equal(document.querySelectorAll(".lh-diagram svg[data-ok]").length, 1);
	});

	it("shows every diagram's source with a notice when the helper is unavailable, without failing", async () => {
		headlessOverride.current = fakeMermaid(async () => ({ status: "unavailable", reason: "no browser" }));
		const result = await renderDocumentFile({ title: "T", body: DIAGRAMS }, { assets: ASSETS });
		assert.equal(result.diagrams, "unavailable");
		assert.equal(result.unavailableReason, "no browser");
		assert.deepEqual(result.diagramFailures, []);
		const { document } = parseHTML(result.html);
		const boxes = Array.from(document.querySelectorAll(".lh-failed"));
		assert.equal(boxes.length, 2);
		assert.deepEqual(boxes.map((box) => box.querySelector("pre")?.textContent), ["graph LR\n  A-->B", "graph TD; C"]);
		assert.match(boxes[0]!.querySelector(".lh-failed-label")?.textContent ?? "", /wasn't available/);
	});

	it("treats a helper that throws as unavailable", async () => {
		headlessOverride.current = fakeMermaid(async () => { throw new Error("helper crashed"); });
		const result = await renderDocumentFile({ title: "T", body: DIAGRAMS }, { assets: ASSETS });
		assert.equal(result.diagrams, "unavailable");
		assert.equal(result.unavailableReason, "helper crashed");
	});

	it("never calls the helper for a page without diagrams", async () => {
		const fake = fakeMermaid(async () => { throw new Error("should not be called"); });
		headlessOverride.current = fake;
		const result = await renderDocumentFile({ title: "T", body: "<p>None.</p>" }, { assets: ASSETS });
		assert.equal(fake.calls.length, 0);
		assert.equal(result.diagrams, "none");
	});
});

describe("figures in documents", () => {
	const decode = (src: string) => {
		const prefix = "data:image/svg+xml;base64,";
		assert.ok(src.startsWith(prefix));
		return Buffer.from(src.slice(prefix.length), "base64").toString("utf8");
	};

	it("turns a plain figure into an SVG image, with the chat's namespace repair", () => {
		const svg = decode(figureImageSrc('<svg width="10" height="10"><circle r="4"/></svg>'));
		assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="10"/);
		assert.ok(svg.includes('<circle r="4"/>'));
	});

	it("embeds the learner image an annotation draws on", () => {
		const image = { mimeType: "image/png" as const, data: "iVBORw0KGgo=", width: 4, height: 3 };
		const svg = decode(figureImageSrc(
			`<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"><image href="${LEARNER_IMAGE_HREF}" width="4" height="3"/></svg>`,
			image,
		));
		assert.ok(svg.includes('<image href="data:image/png;base64,iVBORw0KGgo="'));
		assert.ok(!svg.includes(`href="${LEARNER_IMAGE_HREF}"`));
	});

	it("turns a learner image into a data URI of its own type", () => {
		assert.equal(learnerImageSrc({ mimeType: "image/jpeg", data: "/9j/4A==", width: 1, height: 1 }), "data:image/jpeg;base64,/9j/4A==");
	});
});

describe("document assets", () => {
	it("inlines KaTeX's woff2 faces and drops the woff/ttf fallbacks", () => {
		const css = '.katex{font:1em KaTeX_Main}@font-face{font-family:KaTeX_AMS;src:url(fonts/KaTeX_AMS-Regular.woff2) format("woff2"),url(fonts/KaTeX_AMS-Regular.woff) format("woff")}@font-face{font-family:KaTeX_Main;font-weight:700;src:url(fonts/KaTeX_Main-Bold.woff2) format("woff2"),url(fonts/KaTeX_Main-Bold.ttf) format("truetype")}';
		const read: string[] = [];
		const out = inlineKatexFonts(css, (file) => {
			read.push(file);
			return Buffer.from(file);
		});
		assert.deepEqual(read, ["fonts/KaTeX_AMS-Regular.woff2", "fonts/KaTeX_Main-Bold.woff2"]);
		assert.ok(out.startsWith(".katex{font:1em KaTeX_Main}"));
		assert.ok(out.includes(`src:url(data:font/woff2;base64,${Buffer.from("fonts/KaTeX_AMS-Regular.woff2").toString("base64")}) format("woff2")}`));
		assert.ok(out.includes("font-weight:700;src:url(data:font/woff2;base64,"));
		assert.ok(!/\.woff\)|\.ttf\)/.test(out));
	});

	it("loads the installed KaTeX stylesheet with every face self-contained", () => {
		const { katexCss } = documentAssets();
		const faces = katexCss.match(/@font-face\s*\{[^}]*\}/g) ?? [];
		assert.ok(faces.length >= 20, `found ${faces.length} faces`);
		for (const face of faces) assert.match(face, /src:url\(data:font\/woff2;base64,[A-Za-z0-9+/=]+\) format\("woff2"\)/);
		assert.ok(!katexCss.includes("url(fonts/"));
	});

	it("embeds the app's text, title and code faces under the families the stylesheet names", () => {
		const { textFontCss, codeFontCss } = documentAssets();
		const families = (css: string) =>
			(css.match(/@font-face\{[^}]*\}/g) ?? []).map((face) => {
				assert.match(face, /src:url\(data:font\/woff2;base64,[A-Za-z0-9+/=]{1000,}\) format\("woff2"\)/);
				return /font-family:"([^"]+)"/.exec(face)?.[1];
			});
		assert.deepEqual(families(textFontCss), ["Source Sans 3", "CMU Serif"]);
		assert.deepEqual(families(codeFontCss), ["JetBrains Mono"]);
		for (const family of ["Source Sans 3", "CMU Serif", "JetBrains Mono"]) {
			assert.ok(DOCUMENT_STYLESHEET.includes(`"${family}"`), family);
		}
	});
});
