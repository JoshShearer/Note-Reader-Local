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

console.log("");
if (failures === 0) {
	console.log("All tests passed");
	process.exit(0);
} else {
	console.log(`${failures} test(s) failed`);
	process.exit(1);
}
