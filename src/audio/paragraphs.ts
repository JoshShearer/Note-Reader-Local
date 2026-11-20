import type { SpeechChunk } from "./types";

/**
 * Where paragraphs begin.
 *
 * Chunks are sentences. The extractor numbers the block each came from, and a
 * chunk starts a paragraph when its number differs from the previous chunk's.
 * Chunks without a number (built some other way) fall back to their edges: a
 * chunk starts one when the kind of block changes (a heading, then prose), or
 * when more than a single separator character lies between it and the previous
 * chunk in the note - a blank line, or a list or quote marker.
 */
export function startsParagraph(chunks: readonly SpeechChunk[], index: number): boolean {
	if (index <= 0) return true;
	const chunk = chunks[index];
	const before = chunks[index - 1];
	if (!chunk || !before) return true;
	if (chunk.paragraph !== undefined && before.paragraph !== undefined) return chunk.paragraph !== before.paragraph;
	const gap = chunk.sourceStart - before.sourceEnd;
	return chunk.blockType !== before.blockType || gap < 0 || gap >= 2;
}

/** The first paragraph start after `from`, or null when `from` is in the last paragraph. */
export function nextParagraphStart(chunks: readonly SpeechChunk[], from: number): number | null {
	for (let i = Math.max(0, from + 1); i < chunks.length; i += 1) {
		if (startsParagraph(chunks, i)) return i;
	}
	return null;
}

/**
 * The start of the paragraph `from` is in, or, when already at that start, of
 * the one before it. Null when there is nowhere earlier to go.
 *
 * With `restartCurrent` false the current paragraph's start is not an answer:
 * the result is always the paragraph before. That is for a second press in
 * quick succession, when reading has already moved a sentence or two into the
 * paragraph the first press landed on.
 */
export function previousParagraphStart(
	chunks: readonly SpeechChunk[],
	from: number,
	restartCurrent = true,
): number | null {
	let i = Math.min(from, chunks.length - 1);
	if (i < 0) return null;
	while (i > 0 && !startsParagraph(chunks, i)) i -= 1;
	if (restartCurrent && i !== from) return i;
	for (i -= 1; i >= 0; i -= 1) {
		if (startsParagraph(chunks, i)) return i;
	}
	return null;
}
