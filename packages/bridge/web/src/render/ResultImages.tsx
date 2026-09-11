// ResultImages — image attachments from a tool result, rendered inline.
//
// Tool results can carry ImageContent blocks (base64 + mimeType) alongside
// text. Rendered as data-URI <img> elements: SVG via <img> is safe (no
// script execution in image context). Placed by each tool body inside its
// cardBody panel. Own module (ResizeHandle precedent) — render/ components
// don't reach into feature CSS modules.

import { memo } from "react";
import type { ImageContent } from "../../../src/core/types.ts";
import styles from "./ResultImages.module.css";

export const ResultImages = memo(function ResultImages({ images }: { images: ImageContent[] }) {
	if (images.length === 0) return null;
	return (
		<div className={styles.images}>
			{images.map((img, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: static block list, no stable id
				<img key={i} className={styles.image} src={`data:${img.mimeType};base64,${img.data}`} alt="" />
			))}
		</div>
	);
});
