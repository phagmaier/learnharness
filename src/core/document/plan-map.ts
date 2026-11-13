import type { PlanBlockData } from "../contracts/chat.ts";
import {
	ARROW_HEAD, blockLayout, edgePathD, GRAPH_PAD, HEAD_H, HEAD_W, LINE_H, NODE_H, NODE_W_MIN, STROKE_W,
	TEXT_CAP_SCALE, wrapTitle,
} from "../plan-layout.ts";
import { escapeHtml } from "./html.ts";

/**
 * A presented plan as static SVG for conversation exports: the chat's
 * in-transcript plan block (components/plan-block.tsx PlanDiagram,
 * monochrome) drawn with the same layout, padding, width cap and arrowhead,
 * in the document's light ink. Snapshot statuses are not shown, as in the
 * chat block.
 */

const INK = "#23221f";
const SURFACE = "#f5f3ed";
/** The app's text-xs, the size plan titles render at in the chat. */
const NODE_FONT_SIZE = 11;

export function planMapSvg(block: PlanBlockData, markerId: string): string {
	const { nodes, edges } = block;
	const layout = blockLayout(nodes, edges);
	const pad = GRAPH_PAD;
	const w = Math.max(layout.width, 1);
	const h = Math.max(layout.height, 1);
	const vbW = w + 2 * pad;
	const vbH = h + 2 * pad;
	const ox = layout.originX ?? 0;
	const oy = layout.originY ?? 0;
	const maxWidth = Math.round(vbW * TEXT_CAP_SCALE * 100) / 100;

	const paths = edges.flatMap((edge) => {
		const points = layout.edgePts.get(`${edge.from}->${edge.to}`);
		if (!points) return [];
		const tx = layout.x.get(edge.to);
		const ty = layout.y.get(edge.to);
		const target = tx !== undefined && ty !== undefined
			? { x: tx, y: ty, w: layout.nodeW.get(edge.to) ?? NODE_W_MIN, h: layout.nodeH.get(edge.to) ?? NODE_H }
			: undefined;
		return [`<path d="${edgePathD(points, target)}" fill="none" stroke="${INK}" stroke-width="${STROKE_W}" marker-end="url(#${markerId})"/>`];
	});

	const groups = nodes.map((node) => {
		const lines = wrapTitle(node.title);
		const nodeH = layout.nodeH.get(node.id) ?? NODE_H;
		const nodeW = layout.nodeW.get(node.id) ?? NODE_W_MIN;
		const y0 = (nodeH - lines.length * LINE_H) / 2 + 10;
		const texts = lines.map((line, i) =>
			`<text x="${nodeW / 2}" y="${y0 + i * LINE_H}" text-anchor="middle" fill="${INK}" font-size="${NODE_FONT_SIZE}">${escapeHtml(line)}</text>`);
		return `<g transform="translate(${layout.x.get(node.id) ?? 0}, ${layout.y.get(node.id) ?? 0})" data-node="${escapeHtml(node.id)}">`
			+ `<rect width="${nodeW}" height="${nodeH}" fill="${SURFACE}" stroke="${INK}" stroke-width="${STROKE_W}"/>${texts.join("")}</g>`;
	});

	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${ox - pad} ${oy - pad} ${vbW} ${vbH}" role="img" aria-label="Plan diagram"`
		+ ` style="font-family:var(--lh-font-text);max-width:${maxWidth}px">`
		+ `<defs><marker id="${markerId}" viewBox="0 0 50.2 104" refX="27.2" refY="52" markerWidth="${HEAD_W}" markerHeight="${HEAD_H}"`
		+ ` markerUnits="userSpaceOnUse" orient="auto"><path d="${ARROW_HEAD}" fill="${INK}"/></marker></defs>`
		+ paths.join("") + groups.join("") + "</svg>";
}
