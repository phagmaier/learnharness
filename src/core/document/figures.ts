import type { ImageSnapshot } from "../contracts/chat.ts";
import { embedLearnerImage } from "../learner-image-svg.ts";
import { svgImageSource } from "../../../lib/svg-image-source.ts";

/**
 * Figures in documents (notes and exports) stay images, as in the chat: a
 * figure's SVG never joins the page's DOM, so its styles and ids cannot
 * collide with the page. The learner image an annotation draws on is
 * embedded first, then the chat's two display repairs apply.
 */
export function figureImageSrc(svg: string, learnerImage?: ImageSnapshot): string {
	const embedded = learnerImage ? embedLearnerImage(svg, learnerImage) : svg;
	return `data:image/svg+xml;base64,${Buffer.from(svgImageSource(embedded), "utf8").toString("base64")}`;
}

/** A learner image (PNG or JPEG snapshot) as a data URI. */
export function learnerImageSrc(image: ImageSnapshot): string {
	return `data:${image.mimeType};base64,${image.data}`;
}
