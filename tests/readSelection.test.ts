/**
 * Tests for NRL-52: readSelection chunk clipping logic.
 *
 * Verifies that when a selection spans multiple chunks (with overlapping
 * boundaries), only the selected text is clipped and spoken, not entire chunks.
 *
 * The clipping maintains sourceIndex synchronization:
 * for each character in the clipped text, sourceIndex[i] maps to the offset
 * in the raw markdown that produced that character.
 */

import { extractChunks } from "../src/text/extract.ts";
import { platformSegmenters } from "../src/text/segment.ts";
import { allocateWordTimings, clipWordSpans, findWords } from "../src/audio/words.ts";
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

// Helper function that mimics the clipping logic in readSelection
function clipChunksToSelection(selectedChunks: SpeechChunk[], from: number, to: number): SpeechChunk[] {
	return selectedChunks.map((chunk, idx, arr) => {
		const isFirst = idx === 0;
		const isLast = idx === arr.length - 1;

		let textStart = 0;
		let textEnd = chunk.text.length;

		// Clip first chunk: remove text before selection start
		if (isFirst && chunk.sourceStart < from) {
			textStart = from - chunk.sourceStart;
		}

		// Clip last chunk: remove text after selection end
		if (isLast && chunk.sourceEnd > to) {
			textEnd = to - chunk.sourceStart;
		}

		const newText = chunk.text.slice(textStart, textEnd);
		const newSourceIndex = chunk.sourceIndex.slice(textStart, textEnd);
		const newSourceStart = newSourceIndex[0] ?? chunk.sourceStart;
		const newSourceEnd = (newSourceIndex[newSourceIndex.length - 1] ?? chunk.sourceEnd - 1) + 1;

		return {
			...chunk,
			text: newText,
			sourceIndex: newSourceIndex,
			sourceStart: newSourceStart,
			sourceEnd: newSourceEnd,
			// Mirrors main.ts. NRL-47 added wordSpans to SpeechChunk, and the
			// spread would carry them through still indexing the unclipped
			// text. `clipWordSpans` is imported from the real module rather
			// than copied, so this half at least cannot drift.
			wordSpans: chunk.wordSpans && clipWordSpans(chunk.wordSpans, chunk.text, textStart, textEnd),
		};
	});
}

// Test 1: Single chunk with selection in the middle
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
	const selectedChunks = chunks.filter((chunk) => chunk.sourceEnd > from && chunk.sourceStart < to);
	const clipped = clipChunksToSelection(selectedChunks, from, to);

	const expectedText = note.substring(from, to); // " the first sentence. This is the s"
	const clippedText = clipped.map((c) => c.text).join("");

	check("single chunk clipping: text matches selection", clippedText === expectedText, `got "${clippedText}" expected "${expectedText}"`);

	// Verify sourceIndex is maintained: each character should map back to its offset
	for (const chunk of clipped) {
		for (let i = 0; i < chunk.text.length; i++) {
			const sourceOffset = chunk.sourceIndex[i];
			if (sourceOffset !== undefined) {
				check(
					`single chunk: sourceIndex[${i}] maps to correct character`,
					note[sourceOffset] === chunk.text[i],
					`at index ${i}: note[${sourceOffset}]="${note[sourceOffset]}" != chunk.text[${i}]="${chunk.text[i]}"`,
				);
			}
		}
	}

	// Verify sourceStart and sourceEnd are correct
	check(
		"single chunk: sourceStart is correct",
		clipped[0]?.sourceStart === from,
		`got ${clipped[0]?.sourceStart} expected ${from}`,
	);
	check(
		"single chunk: sourceEnd is correct",
		clipped[clipped.length - 1]?.sourceEnd === to,
		`got ${clipped[clipped.length - 1]?.sourceEnd} expected ${to}`,
	);
}

// Test 2: Selection at exact chunk boundaries (clean alignment)
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
	const selectedChunks = chunks.filter((chunk) => chunk.sourceEnd > from && chunk.sourceStart < to);
	const clipped = clipChunksToSelection(selectedChunks, from, to);

	const clippedText = clipped.map((c) => c.text).join("");
	check("exact boundaries: text equals note", clippedText === note, `got "${clippedText}"`);
	check(
		"exact boundaries: no clipping occurred",
		clipped.length === chunks.length && clipped[0]?.sourceStart === 0 && clipped[clipped.length - 1]?.sourceEnd === note.length,
	);
}

// Test 3: Selection with multiple overlapping boundaries
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
	const selectedChunks = chunks.filter((chunk) => chunk.sourceEnd > from && chunk.sourceStart < to);
	const clipped = clipChunksToSelection(selectedChunks, from, to);

	const expectedText = note.substring(from, to); // "Two. Three. Four. Fi"
	const clippedText = clipped.map((c) => c.text).join("");

	check("multiple boundaries: text matches selection", clippedText === expectedText, `got "${clippedText}" expected "${expectedText}"`);

	// Verify sourceIndex maps correctly
	let offset = 0;
	for (const chunk of clipped) {
		for (let i = 0; i < chunk.text.length; i++) {
			const sourceOffset = chunk.sourceIndex[i];
			if (sourceOffset !== undefined) {
				check(
					`multi-boundary: sourceIndex consistency`,
					note[sourceOffset] === chunk.text[i],
					`at position ${offset + i}: note[${sourceOffset}]="${note[sourceOffset]}" != chunk.text[${i}]="${chunk.text[i]}"`,
				);
			}
		}
		offset += chunk.text.length;
	}
}

// Test 4: Selection at a point (edge case - should select chunks containing that point)
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

	// Point selection at position 5 (in the middle of a single chunk)
	const from = 5;
	const to = 5; // Empty selection at a point
	const selectedChunks = chunks.filter((chunk) => chunk.sourceEnd > from && chunk.sourceStart < to);

	// A point selection [5,5) is empty, but chunks that contain the point are still
	// selected by the overlap filter. In this case, the single chunk covers the entire
	// note, so it gets selected. The clipping logic will then produce empty text for
	// this selection.
	check("point selection: chunks containing the point are selected", selectedChunks.length === 1);

	// Verify clipping produces empty text
	const clipped = clipChunksToSelection(selectedChunks, from, to);
	const clippedText = clipped.map((c) => c.text).join("");
	check("point selection: clipping produces empty text", clippedText === "", `got "${clippedText}"`);
}

/*
 * NRL-47. `clipWordSpans` is the guard that keeps a precomputed word span from
 * surviving the clip above while still indexing the unclipped text. It is
 * exercised directly here, and through the mirrored clip helper, because this
 * suite holds its own copy of main.ts's clipping logic rather than importing
 * main.ts, so a bug in the real call site would otherwise be invisible.
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
	const selected = chunks.filter((c) => c.sourceEnd > from && c.sourceStart < to);
	const clipped = clipChunksToSelection(selected, from, to);
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
}

console.log("");
if (failures === 0) {
	console.log("All tests passed");
	process.exit(0);
} else {
	console.log(`${failures} test(s) failed`);
	process.exit(1);
}
