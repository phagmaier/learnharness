import { escapeHtml } from "./html.ts";
import { DOCUMENT_STYLESHEET } from "./stylesheet.ts";

/**
 * The fixed page every note and conversation export is written into. The
 * file is final and self-contained: styles, fonts and rendered math are
 * inline, and nothing loads from the network. A note's own policy says so
 * (inert without scripts; an interactive note's scripts run offline), so it
 * holds in any browser. Exports that embed demos carry no policy: a demo
 * frame inherits its parent's.
 */

export interface DocumentAssets {
	/** KaTeX's stylesheet with its fonts inlined; added only to pages with math. */
	katexCss: string;
	/** `@font-face` rules for the text and title faces ("" = system fonts). */
	textFontCss: string;
	/** `@font-face` rules for the code face ("" = system fonts); added only to pages with code. */
	codeFontCss: string;
}

export interface DocumentPage {
	title: string;
	/** One muted line under the title (session, date, instruction). */
	subtitle?: string;
	/** Prepared body HTML (see body.ts). */
	body: string;
	/** True when the body carries its own scripts (an interactive note). */
	scripted?: boolean;
	/** One trusted app script, appended after the body. */
	appScript?: string;
}

/** Inert pages: inline styles, data: images and fonts, nothing else. */
export const INERT_PAGE_POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";
/** Interactive notes: their own inline scripts run, with no network access. */
export const SCRIPTED_PAGE_POLICY = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:";

export function pageHasMath(body: string): boolean {
	return /class="katex[\s"]/.test(body);
}

export function pageHasCode(body: string): boolean {
	return /<(?:code|pre|kbd|samp)[\s>]/i.test(body);
}

export function renderDocument(page: DocumentPage, assets: DocumentAssets): string {
	const styles = [
		assets.textFontCss,
		pageHasCode(page.body) ? assets.codeFontCss : "",
		pageHasMath(page.body) ? assets.katexCss : "",
		DOCUMENT_STYLESHEET,
	].filter(Boolean).join("\n");
	const framed = Boolean(page.appScript) || /<iframe[\s>]/i.test(page.body);
	const policy = framed ? null : page.scripted ? SCRIPTED_PAGE_POLICY : INERT_PAGE_POLICY;
	const title = escapeHtml(page.title);
	return [
		"<!doctype html>",
		'<html lang="en">',
		"<head>",
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		'<meta name="color-scheme" content="light">',
		...(policy ? [`<meta http-equiv="Content-Security-Policy" content="${policy}">`] : []),
		`<title>${title}</title>`,
		`<style>${styles}</style>`,
		"</head>",
		"<body>",
		'<article class="lh-doc">',
		'<header class="lh-doc-header">',
		`<h1 class="lh-doc-title">${title}</h1>`,
		...(page.subtitle ? [`<p class="lh-doc-subtitle">${escapeHtml(page.subtitle)}</p>`] : []),
		"</header>",
		`<div class="lh-doc-body">\n${page.body}\n</div>`,
		"</article>",
		...(page.appScript ? [`<script>${page.appScript}</script>`] : []),
		"</body>",
		"</html>",
		"",
	].join("\n");
}
