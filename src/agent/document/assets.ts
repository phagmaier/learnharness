import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../../config.ts";
import type { DocumentAssets } from "../../core/document/template.ts";

/**
 * Read-only assets the document template inlines. They ship in the
 * standalone server through next.config.ts outputFileTracingIncludes.
 */

const KATEX_DIST = path.join(PATHS.root, "node_modules", "katex", "dist");

/** Rewrite each KaTeX `@font-face` to its woff2 face as a data URI; the
 * woff/ttf fallbacks are dropped (every supported browser reads woff2). */
export function inlineKatexFonts(css: string, readFont: (relativePath: string) => Buffer): string {
	return css.replace(/@font-face\s*\{[^}]*\}/g, (rule) => {
		const woff2 = /url\(\s*["']?(fonts\/[^)"']+\.woff2)["']?\s*\)/.exec(rule)?.[1];
		if (!woff2) return rule;
		const data = readFont(woff2).toString("base64");
		return rule.replace(/src\s*:[^;}]*/, `src:url(data:font/woff2;base64,${data}) format("woff2")`);
	});
}

/** The app's own faces (fonts/README.md), embedded so files look the same everywhere. */
const FONTS_DIR = path.join(PATHS.root, "src", "agent", "document", "fonts");

function fontFace(family: string, weight: string, file: string): string {
	const data = fs.readFileSync(path.join(FONTS_DIR, file)).toString("base64");
	return `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};font-display:block;src:url(data:font/woff2;base64,${data}) format("woff2")}`;
}

let cached: DocumentAssets | undefined;

export function documentAssets(): DocumentAssets {
	if (cached) return cached;
	const css = fs.readFileSync(path.join(KATEX_DIST, "katex.min.css"), "utf8");
	cached = {
		katexCss: inlineKatexFonts(css, (relativePath) => fs.readFileSync(path.join(KATEX_DIST, relativePath))),
		textFontCss: [
			fontFace("Source Sans 3", "200 900", "source-sans-3-latin.woff2"),
			fontFace("CMU Serif", "700", "cmu-serif-bold.woff2"),
		].join("\n"),
		codeFontCss: fontFace("JetBrains Mono", "100 800", "jetbrains-mono-latin.woff2"),
	};
	return cached;
}
