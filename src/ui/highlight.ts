import { StateEffect, StateField } from "@codemirror/state";
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";

/**
 * Word highlighting as a CodeMirror 6 decoration.
 *
 * A decoration rather than a selection change, so it cannot disturb the
 * cursor, the undo history, or the user's place in the document. The effect is
 * dispatched on every word change during playback, which is why the state
 * field does as little as possible: one range in, one mark out.
 */

export interface HighlightRange {
	from: number;
	to: number;
}

export const setHighlight = StateEffect.define<HighlightRange | null>();

export const highlightField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(deco, tr) {
		// Keep existing marks in the right place if the document was edited.
		let next = tr.docChanged ? deco.map(tr.changes) : deco;

		for (const effect of tr.effects) {
			if (!effect.is(setHighlight)) continue;
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
			builder.add(range.from, clampedTo, Decoration.mark({ class: "local-tts-reader-word" }));
			next = builder.finish();
		}

		return next;
	},
	provide: (field) => EditorView.decorations.from(field),
});

/** Register the field on an editor. Safe to call more than once per editor. */
export function registerHighlighting(editor: EditorView): void {
	if (!editor.state.field(highlightField, false)) {
		editor.dispatch({ effects: StateEffect.appendConfig.of(highlightField) });
	}
}

export function applyHighlight(editor: EditorView, range: HighlightRange | null): void {
	try {
		editor.dispatch({ effects: setHighlight.of(range) });
	} catch {
		// The editor can be torn down mid-playback; a dropped highlight is not
		// worth interrupting reading over.
	}
}
