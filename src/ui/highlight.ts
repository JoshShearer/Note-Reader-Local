import { StateEffect, StateField } from "@codemirror/state";
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";

/**
 * Sentence and word highlighting as CodeMirror 6 decorations.
 *
 * Two separate StateEffects and two separate fields, so the word mark is drawn
 * over the sentence mark instead of replacing it. One field with one effect
 * cannot express that: assigning the decoration set is what made the word
 * highlight erase the sentence within a frame, which is the defect NRL-54 was
 * opened for. The effect is dispatched on every chunk and every word change
 * during playback, which is why each field does as little as possible: one
 * range in, one mark out.
 *
 * Since NRL-72 this module dispatches three kinds of effect, not two: the two
 * decoration effects, and an `EditorView.scrollIntoView` effect that
 * repositions the VIEWPORT. That third one rides in the same dispatch as the
 * other two, never in a transaction of its own, so no frame can show the two
 * layers and the viewport disagreeing with each other. It is also gated on a
 * layer being drawn at all: see `scrollTargetForChunk` below.
 *
 * What that costs, and what survives, stated exactly because this file used to
 * claim the stronger property and ADR 0020 quotes it. The cursor, the text
 * selection, the focused element and the undo history are still untouched:
 * these are effects on a transaction, not a selection change, and measured in
 * bare Node applying `EditorView.scrollIntoView(5)` leaves `state.selection`
 * byte-identical with `docChanged` false, the effect carrying a scroll target
 * rather than a `SelectionRange`. What is no longer promised is the user's
 * scroll position: moving it is the feature (docs/adr/0022). A manual scroll
 * made mid-read is overridden at the next sentence boundary; nothing here
 * detects one.
 *
 * Two layers means two ways to clear, and they are not interchangeable. Ending
 * playback clears both; moving to the next word clears only the word. A single
 * clear that dispatched one effect is how the first attempt at this ticket left
 * the last sentence highlighted forever after Stop, so the three clears below
 * are deliberately separate and none of them is an alias for another.
 */

export interface HighlightRange {
	from: number;
	to: number;
}

/** The highlight half of `Settings`, as much of it as the drawing rules need. */
export interface HighlightToggles {
	enabled: boolean;
	sentence: boolean;
	word: boolean;
}

/** Which layers may be drawn for a given settings and engine combination. */
export interface HighlightLayers {
	sentence: boolean;
	word: boolean;
}

/**
 * Which layers to draw, given the user's toggles and whether the active engine
 * can report word timings.
 *
 * Pure, and separate from the player event handlers, because the rule is the
 * part worth testing and `main.ts` cannot run in the bare-Node suite. The first
 * attempt at NRL-54 left this decision inline in two event handlers and said in
 * a test docstring that it was "verified during E2E testing", which nothing had
 * done.
 *
 * `hasWordTiming` is false both for an engine reporting `timing: "none"` and for
 * no resolved engine at all. The distinction does not matter here: neither can
 * produce a trustworthy word range.
 *
 * Note what does **not** gate the sentence: word timing. speech-dispatcher
 * reports no timings and never emits a word event, and the sentence highlight is
 * the only layer it can ever show, so letting a word-timing fact suppress the
 * sentence would blank the one engine that most needs it.
 */
export function highlightPlan(toggles: HighlightToggles, hasWordTiming: boolean): HighlightLayers {
	if (!toggles.enabled) return { sentence: false, word: false };
	return { sentence: toggles.sentence, word: toggles.word && hasWordTiming };
}

/**
 * The offset a chunk dispatch should bring into view, or `null` for no scroll.
 *
 * The scroll is a service to the highlight, not a feature of its own: this
 * ticket's purpose is to keep the playback highlight in view, so with no
 * highlight there is nothing to keep in view and moving the viewport of someone
 * who turned highlighting off is behaviour nobody asked for. Before this gate the
 * offset was passed unconditionally, and with `highlight.enabled` false the chunk
 * dispatch drew zero decoration ranges and still carried one scroll effect.
 *
 * The condition is the **disjunction** of the two layers, and each half of that
 * is load-bearing.
 *
 * `layers.word` has to be in it because "word drawn, sentence not" is a
 * reachable state, not a hypothetical: the master switch, the sentence row and
 * the word row are three independent toggles in `settingsTab.ts`, so
 * `{ enabled: true, sentence: false, word: true }` on an engine that reports
 * timings gives `{ sentence: false, word: true }`. The word mark then lands
 * inside this chunk a moment later, on the word event, and has to be on screen
 * for it. That is also why the plan is what is consulted rather than the ranges
 * in this one transaction: at chunk time `main.ts` always passes `word: null`,
 * because the word range is not known yet.
 *
 * And `layers.sentence` has to be able to carry the decision **alone**, with no
 * reference to word timing, for the reason ADR 0020 gives: an engine capability
 * may gate only the layer it names. speech-dispatcher reports no timings, so its
 * plan is `{ sentence: true, word: false }` and the sentence is the only layer it
 * can ever show. A gate that depended on the word row would leave the one engine
 * that most needs the viewport to follow playback without it.
 */
export function scrollTargetForChunk(layers: HighlightLayers, sourceStart: number): number | null {
	if (!layers.sentence && !layers.word) return null;
	return sourceStart;
}

/**
 * Whether a leaf that just became active should receive the playback
 * highlight and scroll (NRL-89).
 *
 * `readingInFlight` is passed in rather than computed here from a
 * `PlayerState` so this stays free of any dependency on audio/player.ts,
 * matching how `highlightLayers()` in main.ts already reduces engine
 * capabilities to a single boolean (`hasWordTiming`) before calling
 * `highlightPlan`. `readingFilePath` alone cannot answer this: Player.
 * getFilePath() is deliberately not cleared by stop() (player.ts:147-171),
 * so a finished or stopped read still names its note by path long after
 * nothing is in flight - without the `readingInFlight` gate, switching
 * back to a note whose reading already ended would re-arm its highlight.
 */
export function shouldHighlightLeaf(
	activeFilePath: string | null,
	readingFilePath: string,
	readingInFlight: boolean,
): boolean {
	return readingInFlight && readingFilePath !== "" && activeFilePath === readingFilePath;
}

export const setSentenceHighlight = StateEffect.define<HighlightRange | null>();
export const setWordHighlight = StateEffect.define<HighlightRange | null>();

const sentenceDecoration = Decoration.mark({ class: "local-tts-reader-sentence" });
const wordDecoration = Decoration.mark({ class: "local-tts-reader-word" });

export const sentenceHighlightField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(deco, tr) {
		// Keep existing marks in the right place if the document was edited.
		let next = tr.docChanged ? deco.map(tr.changes) : deco;

		for (const effect of tr.effects) {
			if (!effect.is(setSentenceHighlight)) continue;
			const range = effect.value;
			if (!range || range.from >= range.to) {
				next = Decoration.none;
				continue;
			}
			const clampedTo = Math.min(range.to, tr.state.doc.length);
			if (range.from >= clampedTo) {
				next = Decoration.none;
				continue;
			}
			const builder = new RangeSetBuilder<Decoration>();
			builder.add(range.from, clampedTo, sentenceDecoration);
			next = builder.finish();
		}

		return next;
	},
	provide: (field) => EditorView.decorations.from(field),
});

export const wordHighlightField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(deco, tr) {
		// Keep existing marks in the right place if the document was edited.
		let next = tr.docChanged ? deco.map(tr.changes) : deco;

		for (const effect of tr.effects) {
			if (!effect.is(setWordHighlight)) continue;
			const range = effect.value;
			if (!range || range.from >= range.to) {
				next = Decoration.none;
				continue;
			}
			const clampedTo = Math.min(range.to, tr.state.doc.length);
			if (range.from >= clampedTo) {
				next = Decoration.none;
				continue;
			}
			const builder = new RangeSetBuilder<Decoration>();
			builder.add(range.from, clampedTo, wordDecoration);
			next = builder.finish();
		}

		return next;
	},
	provide: (field) => EditorView.decorations.from(field),
});

/** Register the fields on an editor. Safe to call more than once per editor. */
export function registerHighlighting(editor: EditorView): void {
	if (!editor.state.field(sentenceHighlightField, false)) {
		editor.dispatch({ effects: StateEffect.appendConfig.of(sentenceHighlightField) });
	}
	if (!editor.state.field(wordHighlightField, false)) {
		editor.dispatch({ effects: StateEffect.appendConfig.of(wordHighlightField) });
	}
}

export function applySentenceHighlight(editor: EditorView, range: HighlightRange | null): void {
	try {
		editor.dispatch({ effects: setSentenceHighlight.of(range) });
	} catch {
		// The editor can be torn down mid-playback; a dropped highlight is not
		// worth interrupting reading over.
	}
}

export function applyWordHighlight(editor: EditorView, range: HighlightRange | null): void {
	try {
		editor.dispatch({ effects: setWordHighlight.of(range) });
	} catch {
		// The editor can be torn down mid-playback; a dropped highlight is not
		// worth interrupting reading over.
	}
}

/**
 * Set both layers at once, in a single transaction, and optionally bring an
 * offset into view in that same transaction.
 *
 * Use this wherever both layers change together, so they cannot disagree for a
 * frame: advancing to a new sentence is the main one, since the new sentence
 * must arrive in the same transaction that retires the previous sentence's word
 * mark. `null` means "no mark on this layer".
 *
 * `scrollTo` is a third positional parameter rather than a key inside `layers`
 * on purpose. `layers` is named for the two decoration layers, and ADR 0020's
 * three clears are defined in terms of it; a viewport offset is not a layer,
 * and keeping it out is what stops `clearHighlights` ever being read as "clear
 * and also scroll". Omitting it is the pre-NRL-72 behaviour exactly, which is
 * what every other call site relies on.
 */
export function applyHighlightLayers(
	editor: EditorView,
	layers: { sentence: HighlightRange | null; word: HighlightRange | null },
	scrollTo?: number | null,
): void {
	try {
		const effects: StateEffect<unknown>[] = [
			setSentenceHighlight.of(layers.sentence),
			setWordHighlight.of(layers.word),
		];
		if (typeof scrollTo === "number" && Number.isFinite(scrollTo) && scrollTo >= 0) {
			// No options object, deliberately, so CodeMirror's own defaults
			// apply. Measured in bare Node against the vendored
			// @codemirror/view: `EditorView.scrollIntoView(5)` yields one
			// StateEffect whose value carries `range.head 5`, `y "nearest"`,
			// `x "nearest"`, `yMargin 5`. Under `y === "nearest"` the view
			// assigns a vertical movement only when the target rect falls
			// outside the visible box and gates the scroll on `moveX || moveY`,
			// so a target already in view moves by zero. That is the whole of
			// "no jump when the highlight is already visible", and it is the
			// library's behaviour rather than ours.
			//
			// Do NOT add a visibility test of our own. It would need
			// `coordsAtPos` and a real DOM, which the bare-Node suite cannot
			// build - `EditorView` is never instantiated in
			// tests/highlight.test.ts - so it would be untestable here and
			// would duplicate what `nearest` already does.
			//
			// Clamped for the same reason the two fields clamp `range.to`: a
			// stale offset from a document edited mid-read. Measured, an
			// out-of-range head does not throw at dispatch time, it rides
			// forward unchanged, so this is about scrolling somewhere wrong
			// rather than about a crash.
			effects.push(EditorView.scrollIntoView(Math.min(scrollTo, editor.state.doc.length)));
		}
		editor.dispatch({ effects });
	} catch {
		// The editor can be torn down mid-playback; a dropped highlight is not
		// worth interrupting reading over.
	}
}

/** Drop the word mark and leave the sentence alone. Use when the word advances. */
export function clearWordHighlight(editor: EditorView): void {
	applyWordHighlight(editor, null);
}

/** Drop the sentence mark and leave the word alone. */
export function clearSentenceHighlight(editor: EditorView): void {
	applySentenceHighlight(editor, null);
}

/**
 * Drop both marks, in one transaction.
 *
 * This is what the end of a reading needs, and it must stay separate from
 * `clearWordHighlight`. An `applyHighlight` alias pointing at the word clear
 * used to serve both jobs, so every Stop, error, sleep-timer expiry and natural
 * finish left the last sentence highlighted in the document: the sentence field
 * ignores a word effect, by design. One transaction rather than two so the two
 * layers never disagree for a frame.
 */
export function clearHighlights(editor: EditorView): void {
	applyHighlightLayers(editor, { sentence: null, word: null });
}
