// ============================================================================
// Glyph sheet — dev-only review surface for the icon set.
//
// Served by the Vite dev server at /glyphs.html. It is not part of the build:
// Vite's default entry is index.html, and this page is never listed as an input,
// so `dist/web` never carries it. Its job is the one thing no gate can check —
// whether the glyphs read as one set — by putting every export at every legal
// slot on one screen, then putting each in the control boxes it will occupy.
//
// What to look for, in order:
//   1. Weight. A row should look uniform; a mark that reads heavier or lighter
//      than its neighbours is a stroke or live-area bug, not taste.
//   2. Optical size. The 12px cells are where a mark that fills the 12×12 live
//      area versus one that floats inside it is obvious.
//   3. In-box padding. The ladder strip is the answer to "how much blank
//      surrounds it": every box should leave the glyph looking centred, not
//      merely geometrically centred.
//
// The set is enumerated from the module's own exports, so a new glyph appears
// here without an edit — and a glyph that looks wrong *here* is what a user
// would otherwise find on a screen.
// ============================================================================

import { type ComponentType, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../app/index.css";
import * as glyphs from "../render/icons.tsx";
import styles from "./glyphs.module.css";

type GlyphProps = { size?: 12 | 14 | 16 | 20; className?: string };
type GlyphComponent = ComponentType<GlyphProps>;

const SLOTS = [12, 14, 16, 20] as const;
const BOXES = [24, 28, 32, 36] as const;

const entries = Object.entries(glyphs).filter(([name]) => name.endsWith("Icon")) as [string, GlyphComponent][];

function Section({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
	return (
		<section className={styles.section}>
			<h2 className={styles.title}>{title}</h2>
			<p className={styles.note}>{note}</p>
			{children}
		</section>
	);
}

function Sheet() {
	return (
		<div className={styles.page}>
			<header className={styles.header}>
				<h1 className={styles.heading}>Glyph sheet</h1>
				<p className={styles.note}>
					{entries.length} glyphs, four slots, four boxes. Dev-only — served at <code>/glyphs.html</code>, never
					built into <code>dist/web</code>.
				</p>
			</header>

			<Section
				title="Every glyph at every slot"
				note="Each cell is exactly the slot's square, so a mark that overflows or under-fills its live area shows as a clipped or shrunken glyph. Read across a row for weight, down a column for optical size."
			>
				<table className={styles.table}>
					<thead>
						<tr>
							<th className={styles.nameHead}>glyph</th>
							{SLOTS.map((slot) => (
								<th key={slot} className={styles.cellHead}>
									{slot}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{entries.map(([name, Glyph]) => (
							<tr key={name}>
								<td className={styles.name}>{name}</td>
								{SLOTS.map((slot) => (
									<td key={slot} className={styles.cell}>
										<span className={styles.slotBox} style={{ width: slot, height: slot }}>
											<Glyph size={slot} />
										</span>
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</Section>

			<Section
				title="Variants"
				note="States that change the drawing rather than the ink: the fold caret's three directions, the pin's filled form. A variant that reads as a different symbol means it should be a second export instead."
			>
				<div className={styles.variantRow}>
					<div className={styles.variant}>
						<glyphs.CaretIcon direction="right" size={16} />
						<span className={styles.variantLabel}>Caret right</span>
					</div>
					<div className={styles.variant}>
						<glyphs.CaretIcon direction="diagonal" size={16} />
						<span className={styles.variantLabel}>Caret diagonal</span>
					</div>
					<div className={styles.variant}>
						<glyphs.CaretIcon direction="down" size={16} />
						<span className={styles.variantLabel}>Caret down</span>
					</div>
					<div className={styles.variant}>
						<glyphs.PinIcon size={16} />
						<span className={styles.variantLabel}>Pin</span>
					</div>
					<div className={styles.variant}>
						<glyphs.PinIcon size={16} filled />
						<span className={styles.variantLabel}>Pin filled</span>
					</div>
				</div>
			</Section>

			<Section
				title="In the box ladder"
				note="Each glyph at the 14 slot inside the boxes it actually occupies. This is the padding check: the ink sits inside a 12×12 live area, so a 24 box leaves 6px of blank on each side and a 36 box leaves 12. If one looks off-centre here, its art is off-centre on the grid."
			>
				{BOXES.map((box) => (
					<div key={box} className={styles.boxRow}>
						<span className={styles.boxLabel}>{box}</span>
						{entries.map(([name, Glyph]) => (
							<span key={name} className={styles.control} style={{ width: box, height: box }}>
								<Glyph size={14} />
							</span>
						))}
					</div>
				))}
			</Section>
		</div>
	);
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<Sheet />
	</StrictMode>,
);
