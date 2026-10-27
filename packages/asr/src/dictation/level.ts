/**
 * Level metering for the dictation affordance.
 *
 * These samples are the ones the browser already processed — the `audio`
 * constraints apply AEC/NS/AGC before the worklet — so this is a *presence*
 * indicator, not a sound-pressure meter: it shows what the ASR is about to see.
 * Two consequences drive the design:
 *
 * - Noise suppression removes the room floor, so "the room is audible" is not
 *   observable here. Sample arrival is the liveness fact (`control.ts`); the
 *   level is not.
 * - AGC compresses dynamic range, so thresholds do not transfer between
 *   devices. The defaults are a starting point, not a calibration, and
 *   `speaking` uses hysteresis so a bar sitting at the threshold cannot flicker.
 *
 * Pure arithmetic: no DOM, no clock, no timers. `nowMs` comes from the caller so
 * the attack/release envelope is deterministic under test.
 */

export interface LevelOptions {
	/** dBFS that reads as 0; quieter input clamps. */
	floorDb?: number;
	/** Time constant while the level rises, in ms. Short: the bar must feel live. */
	attackMs?: number;
	/** Time constant while it falls, in ms. Long: speech stays visible between syllables. */
	releaseMs?: number;
	/** Smoothed level at which `speaking` turns on. */
	speakAbove?: number;
	/** Smoothed level at which it turns off. Lower than `speakAbove`. */
	speakBelow?: number;
}

export interface LevelReading {
	/** 0..1, smoothed. */
	level: number;
	/** Hysteresis-cleared "somebody is talking" flag. */
	speaking: boolean;
}

/** -Infinity from silence is clamped here so every conversion stays finite. */
const MIN_DB = -100;

const DEFAULTS = {
	floorDb: -60,
	attackMs: 60,
	releaseMs: 300,
	speakAbove: 0.45,
	speakBelow: 0.25,
} as const;

export class LevelMeter {
	private readonly floorDb: number;
	private readonly attackMs: number;
	private readonly releaseMs: number;
	private readonly speakAbove: number;
	private readonly speakBelow: number;

	private smoothed = 0;
	private lastAt: number | undefined;
	private isSpeaking = false;

	constructor(options: LevelOptions = {}) {
		this.floorDb = options.floorDb ?? DEFAULTS.floorDb;
		this.attackMs = options.attackMs ?? DEFAULTS.attackMs;
		this.releaseMs = options.releaseMs ?? DEFAULTS.releaseMs;
		this.speakAbove = options.speakAbove ?? DEFAULTS.speakAbove;
		this.speakBelow = options.speakBelow ?? DEFAULTS.speakBelow;
	}

	get reading(): LevelReading {
		return { level: this.smoothed, speaking: this.isSpeaking };
	}

	/** Feed one batch of 16 kHz mono PCM; `nowMs` is a monotonic wall clock. */
	push(pcm: Int16Array, nowMs: number): LevelReading {
		const target = this.normalize(rms(pcm));

		const elapsed = this.lastAt === undefined ? 0 : Math.max(0, nowMs - this.lastAt);
		this.lastAt = nowMs;

		if (elapsed === 0) {
			// First sample (or a repeated timestamp): start at the measurement instead
			// of ramping up from zero, which would read as silence on the first frame.
			this.smoothed = target;
		} else {
			const tau = target > this.smoothed ? this.attackMs : this.releaseMs;
			const alpha = tau <= 0 ? 1 : 1 - Math.exp(-elapsed / tau);
			this.smoothed += (target - this.smoothed) * alpha;
		}

		if (this.isSpeaking) {
			if (this.smoothed <= this.speakBelow) this.isSpeaking = false;
		} else if (this.smoothed >= this.speakAbove) {
			this.isSpeaking = true;
		}

		return this.reading;
	}

	reset(): void {
		this.smoothed = 0;
		this.isSpeaking = false;
		this.lastAt = undefined;
	}

	private normalize(amplitude: number): number {
		if (amplitude <= 0) return 0;
		const db = Math.max(MIN_DB, 20 * Math.log10(amplitude));
		if (db <= this.floorDb) return 0;
		return Math.min(1, (db - this.floorDb) / -this.floorDb);
	}
}

/** Root mean square of full-scale-normalized samples (0..1). */
function rms(pcm: Int16Array): number {
	if (pcm.length === 0) return 0;
	let sum = 0;
	for (const sample of pcm) {
		const normalized = sample / 32_768;
		sum += normalized * normalized;
	}
	return Math.sqrt(sum / pcm.length);
}
