/** Hand-built PDFs for the pdf-markdown tests: every run is placed Helvetica text, so each test
 * states the exact page layout it means (positions, sizes, stream order, hidden scanner text). */
export interface Run {
	text: string;
	x: number;
	y: number;
	size?: number;
	/** Render mode 3: the hidden text layer a scanner lays over its page image. */
	invisible?: boolean;
	/** Turned 90°, like an arXiv margin stamp. */
	rotated?: boolean;
}

export interface TinyPage {
	runs?: Run[];
	/** A full-page picture: ordinary XObject, stencil mask, or inline bitmap. */
	image?: boolean | "mask" | "inline";
}

const WIDTH = 612;
const HEIGHT = 792;
// WinAnsiEncoding bytes for the punctuation the tests use.
const WIN_ANSI: Record<string, number> = { "•": 0x95, "–": 0x96, "—": 0x97, "’": 0x92 };

function pdfString(text: string): string {
	let out = "";
	for (const ch of text) {
		const code = WIN_ANSI[ch] ?? ch.charCodeAt(0);
		if (code > 0xff) throw new Error(`tiny-pdf cannot encode ${ch}`);
		out += ch === "(" || ch === ")" || ch === "\\" ? `\\${ch}` : String.fromCharCode(code);
	}
	return `(${out})`;
}

function content(page: TinyPage): string {
	const ops: string[] = [];
	if (page.image === "inline") ops.push(`q ${WIDTH} 0 0 ${HEIGHT} 0 0 cm BI /W 2 /H 2 /CS /G /BPC 8 ID \x80\x40\x40\x80 EI Q`);
	else if (page.image) ops.push(`q ${WIDTH} 0 0 ${HEIGHT} 0 0 cm /${page.image === "mask" ? "Mask" : "Im1"} Do Q`);
	for (const run of page.runs ?? []) {
		const matrix = run.rotated ? `0 1 -1 0 ${run.x} ${run.y}` : `1 0 0 1 ${run.x} ${run.y}`;
		ops.push(`BT /F1 ${run.size ?? 10} Tf ${run.invisible ? 3 : 0} Tr ${matrix} Tm ${pdfString(run.text)} Tj ET`);
	}
	return ops.join("\n");
}

// "~" maps to U+0014, a control character real fonts emit for stretchy math glyphs (math-for-ml).
const TO_UNICODE = "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Tiny def /CMapType 2 def\n"
	+ "1 begincodespacerange <00> <FF> endcodespacerange\n1 beginbfchar <7E> <0014> endbfchar\n"
	+ "endcmap CMapName currentdict /CMap defineresource pop end end";

/** A bookmark: its title, the 1-based page it points at, and its children. */
export interface TinyBookmark {
	title: string;
	page: number;
	children?: TinyBookmark[];
}

/** Optional document parts for the book importer's tests (fork plan 05). */
export interface TinyPdfOptions {
	bookmarks?: TinyBookmark[];
	/** Page label ranges: from a 0-based page index, decimal (D) or lower roman (r). */
	pageLabels?: { start: number; style: "D" | "r"; first?: number }[];
	info?: { title?: string; author?: string };
}

export function tinyPdf(pages: readonly TinyPage[], options: TinyPdfOptions = {}): Uint8Array<ArrayBuffer> {
	const objects: string[] = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${6 + i * 2} 0 R`).join(" ")}] >>`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode 5 0 R >>",
		"<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\x80\nendstream",
		`<< /Length ${TO_UNICODE.length} >>\nstream\n${TO_UNICODE}\nendstream`,
	];
	const maskId = 6 + pages.length * 2;
	for (const [i, page] of pages.entries()) {
		const stream = content(page);
		objects.push(
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${WIDTH} ${HEIGHT}] /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 4 0 R /Mask ${maskId} 0 R >> >> /Contents ${7 + i * 2} 0 R >>`,
			`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
		);
	}
	// Two distinct stencil rows avoid pdfjs's solid-color-mask fast path.
	objects.push("<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ImageMask true /BitsPerComponent 1 /Length 2 >>\nstream\n\x80\x40\nendstream");
	const pageRef = (page: number) => `${6 + (page - 1) * 2} 0 R`;
	let catalogExtra = "";
	if (options.bookmarks?.length) {
		const rootId = objects.length + 1;
		objects.push("");
		const place = (items: TinyBookmark[], parent: number): { first: number; last: number; count: number } => {
			const ids = items.map(() => { objects.push(""); return objects.length; });
			let count = 0;
			items.forEach((item, k) => {
				const kids = item.children?.length ? place(item.children, ids[k]!) : null;
				count += 1 + (kids?.count ?? 0);
				objects[ids[k]! - 1] = `<< /Title ${pdfString(item.title)} /Parent ${parent} 0 R`
					+ (k > 0 ? ` /Prev ${ids[k - 1]} 0 R` : "") + (k < items.length - 1 ? ` /Next ${ids[k + 1]} 0 R` : "")
					+ (kids ? ` /First ${kids.first} 0 R /Last ${kids.last} 0 R /Count ${kids.count}` : "")
					+ ` /Dest [${pageRef(item.page)} /XYZ null null null] >>`;
			});
			return { first: ids[0]!, last: ids.at(-1)!, count };
		};
		const top = place(options.bookmarks, rootId);
		objects[rootId - 1] = `<< /Type /Outlines /First ${top.first} 0 R /Last ${top.last} 0 R /Count ${top.count} >>`;
		catalogExtra += ` /Outlines ${rootId} 0 R`;
	}
	if (options.pageLabels?.length) {
		catalogExtra += ` /PageLabels << /Nums [${options.pageLabels.map((range) => `${range.start} << /S /${range.style}${range.first ? ` /St ${range.first}` : ""} >>`).join(" ")}] >>`;
	}
	objects[0] = `<< /Type /Catalog /Pages 2 0 R${catalogExtra} >>`;
	let infoId: number | null = null;
	if (options.info) {
		objects.push(`<< ${options.info.title ? `/Title ${pdfString(options.info.title)}` : ""} ${options.info.author ? `/Author ${pdfString(options.info.author)}` : ""} >>`);
		infoId = objects.length;
	}
	let pdf = "%PDF-1.4\n";
	const offsets: number[] = [];
	for (const [i, body] of objects.entries()) {
		offsets.push(pdf.length);
		pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
	}
	const xref = pdf.length;
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${infoId ? ` /Info ${infoId} 0 R` : ""} >>\nstartxref\n${xref}\n%%EOF\n`;
	return Uint8Array.from(pdf, (ch) => ch.charCodeAt(0));
}
