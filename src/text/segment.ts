/**
 * Unicode segmentation, with an offline fallback.
 *
 * `Intl.Segmenter` is the only thing in the platform that knows a Chinese
 * sentence ends at `。`, that an Arabic one can end at `؟`, or that a flag is
 * one grapheme and not two. It is also the only piece of this pipeline we do
 * not control, so it is reached through an injected `SegmenterSource` rather
 * than touched directly: availability on the Obsidian WebView is a runtime
 * question, and a test that has to delete a global to exercise the other
 * branch is a test that can leak into its neighbours.
 *
 * Nothing here imports anything. That is deliberate for the same reason
 * `src/ui/affordances.ts` is pure - bare-Node tests drive it directly - and
 * because a node builtin reaching this file would break mobile (see AGENTS.md
 * non-negotiable 7).
 *
 * Every offset in and out of this module is a UTF-16 code unit index into the
 * string it was given, because that is what `SpeechChunk.sourceIndex` is.
 */

/**
 * Where segmenters come from.
 *
 * Each method returns `undefined` when the platform cannot supply one, which
 * is not an error: R-M10 lets segmentation fall back to safe-sized chunks.
 */
export interface SegmenterSource {
	sentence(locale: string): Intl.Segmenter | undefined;
	grapheme(): Intl.Segmenter | undefined;
	word(locale: string): Intl.Segmenter | undefined;
}

/**
 * A sentence boundary, and whether the legacy regex was the thing that found
 * it.
 *
 * The flag is load-bearing rather than diagnostic. `mergeShort` folds short
 * pieces together, and it may only erase a boundary the old code would also
 * have produced; erasing an ICU-only one would fold every CJK sentence back
 * into the single chunk this whole change exists to break up.
 */
export interface SentenceBoundary {
	/** Offset of the first code unit of the sentence that starts here. */
	at: number;
	legacy: boolean;
}

/**
 * The sentence rule this module replaces, moved here unchanged.
 *
 * An ASCII terminator followed by whitespace. It is kept and still consulted
 * on the native path, because ICU does not merely add boundaries to English -
 * it removes far more than it adds. Measured on this V8 over 4,000 generated
 * English fixtures: ICU declines 15,523 boundaries this regex produces (it
 * will not break after "e.g.", after "..." or after "U.S.A.") and supplies
 * 1,803 this regex lacks. Replacing the regex would therefore have moved
 * English text, dominantly toward longer chunks. A union moves text with an
 * ASCII terminator not at all - but that is the guard below doing the work,
 * not ICU being conservative: of those 1,803, the guard admitted 0.
 */
export function legacySentenceBoundaries(text: string): number[] {
	const out: number[] = [];
	const re = /[.!?…]+["')\]]*\s+/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		out.push(m.index + m[0].length);
	}
	return out;
}

/**
 * What may sit between a sentence terminator and the boundary after it.
 *
 * Whitespace, plus the Unicode form of the legacy regex's own closer class.
 * Tested one UTF-16 unit at a time, which is safe here: every `Pf` and `Pe`
 * code point is in the BMP, and a surrogate matches neither, so an astral
 * character stops the walk on its low surrogate - itself above U+0080, which
 * is the answer the caller wants anyway.
 */
const RE_TRAILING_CLOSER = /[\s\p{Pf}\p{Pe}]/u;

/** Offsets a segmenter reports, minus the 0 every segmenter starts with. */
function segmenterBoundaries(seg: Intl.Segmenter, text: string): number[] {
	const out: number[] = [];
	for (const piece of seg.segment(text)) {
		if (piece.index > 0) out.push(piece.index);
	}
	return out;
}

/**
 * Sentence boundaries: the union of the legacy regex and ICU, sorted, with a
 * boundary found by both marked `legacy`.
 *
 * An ICU-only boundary is accepted only when the *terminator* before it is
 * outside ASCII. That guard is not decoration. ICU splits
 * `[!note] Callout body` after the `!`, where the regex - which requires
 * whitespace after a terminator - does not, and that shape is a real Obsidian
 * callout marker, so without the guard an English note gains a one-character
 * chunk. Requiring the terminator to be at or above U+0080 admits every
 * boundary this change exists for (`。`, `？`, `！`, `؟`, `۔`) and by
 * construction can admit none where the terminator is ASCII, where the regex
 * remains the whole rule.
 *
 * Reaching the terminator takes two walks, not one, and both are load-bearing.
 * Whitespace, because ICU counts the space after a terminator as part of the
 * sentence it closes. And a closing or final punctuation mark, because the
 * legacy regex already allows a run of closers after its terminator
 * (`["')\]]*`) and that class is ASCII-only: without the second walk
 * `He said "stop." Then` breaks and `He said “stop.” Then` - the same prose
 * after Obsidian's smart punctuation - gained an ICU-only boundary the regex
 * could not see, which `mergeShort` then refused to fold. Measured against
 * the merge base: `“First.” “Second.” “Third.” Tail text here now.` became
 * four utterances of 8, 9, 8 and 19 units where the straight-quoted form is
 * one of 47. `\p{Pf}` and `\p{Pe}` are the Unicode spelling of that same
 * closer class, so CJK is untouched - `」`, `》` and `）` are skipped over
 * only to land on the `。` underneath them, which is what admits the boundary.
 */
export function sentenceBoundaries(text: string, locale: string, src: SegmenterSource): SentenceBoundary[] {
	const legacy = new Set(legacySentenceBoundaries(text));
	const seg = src.sentence(locale);
	const all = new Set(legacy);
	if (seg) {
		for (const at of segmenterBoundaries(seg, text)) {
			let back = at - 1;
			while (back >= 0 && RE_TRAILING_CLOSER.test(text[back]!)) back -= 1;
			// charCodeAt, not codePointAt: a low surrogate is itself above
			// U+0080, so the astral case needs no special handling.
			if (back >= 0 && text.charCodeAt(back) >= 0x80) all.add(at);
		}
	}
	return [...all].sort((a, b) => a - b).map((at) => ({ at, legacy: legacy.has(at) }));
}

/** Grapheme cluster starts, from ICU when it exists and from UAX 29 when not. */
export function graphemeBoundaries(text: string, src: SegmenterSource): number[] {
	const seg = src.grapheme();
	return seg ? segmenterBoundaries(seg, text) : uax29GraphemeBoundaries(text);
}

/**
 * Word starts, or an empty list when there is no word segmenter.
 *
 * There is no offline fallback here on purpose. A word boundary is only ever
 * a preference in `splitOversized`, never a correctness requirement, and the
 * one case it exists for - a script with no spaces at all - is exactly the
 * case a space-based fallback could not help with anyway.
 */
export function wordBoundaries(text: string, locale: string, src: SegmenterSource): number[] {
	const seg = src.word(locale);
	return seg ? segmenterBoundaries(seg, text) : [];
}

/** A source that has nothing, so every caller takes its fallback path. */
export const noSegmenters: SegmenterSource = {
	sentence: () => undefined,
	grapheme: () => undefined,
	word: () => undefined,
};

/**
 * The platform's segmenters, feature-detected and cached.
 *
 * Construction is guarded twice over. `Intl.Segmenter` may not exist at all,
 * and it throws `RangeError` on a malformed tag - measured: "zh-cn" and
 * "en-GB" are accepted and "en_US" is not, and Obsidian's `getLanguage()` is
 * not contractually a well-formed BCP 47 tag. A bad tag therefore retries
 * with the host default rather than losing segmentation entirely.
 */
export const platformSegmenters: SegmenterSource = (() => {
	const cache = new Map<string, Intl.Segmenter | undefined>();
	const get = (granularity: "sentence" | "grapheme" | "word", locale: string | undefined): Intl.Segmenter | undefined => {
		const key = `${granularity}\u0000${locale ?? ""}`;
		if (cache.has(key)) return cache.get(key);
		let made: Intl.Segmenter | undefined;
		if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
			try {
				made = new Intl.Segmenter(locale, { granularity });
			} catch {
				try {
					made = new Intl.Segmenter(undefined, { granularity });
				} catch {
					made = undefined;
				}
			}
		}
		cache.set(key, made);
		return made;
	};
	return {
		sentence: (locale) => get("sentence", locale),
		grapheme: () => get("grapheme", undefined),
		word: (locale) => get("word", locale),
	};
})();

/* ------------------------------------------------------------------ *
 * Offline UAX 29 extended grapheme cluster breaker.
 *
 * Not code-point iteration. Iterating code points would keep surrogate pairs
 * intact and nothing else: it would still orphan a combining mark, halve a
 * flag, and cut a ZWJ emoji sequence in two.
 *
 * Property escapes are used freely. That adds no engine floor, because
 * `extract.ts` already fails to *parse* on an engine without them
 * (`isWordChar` is `/[\p{L}\p{N}'’-]/u`), so a third property-free tier would
 * be unreachable code. The one property this rule set needs that V8 does not
 * have is `Prepended_Concatenation_Mark`, which is spelled out below.
 *
 * Verified against `Intl.Segmenter` three times, by three independently
 * written sweeps. The first two - 632,070 strings at implementation and
 * 321,975 at review - both reported agreement on every well-formed input, and
 * both were wrong: neither corpus put a ZWJ *inside* an Indic conjunct run,
 * which is where this breaker disagreed with ICU in 15 distinct shapes until
 * `isIncbExtend` was added (NRL-28 B2). The third sweep, written for that
 * repair, covers 611,870 strings: every ordered pair and triple over a
 * 40-code-point awkward alphabet, the full 19 x 19 x 19 linker/consonant
 * cross product with ten InCB-relevant fillers between them, every BMP code
 * point in five contexts, and 150,000 seeded random strings. Zero well-formed
 * disagreements.
 *
 * Lone surrogates do still disagree, and the number is not worth quoting: it
 * is whatever the corpus contains (28,971 distinct shapes over one alphabet
 * built to hold them). What is invariant is the direction - this breaker's
 * boundaries are a superset of ICU's in every case measured, 0 exceptions -
 * so it can only add a boundary and never remove one, and it cannot split a
 * well-formed cluster. A file decoded as UTF-8 holds no lone surrogate
 * anyway, so it is recorded rather than chased.
 * ------------------------------------------------------------------ */

const OTHER = 0;
const CR = 1;
const LF = 2;
const CONTROL = 3;
const EXTEND = 4;
const ZWJ = 5;
const RI = 6;
const PREPEND = 7;
const SPACINGMARK = 8;
const HANGUL_L = 9;
const HANGUL_V = 10;
const HANGUL_T = 11;
const HANGUL_LV = 12;
const HANGUL_LVT = 13;

const RE_EXTEND = /[\p{Grapheme_Extend}\p{Emoji_Modifier}]/u;
const RE_SPACING_MARK = /\p{gc=Mc}/u;
const RE_CONTROL = /[\p{gc=Cc}\p{gc=Cf}\p{gc=Zl}\p{gc=Zp}\p{gc=Cs}]/u;
// Two `u` patterns rather than one `v` set intersection, because the `v` flag
// needs an es2024 target and this repo builds to es2022.
const RE_UNASSIGNED = /\p{gc=Cn}/u;
const RE_DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
const RE_EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const RE_REGIONAL_INDICATOR = /\p{Regional_Indicator}/u;

function codePointSet(ranges: ReadonlyArray<readonly [number, number]>): Set<number> {
	const out = new Set<number>();
	for (const [from, to] of ranges) {
		for (let cp = from; cp <= to; cp++) out.add(cp);
	}
	return out;
}

/** Grapheme_Cluster_Break=Prepend. V8 has no property escape for these. */
const PREPEND_CPS = codePointSet([
	[0x0600, 0x0605], [0x06dd, 0x06dd], [0x070f, 0x070f], [0x0890, 0x0891], [0x08e2, 0x08e2],
	[0x0d4e, 0x0d4e], [0x110bd, 0x110bd], [0x110cd, 0x110cd], [0x111c2, 0x111c3], [0x1193f, 0x1193f],
	[0x11941, 0x11941], [0x11a3a, 0x11a3a], [0x11a84, 0x11a89], [0x11d46, 0x11d46], [0x11f02, 0x11f02],
]);

/** gc=Mc but Grapheme_Cluster_Break=Other, so they break rather than attach. */
const NOT_SPACING_MARK = codePointSet([
	[0x102b, 0x102c], [0x1038, 0x1038], [0x1062, 0x1064], [0x1067, 0x106d], [0x1083, 0x1083],
	[0x1087, 0x108c], [0x108f, 0x108f], [0x109a, 0x109c], [0x1a61, 0x1a61], [0x1a63, 0x1a64],
	[0xaa7b, 0xaa7b], [0xaa7d, 0xaa7d], [0x11720, 0x11721],
]);

/** gc=Lo but Grapheme_Cluster_Break=SpacingMark. */
const EXTRA_SPACING_MARK = new Set([0x0e33, 0x0eb3]);

/**
 * GB9c, the Indic conjunct rule added in Unicode 15.1: a consonant, a linker
 * and another consonant are one cluster, so a virama never ends a piece.
 *
 * The three sets below were derived from `Intl.Segmenter` itself rather than
 * transcribed, by asking it which code points make `C X C` and `X L X` single
 * clusters, so the fallback agrees with the native path by construction.
 */
const INCB_LINKER = new Set([
	0x094d, 0x09cd, 0x0acd, 0x0b4d, 0x0c4d, 0x0d4d, 0x1039, 0x17d2, 0x1a60, 0x1b44,
	0x1bab, 0xa9c0, 0xaaf6, 0x10a3f, 0x11133, 0x113d0, 0x1193e, 0x11a47, 0x11a99, 0x11f42,
]);
const INCB_CONSONANT = codePointSet([
	[0x0915, 0x0939], [0x0958, 0x095f], [0x0978, 0x097f], [0x0995, 0x09a8], [0x09aa, 0x09b0],
	[0x09b2, 0x09b2], [0x09b6, 0x09b9], [0x09dc, 0x09dd], [0x09df, 0x09df], [0x09f0, 0x09f1],
	[0x0a95, 0x0aa8], [0x0aaa, 0x0ab0], [0x0ab2, 0x0ab3], [0x0ab5, 0x0ab9], [0x0af9, 0x0af9],
	[0x0b15, 0x0b28], [0x0b2a, 0x0b30], [0x0b32, 0x0b33], [0x0b35, 0x0b39], [0x0b5c, 0x0b5d],
	[0x0b5f, 0x0b5f], [0x0b71, 0x0b71], [0x0c15, 0x0c28], [0x0c2a, 0x0c39], [0x0c58, 0x0c5a],
	[0x0d15, 0x0d3a], [0x1000, 0x102a], [0x103f, 0x103f], [0x1050, 0x1055], [0x105a, 0x105d],
	[0x1061, 0x1061], [0x1065, 0x1066], [0x106e, 0x1070], [0x1075, 0x1081], [0x108e, 0x108e],
	[0x1780, 0x17b3], [0x1a20, 0x1a54], [0x1b0b, 0x1b0c], [0x1b13, 0x1b33], [0x1b45, 0x1b4c],
	[0x1b83, 0x1ba0], [0x1bae, 0x1baf], [0x1bbb, 0x1bbd], [0xa989, 0xa98b], [0xa98f, 0xa9b2],
	[0xa9e0, 0xa9e4], [0xa9e7, 0xa9ef], [0xa9fa, 0xa9fe], [0xaa60, 0xaa6f], [0xaa71, 0xaa73],
	[0xaa7a, 0xaa7a], [0xaa7e, 0xaa7f], [0xaae0, 0xaaea], [0xabc0, 0xabda], [0x10a00, 0x10a00],
	[0x10a10, 0x10a13], [0x10a15, 0x10a17], [0x10a19, 0x10a35], [0x11103, 0x11126],
	[0x11144, 0x11144], [0x11147, 0x11147], [0x11380, 0x11389], [0x1138b, 0x1138b],
	[0x1138e, 0x1138e], [0x11390, 0x113b5], [0x11900, 0x11906], [0x11909, 0x11909],
	[0x1190c, 0x11913], [0x11915, 0x11916], [0x11918, 0x1192f], [0x11a00, 0x11a00],
	[0x11a0b, 0x11a32], [0x11a50, 0x11a50], [0x11a5c, 0x11a83], [0x11f04, 0x11f10],
	[0x11f12, 0x11f33],
]);
/** ZWNJ is Grapheme_Cluster_Break=Extend but not InCB=Extend: it ends a conjunct run. */
const NOT_INCB_EXTEND = new Set([0x200c]);

/**
 * InCB=Extend: what may sit inside an Indic conjunct run without ending it.
 *
 * This is deliberately not the same question as `breakClass(cp) === EXTEND`,
 * and the two differ in both directions. ZWNJ is Grapheme_Cluster_Break=Extend
 * and InCB=None, so it ends the run. ZWJ is Grapheme_Cluster_Break=ZWJ - it
 * has to be, because GB11 needs to see it - and InCB=Extend, so it does not.
 *
 * Reading the GB9c state update off the break class alone got the second of
 * those backwards, and `C linker ZWJ C` gained a boundary ICU does not have,
 * in every one of the 100 (linker, consonant) pairs the tables above hold
 * (NRL-28 B2). ZWJ inside a conjunct is real Indic orthography, not a
 * degenerate shape.
 */
function isIncbExtend(cls: number, cp: number): boolean {
	if (NOT_INCB_EXTEND.has(cp)) return false;
	return cls === EXTEND || cls === ZWJ;
}

function hangulClass(cp: number): number {
	if (cp >= 0x1100 && cp <= 0x115f) return HANGUL_L;
	if (cp >= 0xa960 && cp <= 0xa97c) return HANGUL_L;
	if (cp >= 0x1160 && cp <= 0x11a7) return HANGUL_V;
	if (cp >= 0xd7b0 && cp <= 0xd7c6) return HANGUL_V;
	if (cp >= 0x11a8 && cp <= 0x11ff) return HANGUL_T;
	if (cp >= 0xd7cb && cp <= 0xd7fb) return HANGUL_T;
	if (cp >= 0xac00 && cp <= 0xd7a3) return (cp - 0xac00) % 28 === 0 ? HANGUL_LV : HANGUL_LVT;
	return -1;
}

/**
 * Grapheme_Cluster_Break of one code point.
 *
 * Order matters: Regional_Indicator, Prepend, Extend and SpacingMark are all
 * tested before Control, because several of them are `gc=Cf` and would
 * otherwise be classed as controls and break where they must attach.
 *
 * ZWJ is tested before Extend and must stay there, because GB11 has to be
 * able to see a ZWJ as a ZWJ. That is a Grapheme_Cluster_Break answer, and it
 * is the wrong answer to the InCB question GB9c asks - see `isIncbExtend`,
 * which is where that distinction belongs rather than here.
 */
function breakClass(cp: number): number {
	if (cp === 0x0d) return CR;
	if (cp === 0x0a) return LF;
	if (cp === 0x200d) return ZWJ;
	const ch = String.fromCodePoint(cp);
	if (RE_REGIONAL_INDICATOR.test(ch)) return RI;
	if (PREPEND_CPS.has(cp)) return PREPEND;
	if (RE_EXTEND.test(ch)) return EXTEND;
	if (EXTRA_SPACING_MARK.has(cp)) return SPACINGMARK;
	if (RE_SPACING_MARK.test(ch) && !NOT_SPACING_MARK.has(cp)) return SPACINGMARK;
	if (RE_CONTROL.test(ch) || (RE_UNASSIGNED.test(ch) && RE_DEFAULT_IGNORABLE.test(ch))) return CONTROL;
	const hangul = hangulClass(cp);
	if (hangul >= 0) return hangul;
	return OTHER;
}

/** Offsets where an extended grapheme cluster starts, excluding 0. */
export function uax29GraphemeBoundaries(text: string): number[] {
	const out: number[] = [];
	if (text.length === 0) return out;

	let i = 0;
	let cp = text.codePointAt(0)!;
	let prevClass = breakClass(cp);
	// GB11 wants "Extended_Pictographic Extend* ZWJ" before the current
	// character. Two flags rather than one, because a second ZWJ in a row is
	// not preceded by Extend* and so does not arm the rule.
	let pictRun = RE_EXTENDED_PICTOGRAPHIC.test(String.fromCodePoint(cp));
	let zwjAfterPict = false;
	// GB12/GB13 join regional indicators in pairs, so the rule needs the
	// length of the unbroken run ending at the previous code point.
	let riRun = prevClass === RI ? 1 : 0;
	// GB9c, above.
	let inConsonant = INCB_CONSONANT.has(cp);
	let linkerSeen = false;
	i += cp > 0xffff ? 2 : 1;

	while (i < text.length) {
		cp = text.codePointAt(i)!;
		const width = cp > 0xffff ? 2 : 1;
		const cls = breakClass(cp);
		const isPict = RE_EXTENDED_PICTOGRAPHIC.test(String.fromCodePoint(cp));

		let brk: boolean;
		if (prevClass === CR && cls === LF) brk = false; // GB3
		else if (prevClass === CR || prevClass === LF || prevClass === CONTROL) brk = true; // GB4
		else if (cls === CR || cls === LF || cls === CONTROL) brk = true; // GB5
		else if (prevClass === HANGUL_L && (cls === HANGUL_L || cls === HANGUL_V || cls === HANGUL_LV || cls === HANGUL_LVT)) brk = false; // GB6
		else if ((prevClass === HANGUL_LV || prevClass === HANGUL_V) && (cls === HANGUL_V || cls === HANGUL_T)) brk = false; // GB7
		else if ((prevClass === HANGUL_LVT || prevClass === HANGUL_T) && cls === HANGUL_T) brk = false; // GB8
		else if (cls === EXTEND || cls === ZWJ) brk = false; // GB9
		else if (cls === SPACINGMARK) brk = false; // GB9a
		else if (prevClass === PREPEND) brk = false; // GB9b
		else if (inConsonant && linkerSeen && INCB_CONSONANT.has(cp)) brk = false; // GB9c
		else if (zwjAfterPict && isPict) brk = false; // GB11
		else if (prevClass === RI && cls === RI && riRun % 2 === 1) brk = false; // GB12/GB13
		else brk = true; // GB999

		if (brk) out.push(i);

		if (isPict) {
			pictRun = true;
			zwjAfterPict = false;
		} else if (cls === EXTEND) {
			zwjAfterPict = false;
		} else if (cls === ZWJ) {
			zwjAfterPict = pictRun;
			pictRun = false;
		} else {
			pictRun = false;
			zwjAfterPict = false;
		}

		riRun = cls === RI ? (brk ? 1 : riRun + 1) : 0;

		if (brk) {
			inConsonant = INCB_CONSONANT.has(cp);
			linkerSeen = false;
		} else if (INCB_LINKER.has(cp)) {
			if (inConsonant) linkerSeen = true;
		} else if (INCB_CONSONANT.has(cp)) {
			inConsonant = true;
			linkerSeen = false;
		} else if (!isIncbExtend(cls, cp)) {
			inConsonant = false;
			linkerSeen = false;
		}

		prevClass = cls;
		i += width;
	}
	return out;
}
