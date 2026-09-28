import type { SpeechChunk, WordTiming } from "./types";

/**
 * Spreading a real duration across the words of a sentence.
 *
 * Engines that write audio to a file tell us exactly how long the audio is but
 * not when each word lands. Proportional allocation is crude but it is stable,
 * cheap, and far better than nothing. Weighting by syllable count rather than
 * character count tracks real speech duration noticeably better, because
 * "strengths" takes about as long as "cat".
 */

const VOWEL_GROUP = /[aeiouy]+/gi;

/** Rough duration weight for a single word. */
function weightOf(word: string): number {
	const clean = word.replace(/[^\p{L}\p{N}'’-]/gu, "");
	if (clean === "") return 0.5;
	const syllables = clean.match(VOWEL_GROUP)?.length ?? 1;
	const letters = clean.length;
	// Each syllable costs time; consonants add a little on top. The constant
	// stops very short words like "a" or "I" collapsing to near-zero width.
	return syllables * 1.0 + Math.min(letters, 12) * 0.06 + 0.45;
}

export interface WordSpan {
	word: string;
	start: number;
	end: number;
}

/** Locate the words in a chunk, with chunk-local character offsets. */
export function findWords(text: string): WordSpan[] {
	const spans: WordSpan[] = [];
	const re = /[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		spans.push({ word: m[0], start: m.index, end: m.index + m[0].length });
	}
	return spans;
}

/**
 * Distribute `durationMs` across the words of `chunk`.
 *
 * Character offsets come straight from the text; millisecond offsets are
 * apportioned by syllable weight. Both are filled in here so every engine
 * hands the player the same shape, whatever it actually knows.
 */
export function allocateWordTimings(
	chunk: SpeechChunk,
	durationMs: number,
	rate = 1,
): WordTiming[] {
	const spans = findWords(chunk.text);
	if (spans.length === 0) return [];

	const weights = spans.map((s) => weightOf(s.word));
	const total = weights.reduce((a, b) => a + b, 0);
	if (total <= 0) return [];

	// Engines pad the clip with a little silence; the visual word should not
	// begin on the very first sample.
	const lead = Math.min(40 * rate, durationMs * 0.06);
	const usable = Math.max(0, durationMs - lead * 2);

	const timings: WordTiming[] = [];
	let cursor = lead;

	for (let i = 0; i < spans.length; i++) {
		const span = spans[i]!;
		const share = (weights[i]! / total) * usable;
		const offsetMs = cursor;
		const isLast = i === spans.length - 1;
		const endMs = isLast ? lead + usable : cursor + share;
		cursor = endMs;

		const sourceStart = chunk.sourceIndex[span.start] ?? chunk.sourceStart;
		const sourceEndRaw = chunk.sourceIndex[span.end - 1];

		timings.push({
			start: span.start,
			end: span.end,
			sourceStart,
			sourceEnd: sourceEndRaw !== undefined ? sourceEndRaw + 1 : span.end,
			offsetMs,
			durationMs: Math.max(0, endMs - offsetMs),
		});
	}

	return timings;
}

/**
 * Find the word active at `offsetMs`, or -1.
 *
 * Binary search: this runs on every animation frame while audio plays.
 * Returns the last word whose start has passed, so a highlight holds steady
 * through the gap between words instead of flickering off.
 */
export function wordAt(timings: readonly WordTiming[], offsetMs: number): number {
	let lo = 0;
	let hi = timings.length - 1;
	let active = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (offsetMs < timings[mid]!.offsetMs) {
			hi = mid - 1;
		} else {
			active = mid;
			lo = mid + 1;
		}
	}
	return active;
}
