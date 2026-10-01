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
 * scroll position: moving it is the feature (docs/adr/0022).
 *
 * Since NRL-90 (docs/adr/0030, amending 0022) a manual scroll made mid-read is
 * no longer overridden at the next sentence boundary unconditionally: a
 * `scrollDOM` listener distinguishes a user-caused scroll from the plugin's
 * own and suppresses further auto-scroll on that editor until playback
 * restarts. This is layered ALONGSIDE the two decoration layers, not folded
 * into them - `scrollSuppressed` and `expectingOwnScroll` below are keyed on
 * the editor, never on `sentenceHighlightField`/`wordHighlightField` state,
 * and suppressing the scroll never suppresses a decoration. See
 * `registerScrollSuppression`, `nextScrollSuppression` and the extended
 * `scrollTargetForChunk` below, and ADR 0030 for why the own-vs-user
 * detection is a heuristic. It is no longer an unobserved one - a real
 * gesture's native 'scroll' events were measured latching suppression on an
 * Android device - but its event-ORDERING premise is still untested and
 * desktop is unobserved; see `registerScrollSuppression`'s own note.
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
 *
 * `suppressed` is a third REQUIRED parameter, added by NRL-90 (ADR 0030), not
 * optional or defaulted. Required so `tsc` fails every call site that does not
 * yet know about suppression rather than silently keeping the old
 * always-scroll behaviour - the same reasoning CONTEXT.md gives for
 * `lastHtmlCloser` becoming a required parameter through `cleanLine`, and for
 * `RunResult.signal` becoming required in NRL-55. Before this parameter
 * existed, a chunk dispatch scrolled unconditionally on every chunk event
 * regardless of any prior manual scroll - there was no way to express "a
 * manual scroll happened" at all, which is acceptance criterion 5 of NRL-90
 * made concrete. Checked ahead of the layer disjunction, so a suppressed
 * editor never scrolls even when a layer is drawn.
 */
export function scrollTargetForChunk(
	layers: HighlightLayers,
	sourceStart: number,
	suppressed: boolean,
): number | null {
	if (suppressed) return null;
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

/**
 * NRL-90: the whole scroll-suppression state machine, pure.
 *
 * `currentlySuppressed` is the existing per-editor suppression flag;
 * `isUserScroll` is true only when a `scrollDOM` 'scroll' event was
 * determined NOT to be one `applyHighlightLayers` itself caused (see
 * `registerScrollSuppression`). Suppression latches: once true it stays true
 * until an explicit `resetScrollSuppression` call, which is a separate
 * function and not an input here, because "reset" and "no user scroll seen"
 * are different facts - conflating them would let a later `false` argument
 * silently un-suppress, which is not the policy (docs/adr/0030: suppression
 * lapses only when playback restarts).
 *
 * Written as two explicit branches rather than the one-line
 * `currentlySuppressed || isUserScroll` it is logically equal to, matching
 * this file's own style for `highlightPlan` and `scrollTargetForChunk`: a
 * later third state is then a visible new branch, not a silent behaviour
 * change dressed as a refactor.
 */
export function nextScrollSuppression(currentlySuppressed: boolean, isUserScroll: boolean): boolean {
	if (currentlySuppressed) return true;
	if (isUserScroll) return true;
	return false;
}

/**
 * NRL-90: whether the NEXT `scrollDOM` 'scroll' event on this editor is one
 * `applyHighlightLayers` itself is about to cause, so the listener in
 * `registerScrollSuppression` can tell it apart from a genuine user scroll.
 *
 * A read-and-clear flag rather than a timer, deliberately: the native
 * 'scroll' event this plugin's own `EditorView.scrollIntoView` effect
 * produces carries no origin of its own, and a flag consumed by whichever
 * 'scroll' event fires next needs no millisecond constant to tune. This is
 * the same "no arbitrary tuning constant" preference the suppression
 * LIFETIME already follows (NRL-90's clarification), applied to the
 * detection mechanism too.
 *
 * Armed inside `applyHighlightLayers`, immediately before the dispatch, and
 * only on the branch that is actually pushing a scroll effect - a chunk
 * dispatch with no scroll target must never arm this, or the next genuine
 * user scroll would be silently swallowed as "our own".
 */
const expectingOwnScroll = new WeakMap<EditorView, boolean>();

/**
 * NRL-90: whether auto-scroll is currently suppressed on this editor because
 * a user scroll was observed since the last read start. Absent (never set)
 * reads as not suppressed. Lives here, not on `Player`: `Player` does not
 * know about the editor (CONTEXT.md; `player.ts` `play()` takes no editor
 * parameter), and this is exactly the kind of editor-keyed UI state
 * `sentenceHighlightField`/`wordHighlightField` already keep out of it.
 */
const scrollSuppressed = new WeakMap<EditorView, boolean>();

/**
 * NRL-90: editors that already have the `scrollDOM` listener attached.
 * `registerScrollSuppression` must be safe to call more than once per editor,
 * the same contract `registerHighlighting` states for itself, but a native
 * DOM listener has no CM6 state-field to introspect for that check, so a
 * WeakSet stands in for it.
 */
const scrollListenerAttached = new WeakSet<EditorView>();

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

/**
 * NRL-90: attach the `scrollDOM` listener that detects a genuine user scroll
 * on this editor and suppresses further auto-scroll on it until playback
 * restarts (`resetScrollSuppression`). Safe to call more than once per
 * editor, deduped via `scrollListenerAttached` since a native DOM listener
 * has no CM6 config to check idempotently the way `registerHighlighting`
 * checks `editor.state.field(..., false)`.
 *
 * The listener reads-and-clears `expectingOwnScroll`: a true value means
 * this 'scroll' event is the one `applyHighlightLayers` itself just caused,
 * so it is consumed and nothing else happens; false or absent means a scroll
 * happened that the plugin did not cause, fed into `nextScrollSuppression`
 * as `isUserScroll`.
 *
 * STILL A HEURISTIC, but no longer an unobserved one, and this paragraph is
 * corrected rather than left standing (AGENTS.md rule 13; docs/adr/0030's
 * NRL-90 amendment). What has since been measured, on a real Android Obsidian:
 * a real touch gesture's own native 'scroll' events do reach this listener and
 * do latch suppression, and the viewport then stops tracking the read. What is
 * still NOT established is the part that decides the arm's correctness - the
 * ORDERING of a real 'scroll' event against CodeMirror's `requestAnimationFrame`
 * measure pass - because `tests/highlight.test.ts` invokes this handler directly
 * in the same task and never instantiates a real `EditorView`, and because
 * `main.ts` imports `obsidian` and has no bare-Node runtime, so the three
 * register/reset call sites are unexercised by `npm test`. Desktop is
 * unobserved entirely. The listener BODY does now have coverage, via that
 * suite's additive `scrollDOM` stub (block 19, checks 19h-19n), so the earlier
 * claim here that only the pure `nextScrollSuppression` was covered is false
 * and has been removed.
 */
export function registerScrollSuppression(editor: EditorView): void {
	if (scrollListenerAttached.has(editor)) return;
	scrollListenerAttached.add(editor);
	editor.scrollDOM.addEventListener("scroll", () => {
		const ownScroll = expectingOwnScroll.get(editor) ?? false;
		expectingOwnScroll.delete(editor);
		if (ownScroll) return;
		scrollSuppressed.set(editor, nextScrollSuppression(scrollSuppressed.get(editor) ?? false, true));
	});
}

/** NRL-90: whether auto-scroll is currently suppressed for this editor. */
export function isScrollSuppressed(editor: EditorView): boolean {
	return scrollSuppressed.get(editor) ?? false;
}

/**
 * NRL-90: end suppression - "playback restart" per the ticket's clarification.
 * Call at the same three read-start call sites `retargetHighlightEditor`
 * already resets state at (readActiveNote, readSelection, readFromCursor),
 * never on the NRL-89 leaf-reattach path: reattaching to a note whose read is
 * still in flight is not a fresh `play()` call, so a manual scroll made
 * before switching away and back must still be respected.
 *
 * `expectingOwnScroll` is cleared here too, and that is a fix rather than
 * tidiness (the NRL-90 follow-up, docs/adr/0030). `applyHighlightLayers` arms
 * that flag before every scrolling dispatch, but the dispatch does not always
 * move the DOM: `scrollRectIntoView` passes its `if (moveX || moveY)` gate
 * (node_modules/@codemirror/view/dist/index.js:200) and then has its
 * `cur.scrollTop += moveY / scaleY` write CLAMPED by the browser (:208-213),
 * and a `scrollTop` write that changes nothing fires no 'scroll' event. That is
 * the ordinary case at the opening of a read, where centring a chunk in the
 * first half-viewport would need a negative `scrollTop` - measured on a real
 * device at docs/adr/0022:245-249, chunks 0-4 holding `scrollTop` 0. So an arm
 * can be left set with no event to consume it, and without this line it
 * survived into the next read and swallowed the first genuine user scroll of
 * it, which contradicts this function's own claim to restore normal follow
 * behaviour.
 *
 * `.delete` rather than `.set(editor, false)`, matching the listener's own
 * read-and-clear at `registerScrollSuppression` and the WeakMap's documented
 * "absent reads as not expecting".
 */
export function resetScrollSuppression(editor: EditorView): void {
	scrollSuppressed.set(editor, false);
	expectingOwnScroll.delete(editor);
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
			// `{ y: "center" }` is NRL-110, replacing NRL-72's deliberate
			// no-options-object. Only `y` is passed, so `x` stays the
			// library's `"nearest"`: read in the vendored
			// node_modules/@codemirror/view/dist/index.js, `ScrollTarget`'s
			// constructor (:2385) defaults `y` and `x` to `"nearest"` and
			// `yMargin`/`xMargin` to 5, so this yields one StateEffect
			// carrying `range.head`, `y "center"`, `x "nearest"`, `yMargin 5`.
			//
			// What this TRADES AWAY, on purpose. In `scrollRectIntoView` the
			// `y == "nearest"` branch (:163-174) assigns `moveY` only when the
			// target rect falls outside the bounding box, and the scroll is
			// gated on `if (moveX || moveY)` (:200) - that gate zeroing was the
			// whole of NRL-72's "no jump when the highlight is already
			// visible". The else branch (:175-181) instead computes
			// `moveY = targetTop - bounding.top` unconditionally, and for
			// `y == "center"` with `rectHeight <= boundingHeight` `targetTop`
			// centres the rect, so the gate almost never zeroes and a chunk
			// event now scrolls even when the sentence is already on screen.
			// That property is given up knowingly: measured on a real Android
			// Obsidian (448x997 viewport) under `"nearest"`, the spoken
			// sentence's top sat at 973px of a 997px editor on EVERY chunk from
			// the eleventh onward - flush with the bottom edge with nothing
			// below it - because `"nearest"` moves the target the minimum
			// distance into the box and a downward read always arrives at the
			// bottom. Centring is the reported fix; the cost is that the view
			// moves once per sentence rather than only when it has to.
			//
			// Do NOT pass a `yMargin` here: the `center` arm of :177 does not
			// read it, so it would be dead config.
			//
			// Still no visibility test of our own, but no longer because
			// `nearest` does it for us - it does not, on this path. It needs
			// `coordsAtPos` and a real DOM, and `EditorView` is never
			// instantiated in tests/highlight.test.ts, so a visibility test
			// written here would be wholly untestable in the bare-Node suite.
			// Suppressing the scroll when the user has scrolled by hand is a
			// different mechanism and lives in `nextScrollSuppression`.
			//
			// Clamped for the same reason the two fields clamp `range.to`: a
			// stale offset from a document edited mid-read. Measured, an
			// out-of-range head does not throw at dispatch time, it rides
			// forward unchanged, so this is about scrolling somewhere wrong
			// rather than about a crash.
			effects.push(
				EditorView.scrollIntoView(Math.min(scrollTo, editor.state.doc.length), { y: "center" }),
			);
			// NRL-90: arm the read-and-clear flag ONLY on this branch, right
			// before the dispatch that will cause the native 'scroll' event -
			// a chunk dispatch with no scroll target must never arm it, or a
			// genuine user scroll arriving later would be misattributed as
			// our own the next time this branch runs.
			expectingOwnScroll.set(editor, true);
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
