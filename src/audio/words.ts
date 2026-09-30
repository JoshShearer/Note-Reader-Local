import type { SpeechChunk, WordSpan, WordTiming } from "./types";

export type { WordSpan } from "./types";

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

/**
 * A code point that is its own spoken syllable.
 *
 * `scx` and not `Script`: U+30FC, the katakana prolonged sound mark in コーヒー,
 * is Script=Common but Script_Extensions=Hiragana,Katakana, so the plain
 * `Script` form would miss it.
 */
const CJK_SYLLABLE = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}]/gu;

/** Rough duration weight for a single word. */
function weightOf(word: string): number {
	const clean = word.replace(/[^\p{L}\p{N}'’-]/gu, "");
	if (clean === "") return 0.5;
	/*
	 * ASCII is byte-identical to the pre-NRL-47 form: `cjk` is 0 there, and the
	 * old `?? 1` only fired when the vowel match was null, which is exactly
	 * when `(0 + 0) || 1` gives 1. Latin, Cyrillic, Greek and Arabic all weigh
	 * what they always weighed - `VOWEL_GROUP` is ASCII-only, so the last three
	 * scored 1 syllable before and score 1 now.
	 *
	 * The CJK term is what makes the new spans usable rather than merely
	 * numerous: without it a 1-unit Han span weighed 1.51 and a 3-unit one
	 * 1.63, a 1.08x ratio against a true ratio near 3, so the highlight would
	 * still have drifted inside a sentence. With it they weigh 1.51 and 3.63,
	 * a 2.40x ratio (arithmetic on the formula below, not a measurement).
	 */
	const vowels = clean.match(VOWEL_GROUP)?.length ?? 0;
	const cjk = clean.match(CJK_SYLLABLE)?.length ?? 0;
	const syllables = (vowels + cjk) || 1;
	const letters = clean.length;
	// Each syllable costs time; consonants add a little on top. The constant
	// stops very short words like "a" or "I" collapsing to near-zero width.
	return syllables * 1.0 + Math.min(letters, 12) * 0.06 + 0.45;
}

/**
 * Does this text hold a Han, Kana or Hangul code point? Exported because
 * extract.ts needs the same answer to decide whether segmenting a chunk for
 * word spans is worth anything at all, and one definition of "CJK" is better
 * than two.
 *
 * Those three scripts and no others, which is narrower than "writes no
 * inter-word space". Thai, Lao, Khmer, Myanmar and Tibetan write no spaces
 * either and get nothing here; `สวัสดีครับ` keeps whatever the regex alone
 * makes of it, which is not good, but it is what it was before NRL-47 and
 * widening this predicate without fixture evidence for those scripts would be
 * a guess.
 *
 * A fresh non-global regex rather than `CJK_SYLLABLE`: that one is global and
 * carries `lastIndex`, so reusing it here would make the answer depend on call
 * order.
 */
const RE_HAS_CJK = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}]/u;

export function hasCjkScript(text: string): boolean {
	return RE_HAS_CJK.test(text);
}

/**
 * Locate the words in a chunk, with chunk-local UTF-16 offsets.
 *
 * `cuts` are extra boundaries a segmenter found, sorted. They never replace the
 * regex: a regex span is only ever SUBDIVIDED, and only when it holds a Han,
 * Kana or Hangul code point. That is what makes Latin, Cyrillic, Greek and
 * Arabic spans identical by construction rather than by hope.
 *
 * Replacing the regex with `Intl.Segmenter` was the obvious alternative and is
 * wrong. Measured on node v24.21.0, ICU segments
 * `well-known U.S.A. e.g. dont’t over.` as well/-/known/U.S.A/./e.g/./dont’t/
 * over/. where this regex gives well-known/U.S.A./e.g./dont’t/over. - it splits
 * hyphenated compounds and drops the trailing period the regex keeps. ICU's
 * word-like set is neither a superset nor a subset of the regex's, so any
 * mapping between them would move English spans. See ADR 0014.
 *
 * A cut that would open a sub-span holding no letter or digit is dropped, so
 * the piece stays attached to the syllable before it. Measured: ICU puts a word
 * boundary before the final `.` of `안녕하세요세계반갑습니다.`, which the regex
 * had kept inside the span, and without this the chunk gained a thirteenth span
 * that was nothing but a full stop. `weightOf` would have given it 0.5 and the
 * highlight would have flashed on a period.
 */
const RE_WORD_CHAR = /[\p{L}\p{N}]/u;

export function findWords(text: string, cuts?: readonly number[]): WordSpan[] {
	const spans: WordSpan[] = [];
	const re = /[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const start = m.index;
		const end = m.index + m[0].length;
		if (!cuts || cuts.length === 0 || !hasCjkScript(m[0])) {
			spans.push({ word: m[0], start, end });
			continue;
		}
		const first = spans.length;
		let at = start;
		for (const cut of cuts) {
			if (cut <= at) continue;
			if (cut >= end) break;
			spans.push({ word: text.slice(at, cut), start: at, end: cut });
			at = cut;
		}
		spans.push({ word: text.slice(at, end), start: at, end });
		// Fold word-less pieces backwards. The first piece can never be one:
		// the regex span begins with `[\p{L}\p{N}]` by construction, so there
		// is always a predecessor to fold into.
		for (let i = spans.length - 1; i > first; i--) {
			if (RE_WORD_CHAR.test(spans[i]!.word)) continue;
			const prev = spans[i - 1]!;
			prev.end = spans[i]!.end;
			prev.word = text.slice(prev.start, prev.end);
			spans.splice(i, 1);
		}
	}
	return spans;
}

/**
 * Re-base spans onto `text.slice(textStart, textEnd)`.
 *
 * The read-selection path in main.ts re-slices a chunk's `text` and
 * `sourceIndex` and rebuilds it with a spread, so a `wordSpans` array would
 * survive the spread while still indexing the unclipped text. Every span past
 * the clip point would then be off by `textStart`, `allocateWordTimings` would
 * read the wrong `sourceIndex` entries, and the highlight would land on the
 * wrong characters - a non-negotiable 8 violation.
 *
 * `text` is the chunk's text BEFORE clipping, so each surviving span's `word`
 * can be re-sliced from it at its clamped bounds.
 */
export function clipWordSpans(
	spans: readonly WordSpan[],
	text: string,
	textStart: number,
	textEnd: number,
): WordSpan[] {
	const out: WordSpan[] = [];
	for (const span of spans) {
		const start = Math.max(span.start, textStart);
		const end = Math.min(span.end, textEnd);
		if (end <= start) continue;
		out.push({ word: text.slice(start, end), start: start - textStart, end: end - textStart });
	}
	return out;
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
	// `wordSpans` is the segmenter-subdivided list when extractChunks computed
	// one; absent means the regex alone is right for this chunk (ADR 0014).
	const spans = chunk.wordSpans ?? findWords(chunk.text);
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
