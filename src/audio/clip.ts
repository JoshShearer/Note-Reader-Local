import type { SpeechChunk } from "./types";
import { clipWordSpans } from "./words";

/**
 * Narrow a chunk queue to the part of it the user selected.
 *
 * `from`/`to` are offsets into the RAW markdown, half-open, as the editor
 * reports a selection. The boundaries they name inside each chunk's spoken
 * text are FOUND by reading `sourceIndex`, never computed from it.
 *
 * That distinction is the whole of NRL-57. The shipped version of this code
 * lived in main.ts and said `textStart = from - chunk.sourceStart`, which is
 * correct only while one raw character produces one spoken character. Markdown
 * stripping is exactly what makes that false, so the slice slid by however many
 * characters had been stripped: selecting `bold` out of `Before **bold**
 * after.` spoke `ld a`, and selecting `hidden` out of `Before %%hidden%%
 * after.` spoke `ter.` - text from outside the selection entirely. So there is
 * no subtraction of one raw offset from another anywhere below, and no
 * `indexOf` or other search of the note either: `lo` and `hi` are only ever
 * COMPARED against `sourceIndex` values (non-negotiable 8, and CONTEXT.md's
 * "Offsets, not search").
 *
 * The comparison is `<` against `lo`/`hi` rather than a search for an exact
 * offset because `sourceIndex` is non-decreasing but NOT strictly increasing:
 * `mergeShort`'s synthesised join space can take the same offset as the entry
 * before it. The selected set is still contiguous, which is all the scan needs.
 *
 * The function takes the FULL chunk list and owns the drop itself. A caller-side
 * overlap prefilter would run on un-normalised `from`/`to` and reject
 * everything on a reversed range, and it is the same shape of pre-filter that
 * broke stored-position resume (CONTEXT.md, "A stored offset is resolved by
 * Player, not by the caller").
 */
export function clipChunksToSelection(
	chunks: readonly SpeechChunk[],
	from: number,
	to: number,
): SpeechChunk[] {
	// A reversed range is normalised here rather than at the call site because
	// here is the only place a test can reach it: @codemirror/state stores a
	// SelectionRange's `from` as the lower boundary and keeps direction in a
	// separate flag, so the host can never hand main.ts `from > to`.
	const lo = Math.min(from, to);
	const hi = Math.max(from, to);

	const out: SpeechChunk[] = [];
	for (const chunk of chunks) {
		const idx = chunk.sourceIndex;

		let textStart = 0;
		while (textStart < idx.length && idx[textStart]! < lo) textStart += 1;
		let textEnd = textStart;
		while (textEnd < idx.length && idx[textEnd]! < hi) textEnd += 1;

		// One guard covers every way a chunk can contribute nothing: it lies
		// wholly before the selection (the first loop runs off the end), wholly
		// after it (the second cannot advance), the selection is empty, or the
		// selection covers only content extraction excluded, so no entry points
		// into it. An empty utterance used to be handed to the engine in the
		// middle of a queue; now it is simply never emitted.
		if (textEnd <= textStart) continue;

		const newSourceIndex = idx.slice(textStart, textEnd);
		out.push({
			...chunk,
			text: chunk.text.slice(textStart, textEnd),
			sourceIndex: newSourceIndex,
			// Safe without a fallback precisely because the guard above has
			// already proved the slice is non-empty. `sourceEnd` keeps
			// extract.ts's own last-offset-plus-one convention, which is what
			// the sentence highlight is drawn from.
			sourceStart: newSourceIndex[0]!,
			sourceEnd: newSourceIndex[newSourceIndex.length - 1]! + 1,
			// The spread would carry wordSpans through unchanged, still
			// indexing the UNCLIPPED text, so every span past the clip point
			// would be off by textStart and the highlight would land on the
			// wrong characters (non-negotiable 8). clipWordSpans takes the
			// unclipped text and the unrebased bounds by contract.
			wordSpans: chunk.wordSpans && clipWordSpans(chunk.wordSpans, chunk.text, textStart, textEnd),
		});
	}
	return out;
}
