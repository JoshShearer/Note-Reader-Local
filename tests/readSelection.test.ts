/**
 * Tests for the read-selection clip: NRL-52 (clip at all) and NRL-57 (clip
 * from `sourceIndex`, not from raw-offset arithmetic).
 *
 * This file drives the REAL production symbol, `clipChunksToSelection` from
 * `src/audio/clip.ts`, which is the module `main.ts` calls. It used to hold a
 * 37-line copy of main.ts's logic instead, and that is precisely why its 73
 * checks stayed green through PR #58 while the shipped clip was wrong: a copy
 * can only ever test itself.
 *
 * Two classes of check live here and must not be confused with each other.
 * The NRL-57 block's C-checks were measured RED against the unfixed algorithm.
 * Everything labelled a GUARD was measured green on both sides of the fix; a
 * guard passing is evidence of no regression, never evidence of the fix.
 */

import { extractChunks } from "../src/text/extract.ts";
import { platformSegmenters } from "../src/text/segment.ts";
import { allocateWordTimings, clipWordSpans, findWords } from "../src/audio/words.ts";
import { clipChunksToSelection } from "../src/audio/clip.ts";
import type { SpeechChunk } from "../src/audio/types.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
	if (cond) console.log(`  ok   ${name}`);
	else {
		failures += 1;
		console.log(`  FAIL ${name} ${detail}`);
	}
}

console.log("readSelection chunk clipping");

// Test 1 (GUARD, green both sides): plain prose has no stripping, so the old
// subtraction happened to be right here. This is the NRL-52 regression guard.
{
	const note = "This is the first sentence. This is the second sentence. This is the third sentence.";
	const chunks = extractChunks(
		note,
		{
			stripTags: false,
			speakUrls: true,
			skipCodeBlocks: true,
			skipInlineCode: true,
			skipTables: true,
			skipHeadings: true,
			skipFrontmatter: true,
			speakImageAlt: true,
			speakEmbeds: true,
			locale: "en",
		},
		platformSegmenters,
		"test.md",
	);

	const from = 12; // Start in the middle of "first"
	const to = 58; // End in the middle of "second"
	const clipped = clipChunksToSelection(chunks, from, to);

	const expectedText = note.substring(from, to);
	const clippedText = clipped.map((c) => c.text).join("");

	check("GUARD single chunk clipping: text matches selection", clippedText === expectedText, `got "${clippedText}" expected "${expectedText}"`);

	// Verify sourceIndex is maintained: each character should map back to its offset
	for (const chunk of clipped) {
		for (let i = 0; i < chunk.text.length; i++) {
			const sourceOffset = chunk.sourceIndex[i];
			if (sourceOffset !== undefined) {
				check(
					`GUARD single chunk: sourceIndex[${i}] maps to correct character`,
					note[sourceOffset] === chunk.text[i],
					`at index ${i}: note[${sourceOffset}]="${note[sourceOffset]}" != chunk.text[${i}]="${chunk.text[i]}"`,
				);
			}
		}
	}

	// Verify sourceStart and sourceEnd are correct
	check(
		"GUARD single chunk: sourceStart is correct",
		clipped[0]?.sourceStart === from,
		`got ${clipped[0]?.sourceStart} expected ${from}`,
	);
	check(
		"GUARD single chunk: sourceEnd is correct",
		clipped[clipped.length - 1]?.sourceEnd === to,
		`got ${clipped[clipped.length - 1]?.sourceEnd} expected ${to}`,
	);
}

// Test 2 (GUARD, green both sides): selection at exact chunk boundaries.
{
	const note = "First sentence. Second sentence. Third sentence.";
	const chunks = extractChunks(
		note,
		{
			stripTags: false,
			speakUrls: true,
			skipCodeBlocks: true,
			skipInlineCode: true,
			skipTables: true,
			skipHeadings: true,
			skipFrontmatter: true,
			speakImageAlt: true,
			speakEmbeds: true,
			locale: "en",
		},
		platformSegmenters,
		"test.md",
	);

	const from = 0;
	const to = note.length;
	const clipped = clipChunksToSelection(chunks, from, to);

	const clippedText = clipped.map((c) => c.text).join("");
	check("GUARD exact boundaries: text equals note", clippedText === note, `got "${clippedText}"`);
	check(
		"GUARD exact boundaries: no clipping occurred",
		clipped.length === chunks.length && clipped[0]?.sourceStart === 0 && clipped[clipped.length - 1]?.sourceEnd === note.length,
	);
}

// Test 3 (GUARD, green both sides): multiple overlapping boundaries, plain prose.
{
	const note = "One. Two. Three. Four. Five.";
	const chunks = extractChunks(
		note,
		{
			stripTags: false,
			speakUrls: true,
			skipCodeBlocks: true,
			skipInlineCode: true,
			skipTables: true,
			skipHeadings: true,
			skipFrontmatter: true,
			speakImageAlt: true,
			speakEmbeds: true,
			locale: "en",
		},
		platformSegmenters,
		"test.md",
	);

	const from = 5; // In "Two"
	const to = 24; // In "Five"
	const clipped = clipChunksToSelection(chunks, from, to);

	const expectedText = note.substring(from, to);
	const clippedText = clipped.map((c) => c.text).join("");

	check("GUARD multiple boundaries: text matches selection", clippedText === expectedText, `got "${clippedText}" expected "${expectedText}"`);

	// Verify sourceIndex maps correctly
	let offset = 0;
	for (const chunk of clipped) {
		for (let i = 0; i < chunk.text.length; i++) {
			const sourceOffset = chunk.sourceIndex[i];
			if (sourceOffset !== undefined) {
				check(
					`GUARD multi-boundary: sourceIndex consistency`,
					note[sourceOffset] === chunk.text[i],
					`at position ${offset + i}: note[${sourceOffset}]="${note[sourceOffset]}" != chunk.text[${i}]="${chunk.text[i]}"`,
				);
			}
		}
		offset += chunk.text.length;
	}
}

/*
 * Test 4, restated. It used to assert that the overlap prefilter returned one
 * chunk for a point selection; NRL-57 moved that filter inside the function and
 * subsumed it into the scan, so there is nothing left to observe from outside.
 * What is worth asserting is the outcome: a point selection yields no chunks.
 *
 * G3 is the one G-numbered check that was RED at base, and it is a guard only
 * in the sense that it cannot fail in the product: the read-selection
 * checkCallback (main.ts) refuses an empty selection before readSelection is
 * ever called. The old algorithm returned one chunk carrying empty text.
 */
{
	const note = "One sentence. Two sentence.";
	const chunks = extractChunks(
		note,
		{
			stripTags: false,
			speakUrls: true,
			skipCodeBlocks: true,
			skipInlineCode: true,
			skipTables: true,
			skipHeadings: true,
			skipFrontmatter: true,
			speakImageAlt: true,
			speakEmbeds: true,
			locale: "en",
		},
		platformSegmenters,
		"test.md",
	);

	check("G3 a point selection yields no chunks", clipChunksToSelection(chunks, 5, 5).length === 0);
}

/*
 * NRL-57. The defect: main.ts derived its slice bounds by subtracting raw
 * offsets (`textStart = from - chunk.sourceStart`), which is only correct when
 * one raw character produced one spoken character. Markdown stripping is
 * exactly what makes that false, so on any note with syntax in it the clip
 * slid by the number of stripped characters.
 *
 * C1-C7 were measured RED against that algorithm. G1 was measured GREEN
 * against it, and is kept for the warning it carries rather than the coverage.
 */
console.log("NRL-57 selection clipping is derived from sourceIndex");

const NRL57_OPTIONS = {
	stripTags: true,
	speakUrls: false,
	skipCodeBlocks: true,
	skipInlineCode: true,
	skipTables: true,
	skipHeadings: false,
	skipFrontmatter: true,
	speakImageAlt: true,
	speakEmbeds: true,
	locale: "en",
} as const;

function extract(note: string): SpeechChunk[] {
	return extractChunks(note, NRL57_OPTIONS, platformSegmenters, "test.md");
}

/** Entries of `clipped` that fall outside the half-open raw range. */
function offsetsOutside(clipped: readonly SpeechChunk[], from: number, to: number): number {
	let outside = 0;
	for (const chunk of clipped) {
		for (const off of chunk.sourceIndex) {
			if (off < from || off >= to) outside += 1;
		}
	}
	return outside;
}

const REPROS: Array<{ label: string; note: string; from: number; to: number; want: string }> = [
	{ label: "case 1 bold", note: "Before **bold** after.", from: 9, to: 13, want: "bold" },
	{ label: "case 2 after", note: "Before **bold** after.", from: 16, to: 21, want: "after" },
	{ label: "case 3 label", note: "Before [label](destination) after.", from: 8, to: 13, want: "label" },
	{ label: "case 4 hidden", note: "Before %%hidden%% after.", from: 9, to: 15, want: "" },
];

{
	/*
	 * C1 is THE assertion. Measured against the unfixed algorithm at bbe37f3:
	 * 2, 1, 1 and 4 entries outside the selection on the four cases.
	 */
	for (const r of REPROS) {
		const clipped = clipChunksToSelection(extract(r.note), r.from, r.to);
		const outside = offsetsOutside(clipped, r.from, r.to);
		check(`C1 ${r.label}: every mapped offset lies inside the selection`, outside === 0, `${outside} outside [${r.from},${r.to})`);
	}

	// C2: the spoken text is what the user selected. Base spoke "ld a", "r.",
	// "abel ".
	for (const r of REPROS.slice(0, 3)) {
		const spoken = clipChunksToSelection(extract(r.note), r.from, r.to)
			.map((c) => c.text)
			.join("");
		check(`C2 ${r.label}: speaks exactly the selected text`, spoken === r.want, `got "${spoken}" expected "${r.want}"`);
	}

	/*
	 * C3: a selection consisting only of content extraction excluded yields no
	 * chunk at all, so readSelection shows "No text in selection." and starts
	 * no playback. Base produced one chunk speaking "ter." - text from outside
	 * the selection entirely.
	 */
	check("C3 case 4: a selection of only hidden content yields zero chunks", clipChunksToSelection(extract("Before %%hidden%% after."), 9, 15).length === 0);

	// The same property on two more excluded shapes, both measured RED at base:
	// the old overlap prefilter admitted a chunk for each.
	const excluded: Array<[string, string, number, number]> = [
		["the ** emphasis markers", "Before **bold** after.", 7, 9],
		["the inside of an inline code span", "Before `code` after.", 8, 12],
	];
	for (const [label, note, from, to] of excluded) {
		check(`C3 ${label}: yields zero chunks`, clipChunksToSelection(extract(note), from, to).length === 0);
	}

	// A GUARD, not a C-case: a selection inside a fenced block was already
	// green at base, because the fence sits between two chunks so the old
	// overlap prefilter found nothing to admit in the first place.
	check(
		"GUARD the inside of a fenced block: yields zero chunks",
		clipChunksToSelection(extract("Before\n```\nsecret code\n```\nafter."), 11, 22).length === 0,
	);
}

{
	const note =
		"The **first** sentence is long enough to stand on its own without merging. " +
		"The [second](https://example.com/path) sentence is also long enough to stand alone here. " +
		"The *third* sentence is likewise sufficiently long that it will not be merged.";
	const chunks = extract(note);

	/*
	 * C4: the old algorithm only ever clipped the FIRST and LAST chunk, using
	 * the first chunk's own sourceStart, so on this note selection [71,166)
	 * made chunk 0 clip to "" and handed an empty utterance to the engine as
	 * the first of three.
	 */
	const mid = clipChunksToSelection(chunks, 71, 166);
	check("C4 no clipped chunk has empty text", mid.every((c) => c.text.length > 0), JSON.stringify(mid.map((c) => c.text)));
	// A GUARD: base also returned three here. It is the emptiness that moved.
	check("GUARD C4 the surviving chunks are still three", mid.length === 3, `${mid.length}`);

	/*
	 * C5: both edges of a multi-chunk selection are clipped by the same loop,
	 * which is why the isFirst/isLast state disappeared rather than being
	 * fixed. Base: 28 offsets outside, and a trailing chunk of
	 * "The second sentence is also long enough to stand al".
	 */
	const span = clipChunksToSelection(chunks, 6, 126);
	// A GUARD: base also returned two. It is where the edges landed that moved.
	check("GUARD C5 multi-chunk selection yields two chunks", span.length === 2, `${span.length}`);
	check(
		"C5 the leading edge is clipped at the selection",
		span[0]?.text === "first sentence is long enough to stand on its own without merging." && span[0]?.sourceStart === 6 && span[0]?.sourceEnd === 74,
		`${JSON.stringify(span[0]?.text)} [${span[0]?.sourceStart},${span[0]?.sourceEnd})`,
	);
	check(
		"C5 the trailing edge is clipped at the selection",
		span[1]?.text === "The second sentence is " && span[1]?.sourceStart === 75 && span[1]?.sourceEnd === 126,
		`${JSON.stringify(span[1]?.text)} [${span[1]?.sourceStart},${span[1]?.sourceEnd})`,
	);
	check("C5 no offset falls outside the selection", offsetsOutside(span, 6, 126) === 0);

	/*
	 * C6. The host cannot deliver a reversed range: @codemirror/state's
	 * SelectionRange stores `from` as the lower boundary and keeps direction in
	 * an Inverted flag, so main.ts can only ever pass from <= to. Normalising
	 * inside the pure function is what makes the property reachable by a test
	 * at all, which is the reason it lives there.
	 */
	check(
		"C6 a reversed range equals the forward one",
		JSON.stringify(clipChunksToSelection(chunks, 126, 6)) === JSON.stringify(span),
	);

	/*
	 * C7: lockstep, checked numerically rather than by character identity.
	 * `sourceEnd = sourceIndex[last] + 1` is extract.ts's own convention and is
	 * deliberately kept (it is what the sentence highlight is drawn from).
	 */
	const everything = [
		...REPROS.map((r) => clipChunksToSelection(extract(r.note), r.from, r.to)),
		mid,
		span,
	].flat();
	let lockstep = 0;
	for (const c of everything) {
		if (c.text.length !== c.sourceIndex.length) lockstep += 1;
		if (c.sourceStart !== c.sourceIndex[0]) lockstep += 1;
		if (c.sourceEnd !== c.sourceIndex[c.sourceIndex.length - 1]! + 1) lockstep += 1;
	}
	check(`C7 text and sourceIndex stay in lockstep across ${everything.length} clipped chunks`, lockstep === 0, `${lockstep} violations`);
}

/*
 * G1 is a GUARD, and the most important comment in this file is attached to it.
 *
 * `note[sourceIndex[i]] === text[i]` was measured with 0 mismatches on all four
 * repro cases AGAINST THE BUG. It cannot catch this defect, because the old
 * clip sliced `text` and `sourceIndex` by the same wrong window, so character
 * identity survived while the window was wrong. This assertion passing is how
 * 73 green checks hid the defect through PR #58. Keep it - it is a real
 * lockstep guard - but never read its green as evidence that the clip is right.
 */
{
	let mismatches = 0;
	let compared = 0;
	for (const r of REPROS) {
		for (const chunk of clipChunksToSelection(extract(r.note), r.from, r.to)) {
			for (let i = 0; i < chunk.text.length; i++) {
				compared += 1;
				if (r.note[chunk.sourceIndex[i]!] !== chunk.text[i]) mismatches += 1;
			}
		}
	}
	check(`GUARD G1 every mapped offset names its own character (${compared} compared)`, mismatches === 0, `${mismatches} mismatches`);
}

/*
 * NRL-47. `clipWordSpans` is the guard that keeps a precomputed word span from
 * surviving the clip while still indexing the unclipped text. It is exercised
 * directly here, and end to end through the real `clipChunksToSelection`.
 */
console.log("NRL-47 clipWordSpans");
{
	const spans = findWords("abc def ghi");
	check("unclipped spans are unchanged", JSON.stringify(clipWordSpans(spans, "abc def ghi", 0, 11)) === JSON.stringify(spans));

	// Clipping from 4 drops "abc" and rebases the rest onto the new text.
	const from4 = clipWordSpans(spans, "abc def ghi", 4, 11);
	check(
		"spans are rebased by textStart",
		JSON.stringify(from4) === JSON.stringify([
			{ word: "def", start: 0, end: 3 },
			{ word: "ghi", start: 4, end: 7 },
		]),
		JSON.stringify(from4),
	);

	// A span straddling the clip point is truncated, not dropped, and `word`
	// is re-sliced so it still matches the text the span now names.
	const mid = clipWordSpans(spans, "abc def ghi", 0, 5);
	check(
		"a straddling span is clamped and re-sliced",
		JSON.stringify(mid) === JSON.stringify([
			{ word: "abc", start: 0, end: 3 },
			{ word: "d", start: 4, end: 5 },
		]),
		JSON.stringify(mid),
	);

	check("an empty window yields nothing", clipWordSpans(spans, "abc def ghi", 5, 5).length === 0);

	/*
	 * End to end, on the shape that actually matters: a CJK note has real
	 * precomputed spans, so clipping a selection out of it must leave every
	 * timing still naming the raw markdown it names in the clipped text. This
	 * is the non-negotiable 8 assertion for the read-selection path.
	 */
	const raw = "这是第一句。这是第二句。第三句结束了。";
	const chunks = extractChunks(
		raw,
		{
			stripTags: true,
			speakUrls: false,
			skipCodeBlocks: true,
			skipInlineCode: true,
			skipTables: true,
			skipHeadings: false,
			skipFrontmatter: true,
			speakImageAlt: true,
			speakEmbeds: false,
			locale: "en",
		},
		platformSegmenters,
		"Notes/cjk.md",
	);
	check("CJK chunks carry precomputed spans", chunks.some((c) => c.wordSpans !== undefined));

	// A selection starting two units into the first chunk and ending two units
	// before the end of the last.
	const from = 2;
	const to = raw.length - 2;
	const clipped = clipChunksToSelection(chunks, from, to);
	let bad = 0;
	let total = 0;
	for (const c of clipped) {
		for (const s of c.wordSpans ?? []) {
			if (s.word !== c.text.slice(s.start, s.end)) bad += 1;
		}
		for (const w of allocateWordTimings(c, 3000, 1)) {
			total += 1;
			if (raw.slice(w.sourceStart, w.sourceEnd) !== c.text.slice(w.start, w.end)) bad += 1;
		}
	}
	check("clipped CJK timings still name their raw markdown", bad === 0 && total > clipped.length, `${bad} bad of ${total}`);
	check("G4 clipped CJK offsets stay inside the selection", offsetsOutside(clipped, from, to) === 0);
}

console.log("");
if (failures === 0) {
	console.log("All tests passed");
	process.exit(0);
} else {
	console.log(`${failures} test(s) failed`);
	process.exit(1);
}
