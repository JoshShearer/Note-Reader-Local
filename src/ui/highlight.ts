import { StateEffect, StateField } from "@codemirror/state";
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";

/**
 * Sentence and word highlighting as CodeMirror 6 decorations.
 *
 * Two separate StateEffects and fields so sentence and word can be toggled
 * independently and styled with distinct CSS classes. A decoration rather than
 * a selection change, so it cannot disturb the cursor, the undo history, or the
 * user's place in the document. The effect is dispatched on every chunk/word
 * change during playback, which is why the state field does as little as
 * possible: one range in, one mark out.
 */

export interface HighlightRange {
	from: number;
	to: number;
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

// Backwards compatibility: applyHighlight now applies word highlight
export const applyHighlight = applyWordHighlight;
