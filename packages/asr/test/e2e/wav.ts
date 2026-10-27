/**
 * Minimal canonical-PCM WAV reader for the end-to-end fixture.
 *
 * Only what the fixture needs: RIFF/WAVE, a 16-bit PCM `fmt ` chunk and a
 * `data` chunk. Anything else is an error rather than a guess, so a corrupted
 * or re-encoded fixture fails loudly instead of feeding the service garbage.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface WavInfo {
	sampleRate: number;
	channels: number;
	samples: Int16Array;
}

export function readWav(path: string): WavInfo {
	const buffer = readFileSync(path);
	if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
		throw new Error(`${path}: not a RIFF/WAVE file`);
	}

	let offset = 12;
	let sampleRate = 0;
	let channels = 0;
	while (offset + 8 <= buffer.length) {
		const id = buffer.toString("ascii", offset, offset + 4);
		const size = buffer.readUInt32LE(offset + 4);
		const body = offset + 8;
		if (id === "fmt ") {
			const format = buffer.readUInt16LE(body);
			channels = buffer.readUInt16LE(body + 2);
			sampleRate = buffer.readUInt32LE(body + 4);
			const bitsPerSample = buffer.readUInt16LE(body + 14);
			if (format !== 1 || bitsPerSample !== 16) {
				throw new Error(`${path}: expected 16-bit PCM, got format ${String(format)}`);
			}
		} else if (id === "data") {
			if (sampleRate !== 16_000 || channels !== 1) {
				throw new Error(`${path}: expected 16 kHz mono, got ${String(sampleRate)} Hz/${String(channels)}`);
			}
			const copy = new Uint8Array(buffer.subarray(body, body + size));
			return { sampleRate, channels, samples: new Int16Array(copy.buffer) };
		}
		offset = body + size + (size % 2);
	}
	throw new Error(`${path}: no data chunk`);
}

export function fixturePcm(name: string): Int16Array {
	return readWav(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))).samples;
}
