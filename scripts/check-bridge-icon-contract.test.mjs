// Tests for the icon and control contract gate (scripts/check-bridge-icon-contract.mjs).
//
// Each case builds a fixture tree whose `render/icons.tsx` is a copy of the real
// icon set, so the classification table stays in step with the repository, and
// then adds one feature file holding the violation under test.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./check-bridge-icon-contract.mjs", import.meta.url));
const realIconSet = fileURLToPath(new URL("../packages/bridge/web/src/render/icons.tsx", import.meta.url));

async function fixture(t, files) {
	const root = await mkdtemp(join(tmpdir(), "pi-icon-contract-"));
	t.after(() => rm(root, { recursive: true, force: true }));

	const src = join(root, "packages", "bridge", "web", "src");
	await mkdir(join(src, "render"), { recursive: true });
	await mkdir(join(src, "features", "demo"), { recursive: true });
	await cp(realIconSet, join(src, "render", "icons.tsx"));
	for (const [path, content] of Object.entries(files)) {
		await writeFile(join(src, path), content);
	}
	return root;
}

function check(root) {
	return spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
}

test("accepts a feature that imports the glyph set", async (t) => {
	const root = await fixture(t, {
		"features/demo/Demo.tsx": [
			'import { ArrowUpIcon, CopyIcon } from "../../render/icons.tsx";',
			"export const Demo = () => (",
			"\t<>",
			'\t\t<CopyIcon size={14} />',
			"\t\t<ArrowUpIcon />",
			'\t\t<span>HEAD → working tree</span>',
			"\t</>",
			");",
		].join("\n"),
	});
	const result = check(root);
	assert.equal(result.status, 0, result.stderr);
});

test("rejects an inline <svg> outside the glyph set", async (t) => {
	const root = await fixture(t, {
		"features/demo/Demo.tsx": 'export const Demo = () => <svg viewBox="0 0 16 16" />;',
	});
	const result = check(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /inline <svg> outside render\/icons\.tsx/);
});

test("rejects a geometric character standing in for an icon", async (t) => {
	const root = await fixture(t, {
		"features/demo/Demo.tsx": "export const Demo = () => <button>▾</button>;",
	});
	const result = check(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /font glyph standing in for an icon/);
});

test("rejects an emoji in the document", async (t) => {
	const root = await fixture(t, {
		"features/demo/Demo.tsx": 'export const Demo = () => <span>{"📎"}</span>;',
	});
	const result = check(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /emoji .* in the document/);
});

test("accepts data characters that are not icons", async (t) => {
	const root = await fixture(t, {
		"features/demo/Demo.tsx": [
			"export const Demo = () => (",
			"\t<>",
			"\t\t<span>Index → Working tree</span>",
			"\t\t<span>6×8</span>",
			"\t\t<span>…</span>",
			"\t</>",
			");",
		].join("\n"),
	});
	const result = check(root);
	assert.equal(result.status, 0, result.stderr);
});

test("rejects a solid object mark at the 16 slot", async (t) => {
	const root = await fixture(t, {
		"features/demo/Demo.tsx": [
			'import { CopyIcon } from "../../render/icons.tsx";',
			"export const Demo = () => <CopyIcon size={16} />;",
		].join("\n"),
	});
	const result = check(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /<CopyIcon> is a solid mark and may only render at slot 12\/14 \(got 16\)/);
});

test("rejects a transport solid anywhere but 16", async (t) => {
	const root = await fixture(t, {
		"features/demo/Demo.tsx": [
			'import { StopIcon } from "../../render/icons.tsx";',
			"export const Demo = () => <StopIcon size={14} />;",
		].join("\n"),
	});
	const result = check(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /<StopIcon> is a solid mark and may only render at slot 16 \(got 14\)/);
});

test("rejects an unclassified export", async (t) => {
	const root = await fixture(t, {
		"render/icons.tsx": [
			'export const CopyIcon = () => null;',
			'export const SparkleIcon = () => null;',
		].join("\n"),
	});
	const result = check(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /"SparkleIcon" is exported but unclassified/);
	assert.match(result.stderr, /"ArrowUpIcon" is listed as a solid mark but is no longer exported/);
});

test("rejects a button that composes no tier", async (t) => {
	const root = await fixture(t, {
		"features/demo/Demo.module.css": ".plain {\n\tpadding: 0;\n}\n",
		"features/demo/Demo.tsx": [
			'import styles from "./Demo.module.css";',
			"export const Demo = () => <button type=\"button\" className={styles.plain}>Go</button>;",
		].join("\n"),
	});
	const result = check(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /composes no tier/);
});

test("accepts a button that composes the ghost tier", async (t) => {
	const root = await fixture(t, {
		"render/buttons.module.css": ".ghost {\n\tpadding: 0;\n}\n",
		"features/demo/Demo.module.css": ".go {\n\tcomposes: ghost from \"../../render/buttons.module.css\";\n}\n",
		"features/demo/Demo.tsx": [
			'import styles from "./Demo.module.css";',
			"export const Demo = () => <button type=\"button\" className={styles.go}>Go</button>;",
		].join("\n"),
	});
	const result = check(root);
	assert.equal(result.status, 0, result.stderr);
});
