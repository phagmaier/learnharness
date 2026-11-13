import { fillDiagrams, prepareDocumentBody, type DiagramFailure, type DiagramOutcome } from "../../core/document/body.ts";
import type { MathFailure } from "../../core/document/math.ts";
import { DOCUMENT_FONTS } from "../../core/document/stylesheet.ts";
import { renderDocument, type DocumentAssets, type DocumentPage } from "../../core/document/template.ts";
import { getHeadless } from "../subagents/headless.ts";
import { documentAssets } from "./assets.ts";

/**
 * Body HTML → the final self-contained file: math rendered with KaTeX,
 * Mermaid drawn by the browser helper, everything wrapped in the fixed
 * template. Failures are returned (for the note writer's fix loop) and also
 * shown in the file as source boxes, so the file is always complete.
 */

export interface DocumentFileResult {
	html: string;
	mathFailures: MathFailure[];
	diagramFailures: DiagramFailure[];
	/** "unavailable": the helper could not start; each diagram shows its source. */
	diagrams: "none" | "rendered" | "unavailable";
	unavailableReason?: string;
}

export async function renderDocumentFile(
	page: DocumentPage,
	options: { assets?: DocumentAssets } = {},
): Promise<DocumentFileResult> {
	const assets = options.assets ?? documentAssets();
	const prepared = prepareDocumentBody(page.body);
	let outcome: DiagramOutcome = { status: "rendered", diagrams: [] };
	let unavailableReason: string | undefined;
	if (prepared.diagrams.length > 0) {
		const result = await getHeadless()
			.renderMermaid(prepared.diagrams.map((slot) => slot.source), {
				fontFamily: DOCUMENT_FONTS.text,
				fontCss: assets.textFontCss,
			})
			.catch((error: unknown) => ({
				status: "unavailable" as const,
				reason: error instanceof Error ? error.message : String(error),
			}));
		outcome = result;
		if (result.status === "unavailable") unavailableReason = result.reason;
	}
	const filled = fillDiagrams(prepared.html, prepared.diagrams, outcome);
	return {
		html: renderDocument({ ...page, body: filled.html }, assets),
		mathFailures: prepared.mathFailures,
		diagramFailures: filled.failures,
		diagrams: prepared.diagrams.length === 0 ? "none" : outcome.status,
		...(unavailableReason !== undefined ? { unavailableReason } : {}),
	};
}
