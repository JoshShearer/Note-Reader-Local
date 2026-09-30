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
 * opened for. A decoration rather than a selection change, so it cannot disturb
 * the cursor, the undo history, or the user's place in the document. The effect
 * is dispatched on every chunk and every word change during playback, which is
 * why each field does as little as possible: one range in, one mark out.
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
 * Set both layers at once, in a single transaction.
 *
 * Use this wherever both layers change together, so they cannot disagree for a
 * frame: advancing to a new sentence is the main one, since the new sentence
 * must arrive in the same transaction that retires the previous sentence's word
 * mark. `null` means "no mark on this layer".
 */
export function applyHighlightLayers(
	editor: EditorView,
	layers: { sentence: HighlightRange | null; word: HighlightRange | null },
): void {
	try {
		editor.dispatch({
			effects: [setSentenceHighlight.of(layers.sentence), setWordHighlight.of(layers.word)],
		});
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
