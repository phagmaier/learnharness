import katex from "katex";

/**
 * TeX in document bodies: notes are HTML, and the note writer marks math as
 * `\( … \)` inline and `\[ … \]` display. `$` is never a delimiter here, so
 * prices and shell prompts stay literal. Rendering happens once, on the
 * server: a stored file needs no script to show its math.
 */

export interface MathFailure {
	/** The formula as written, delimiters included. */
	source: string;
	display: boolean;
	/** KaTeX's message, or why the formula could not be read. */
	message: string;
}

export type MathSegment =
	| { kind: "text"; text: string }
	| { kind: "math"; tex: string; display: boolean; source: string }
	| { kind: "unclosed"; source: string; display: boolean };

/** Split text at `\(…\)` and `\[…\]`. A backslash pair is always read as one
 * unit, so `\\` (a TeX line break) never opens or closes a formula. */
export function splitMath(text: string): MathSegment[] {
	const segments: MathSegment[] = [];
	let buffer = "";
	const flush = () => {
		if (buffer) segments.push({ kind: "text", text: buffer });
		buffer = "";
	};
	let i = 0;
	while (i < text.length) {
		if (text[i] !== "\\" || i + 1 >= text.length) {
			buffer += text[i];
			i++;
			continue;
		}
		const next = text[i + 1];
		if (next !== "(" && next !== "[") {
			buffer += text.slice(i, i + 2);
			i += 2;
			continue;
		}
		const close = next === "(" ? ")" : "]";
		let end = -1;
		for (let j = i + 2; j < text.length; j++) {
			if (text[j] !== "\\") continue;
			if (text[j + 1] === close) {
				end = j;
				break;
			}
			j++; // skip the escaped character
		}
		flush();
		const display = next === "[";
		if (end === -1) {
			segments.push({ kind: "unclosed", source: text.slice(i), display });
			return segments;
		}
		segments.push({ kind: "math", tex: text.slice(i + 2, end), display, source: text.slice(i, end + 2) });
		i = end + 2;
	}
	flush();
	return segments;
}

/** Render one formula; failures carry KaTeX's own message. */
export function renderTex(tex: string, display: boolean): { ok: true; html: string } | { ok: false; message: string } {
	try {
		return {
			ok: true,
			html: katex.renderToString(tex, { displayMode: display, throwOnError: true, strict: "ignore", trust: false }),
		};
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}
}
