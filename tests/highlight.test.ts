/**
 * Sentence and word highlighting.
 *
 * The three cases NRL-54 asked for are the first three below, and they are
 * driven against the real CodeMirror StateFields rather than described: a
 * settings round-trip cannot tell you whether a mark survived, and the first
 * attempt at this ticket shipped with a leak that only a real field exposes.
 *
 * `@codemirror/state` and `@codemirror/view` are resolved transitively through
 * `obsidian` and left external by build-tests.mjs, the same way `src/ui/
 * highlight.ts` already imports them. Only `EditorState` is constructed here;
 * `EditorView` needs a DOM and is never instantiated.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { EditorState } from "@codemirror/state";
import type { Transaction } from "@codemirror/state";
import {
	sentenceHighlightField,
	wordHighlightField,
	setSentenceHighlight,
	setWordHighlight,
	applySentenceHighlight,
	applyWordHighlight,
	applyHighlightLayers,
	clearHighlights,
	clearSentenceHighlight,
	clearWordHighlight,
	highlightPlan,
	nextScrollSuppression,
	scrollTargetForChunk,
	shouldHighlightLeaf,
	registerScrollSuppression,
	resetScrollSuppression,
	isScrollSuppressed,
} from "../src/ui/highlight.ts";
import type { HighlightLayers, HighlightToggles } from "../src/ui/highlight.ts";
import {
	SENTENCE_HIGHLIGHT_VAR,
	WORD_HIGHLIGHT_VAR,
	applySentenceHighlightColour,
} from "../src/ui/highlightColour.ts";
import { DEFAULT_SETTINGS, normaliseSettings } from "../src/settings/index.ts";
import { controlAffordances } from "../src/ui/affordances.ts";
import type { EngineCapabilities } from "../src/audio/types.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
	if (cond) console.log(`  ok   ${name}`);
	else {
		failures += 1;
		console.log(`  FAIL ${name} ${detail}`);
	}
}

const DOC = "Alpha beta gamma. Delta epsilon zeta.";

function fresh(): EditorState {
	return EditorState.create({ doc: DOC, extensions: [sentenceHighlightField, wordHighlightField] });
}

/** Every mark currently decorating `state`, as `class[from,to]`, sentence field first. */
function marks(state: EditorState): string[] {
	const out: string[] = [];
	for (const field of [sentenceHighlightField, wordHighlightField]) {
		const iter = state.field(field).iter();
		while (iter.value) {
			out.push(`${(iter.value.spec as { class: string }).class}[${iter.from},${iter.to}]`);
			iter.next();
		}
	}
	return out;
}

const caps = (timing: EngineCapabilities["timing"]): EngineCapabilities =>
	({
		voices: true,
		timing,
		rate: true,
		pitch: true,
		desktopOnly: false,
		pause: true,
		resume: true,
		sentenceBoundary: false,
	}) as EngineCapabilities;

// --- NRL-54 criterion: sentence range applied from chunk offsets -----------

console.log("1. Sentence range comes from the chunk's source offsets");
{
	// The offsets a SpeechChunk would carry for "Alpha beta gamma."
	const chunk = { sourceStart: 0, sourceEnd: 17 };
	const state = fresh().update({ effects: setSentenceHighlight.of({ from: chunk.sourceStart, to: chunk.sourceEnd }) }).state;
	check("one sentence mark, spanning exactly the chunk", marks(state).join() === "local-tts-reader-sentence[0,17]", marks(state).join());

	// Second sentence: the mark moves rather than accumulating.
	const next = state.update({ effects: setSentenceHighlight.of({ from: 18, to: 37 }) }).state;
	check("a new chunk replaces the previous sentence mark", marks(next).join() === "local-tts-reader-sentence[18,37]", marks(next).join());

	// Past the end of the document is clamped, not thrown.
	const over = fresh().update({ effects: setSentenceHighlight.of({ from: 30, to: 9999 }) }).state;
	check("a range past the document end is clamped", marks(over).join() === `local-tts-reader-sentence[30,${DOC.length}]`, marks(over).join());
}

// --- NRL-54 criterion: word layers on top rather than replacing ------------

console.log("2. The word mark layers over the sentence mark, it does not replace it");
{
	let state = fresh();
	state = state.update({ effects: setSentenceHighlight.of({ from: 0, to: 17 }) }).state;
	state = state.update({ effects: setWordHighlight.of({ from: 0, to: 5 }) }).state;
	check(
		"both marks present after a word effect",
		marks(state).join() === "local-tts-reader-sentence[0,17],local-tts-reader-word[0,5]",
		marks(state).join(),
	);

	// Advancing the word must not disturb the sentence.
	state = state.update({ effects: setWordHighlight.of({ from: 6, to: 10 }) }).state;
	check(
		"advancing the word leaves the sentence in place",
		marks(state).join() === "local-tts-reader-sentence[0,17],local-tts-reader-word[6,10]",
		marks(state).join(),
	);

	// The two classes must differ, or "layering" is invisible.
	check(
		"the two layers use different classes",
		new Set(marks(state).map((m) => m.split("[")[0])).size === 2,
		marks(state).join(),
	);
}

// --- NRL-54 criterion: timing "none" suppresses the word mark --------------

console.log('3. An engine reporting timing "none" draws no word mark');
{
	const all = { enabled: true, sentence: true, word: true };
	const withTiming = highlightPlan(all, true);
	const without = highlightPlan(all, false);
	check("word allowed when the engine reports timings", withTiming.word === true);
	check('word suppressed when the engine reports timing "none"', without.word === false);
	check('sentence still drawn when timing is "none"', without.sentence === true, JSON.stringify(without));

	// This is the speechd shape, and the sentence highlight is the whole reason
	// NRL-54 exists: it is the only layer that engine can ever show.
	const speechd = caps("none");
	check(
		"speechd-shaped capabilities still permit the sentence layer",
		highlightPlan(all, speechd.timing !== "none").sentence === true,
	);
}

// --- The leak the first attempt shipped -----------------------------------

/**
 * The smallest thing the apply/clear helpers use of an EditorView: `dispatch`,
 * and a `state` they read nothing from here. Backed by a real EditorState so the
 * fields actually run, which is the point - a recording spy would prove the
 * effect was sent but not that the mark went away.
 *
 * Each dispatch is also recorded, spec and resulting Transaction both, because
 * NRL-72's scroll effect is only observable on the transaction and the "one
 * transaction, not two" property is only observable as a count. Blocks 4 and 5
 * read none of that and are unaffected.
 *
 * NRL-90 added `scrollDOM` ADDITIVELY, so `registerScrollSuppression`'s
 * listener body gets its first coverage of any kind. It is a stub, not a DOM:
 * it records how many `scroll` listeners were attached (which is the only way
 * to observe the WeakSet dedupe the function's docstring claims) and keeps the
 * captured handlers so `fireScroll()` can invoke them directly. Invoking the
 * handler directly is NOT the same as a real browser `scroll` event - see the
 * amended KNOWN GAP at the end of block 19 for exactly what that still leaves
 * uncovered. No pre-NRL-90 check reads `scrollDOM`, `addCount` or
 * `fireScroll`, so blocks 4-18 are untouched by its presence.
 */
type DispatchSpec = Parameters<EditorState["update"]>[0];
function fakeEditor(initial: EditorState) {
	const scrollHandlers: (() => void)[] = [];
	let scrollListenerCount = 0;
	const editor = {
		state: initial,
		dispatched: [] as { spec: DispatchSpec; tr: Transaction }[],
		dispatch(spec: DispatchSpec) {
			const tr = editor.state.update(spec);
			editor.dispatched.push({ spec, tr });
			editor.state = tr.state;
		},
		scrollDOM: {
			addEventListener(type: string, fn: () => void) {
				if (type !== "scroll") return;
				scrollListenerCount += 1;
				scrollHandlers.push(fn);
			},
		},
		/** Invoke every captured 'scroll' handler once, modelling one scroll event. */
		fireScroll() {
			for (const fn of scrollHandlers) fn();
		},
		/** How many 'scroll' listeners `registerScrollSuppression` attached. */
		scrollListenerCount() {
			return scrollListenerCount;
		},
	};
	return editor as typeof editor & { state: EditorState };
}

/**
 * The scroll effect, identified STRUCTURALLY rather than by its effect type.
 *
 * `EditorView.scrollIntoView` wraps its position in a `ScrollTarget`, and
 * neither that class nor `StateEffect.type` is on `@codemirror/view`'s public
 * `.d.ts` export list, while `tsconfig.json` typechecks `tests/**\/*.ts` - so an
 * `e.is(...)` comparison against it would not compile. The filter is exact
 * anyway: `applyHighlightLayers` is the only dispatcher involved and its effects
 * array is fully known, so "not one of our two effects" names exactly one thing.
 */
type ScrollLike = { range?: { head: number }; y?: string; x?: string };
function scrollEffects(tr: Transaction): ScrollLike[] {
	return tr.effects
		.filter((e) => !e.is(setSentenceHighlight) && !e.is(setWordHighlight))
		.map((e) => e.value as ScrollLike);
}

console.log("4. clearHighlights() clears both layers");
{
	const editor = fakeEditor(fresh());
	applySentenceHighlight(editor as never, { from: 0, to: 17 });
	applyWordHighlight(editor as never, { from: 0, to: 5 });
	check("both layers set up", marks(editor.state).length === 2, marks(editor.state).join());

	// What main.ts calls on Stop, on error, on the sleep timer and on a natural
	// finish. Before the fix this was an alias for the word clear alone, so the
	// sentence mark stayed in the document for the rest of the session.
	clearHighlights(editor as never);
	check("no marks survive clearHighlights()", marks(editor.state).length === 0, marks(editor.state).join());
}

console.log("5. clearWordHighlight() must not touch the sentence layer");
{
	const editor = fakeEditor(fresh());
	applySentenceHighlight(editor as never, { from: 0, to: 17 });
	applyWordHighlight(editor as never, { from: 0, to: 5 });

	// The word handler calls this whenever the word toggle is off or a payload is
	// missing. If it cleared both, turning words off would blank the sentence
	// highlight on every word event - the coupling NRL-54 exists to remove.
	clearWordHighlight(editor as never);
	check(
		"the sentence mark survives a word clear",
		marks(editor.state).join() === "local-tts-reader-sentence[0,17]",
		marks(editor.state).join(),
	);

	// And the mirror image, so neither clear is secretly the other.
	applyWordHighlight(editor as never, { from: 6, to: 10 });
	clearSentenceHighlight(editor as never);
	check(
		"the word mark survives a sentence clear",
		marks(editor.state).join() === "local-tts-reader-word[6,10]",
		marks(editor.state).join(),
	);
}

console.log("6. The two settings are independent of each other");
{
	check("word off leaves the sentence on", highlightPlan({ enabled: true, sentence: true, word: false }, true).sentence === true);
	check("sentence off leaves the word on", highlightPlan({ enabled: true, sentence: false, word: true }, true).word === true);
	check("the master switch turns both off", (() => {
		const p = highlightPlan({ enabled: false, sentence: true, word: true }, true);
		return !p.sentence && !p.word;
	})());
}

// --- The speechd reachability bug NRL-54 names ----------------------------

console.log("7. A word-timing fact never makes the sentence highlight unreachable");
{
	const a = controlAffordances(caps("none"), "speech-dispatcher");
	// `highlightToggle` is the WORD gate: its own limitation text is "no word
	// highlighting". It must stay gated, so the word toggle is still disabled.
	check("the word toggle is still gated on timing", !a.highlightToggle.enabled);

	// And the sentence layer must remain drawable, so the settings tab has
	// something to offer. If a stored master `false` could not be undone the
	// user would be stuck with no highlight at all on this engine.
	const stored = normaliseSettings({ highlight: { enabled: false, color: "" } });
	check("a stored master false is still readable", stored.highlight.enabled === false);
	check(
		"and re-enabling it restores the sentence layer",
		highlightPlan({ ...stored.highlight, enabled: true }, false).sentence === true,
	);
}

// --- Settings normalisation ------------------------------------------------

console.log("8. Settings round-trip preserves both toggles");
{
	const a = normaliseSettings({ ...DEFAULT_SETTINGS, highlight: { ...DEFAULT_SETTINGS.highlight, sentence: false, word: true } });
	check("sentence preserved as false", a.highlight.sentence === false);
	check("word preserved as true", a.highlight.word === true);
	const b = normaliseSettings({ ...DEFAULT_SETTINGS, highlight: { ...DEFAULT_SETTINGS.highlight, sentence: true, word: false } });
	check("sentence preserved as true", b.highlight.sentence === true);
	check("word preserved as false", b.highlight.word === false);

	for (const combo of [
		{ sentence: true, word: true },
		{ sentence: true, word: false },
		{ sentence: false, word: true },
		{ sentence: false, word: false },
	]) {
		const s = normaliseSettings({ highlight: { enabled: true, ...combo, color: "" } });
		check(
			`round-trips sentence=${combo.sentence} word=${combo.word}`,
			s.highlight.sentence === combo.sentence && s.highlight.word === combo.word,
			JSON.stringify(s.highlight),
		);
	}
}

console.log("9. Non-negotiable 10: unknown keys inside highlight survive");
{
	const s = normaliseSettings({
		highlight: { enabled: true, sentence: true, word: false, color: "#aabbcc", futureKey: "keep-this" },
	}) as unknown as { highlight: Record<string, unknown> };
	check("unknown key survives", s.highlight.futureKey === "keep-this", JSON.stringify(s.highlight));
	check("known keys still validated", s.highlight.sentence === true && s.highlight.word === false);
}

console.log("10. Defaults, missing keys and invalid values");
{
	check("sentence defaults on", DEFAULT_SETTINGS.highlight.sentence === true);
	check("word defaults on", DEFAULT_SETTINGS.highlight.word === true);
	check("enabled defaults on", DEFAULT_SETTINGS.highlight.enabled === true);

	// Data written before this change carries neither key.
	const old = normaliseSettings({ highlight: { enabled: false, color: "#ff0000" } });
	check("missing sentence takes the default", old.highlight.sentence === true);
	check("missing word takes the default", old.highlight.word === true);
	check("enabled preserved", old.highlight.enabled === false);
	check("colour preserved", old.highlight.color === "#ff0000");

	const bad = normaliseSettings({
		highlight: { enabled: true, sentence: "not a boolean", word: null, color: "" },
	});
	check("invalid sentence takes the default", bad.highlight.sentence === true);
	check("invalid word takes the default", bad.highlight.word === true);
}

// --- The distinction itself, which no other suite asserts -----------------

/*
 * styles.css is the whole mechanism by which the two layers are tellable apart,
 * and nothing else in the 20 suites reads a byte of it. Without these checks
 * someone "tidying" the two rules into one shared block reproduces the exact
 * defect this ticket exists to fix, with a fully green suite - which is how the
 * defect got here the first time.
 */
// The bundle runs from tests/.build/, so the repo root is two levels up, the
// same as tests/release.test.ts.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CSS = fs.readFileSync(path.join(REPO, "styles.css"), "utf-8");

function ruleBody(selector: string): string {
	const m = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(CSS);
	return m?.[1] ?? "";
}
function declaredProps(selector: string): Set<string> {
	const names: string[] = [];
	for (const decl of ruleBody(selector).split(";")) {
		const line = decl.trim();
		if (!line.includes(":") || line.startsWith("/*")) continue;
		const name = line.split(":")[0]?.trim();
		if (name) names.push(name);
	}
	return new Set(names);
}

console.log("11. The two layers are visually distinct in styles.css");
{
	const sentence = declaredProps(".local-tts-reader-sentence");
	const word = declaredProps(".local-tts-reader-word");
	check("a .local-tts-reader-sentence rule exists", sentence.size > 0);
	check("a .local-tts-reader-word rule exists", word.size > 0);

	// Colour cannot be the difference: both vars fall back to the same theme
	// value and main.ts feeds both from the one stored highlight.color. So the
	// two rules must differ in what they declare, not just in the var they name.
	check(
		"the two rules do not declare the same property set",
		sentence.size !== word.size || [...sentence].some((p) => !word.has(p)),
		`sentence=${[...sentence].sort()} word=${[...word].sort()}`,
	);
	check(
		"only one layer fills a background, so the other stays visible under it",
		sentence.has("background-color") !== word.has("background-color"),
		`sentence=${[...sentence].sort()} word=${[...word].sort()}`,
	);

	// Chrome 88 is the floor (Obsidian's Android WebView, SPIKE-ANDROID-001).
	// color-mix() and relative colour syntax compute to nothing there rather
	// than degrading, which would silently blank a layer on mobile only.
	check("no color-mix() in the highlight rules", !/color-mix\(/.test(ruleBody(".local-tts-reader-sentence") + ruleBody(".local-tts-reader-word")));
}

console.log("12. Each layer's CSS var matches the name highlightColour.ts writes");
{
	check("sentence var name", SENTENCE_HIGHLIGHT_VAR === "--local-tts-reader-sentence-highlight", SENTENCE_HIGHLIGHT_VAR);
	check("word var name", WORD_HIGHLIGHT_VAR === "--local-tts-reader-word-highlight", WORD_HIGHLIGHT_VAR);

	// A one-character divergence between the constant and the stylesheet would
	// silently produce no colour at all, and no other test would move.
	check(`styles.css reads ${SENTENCE_HIGHLIGHT_VAR}`, CSS.includes(`var(${SENTENCE_HIGHLIGHT_VAR},`));
	check(`styles.css reads ${WORD_HIGHLIGHT_VAR}`, CSS.includes(`var(${WORD_HIGHLIGHT_VAR},`));
	check("both fall back to the theme's own highlight", (CSS.match(/var\(--text-highlight-bg\)/g) ?? []).length >= 2);
}

console.log("13. applySentenceHighlightColour writes and clears its own property");
{
	const props = new Map<string, string>();
	const style = {
		setProperty: (k: string, v: string) => void props.set(k, v),
		removeProperty: (k: string) => void props.delete(k),
	};
	applySentenceHighlightColour(style as never, "#ff0000");
	check("a stored colour is written", props.get(SENTENCE_HIGHLIGHT_VAR) === "#ff0000", JSON.stringify([...props]));
	check("and only its own property", !props.has(WORD_HIGHLIGHT_VAR));

	// Empty means follow the theme, which is done by removing the property so
	// the fallback in styles.css is the single source of the theme colour.
	applySentenceHighlightColour(style as never, "");
	check("empty removes the property rather than setting a value", !props.has(SENTENCE_HIGHLIGHT_VAR), JSON.stringify([...props]));
}

// --- NRL-72: the viewport follows the sentence (ADR 0022) ------------------

/*
 * This is a FEATURE, not a defect, so there is nothing here to reproduce. The
 * fail-first demonstration is narrower and is labelled as such: 14a, 14b, 14c,
 * 14e and 14f are red against the pre-NRL-72 code, which dispatches no scroll
 * effect of any kind, so they are evidence of NEW CAPABILITY rather than of a
 * bug. Everything named GUARD below is green on both sides of the change and is
 * not counted toward that total - it exists to stop a later edit taking the
 * scroll somewhere it must not go.
 */

console.log("14. NRL-72: the chunk dispatch scrolls to the chunk's sourceStart");
{
	const editor = fakeEditor(fresh());
	applyHighlightLayers(editor as never, { sentence: { from: 18, to: 37 }, word: null }, 18);

	const tr = editor.dispatched[0]!.tr;
	check("14a the dispatch carries three effects, not two", tr.effects.length === 3, `${tr.effects.length}`);

	const scrolls = scrollEffects(tr);
	check("14b exactly one scroll effect, targeting the chunk's sourceStart", scrolls.length === 1 && scrolls[0]?.range?.head === 18, JSON.stringify(scrolls));

	// REPLACED IN PLACE by NRL-110, keeping the 14c slot and ordinal (the
	// NRL-66/NRL-67 convention) so the behaviour can only change deliberately.
	// It used to assert `y === "nearest"` on both axes and read "the scroll uses
	// CodeMirror's nearest defaults"; it was the ONE check in the suite that
	// went red for NRL-110, and the whole of the fail-first evidence for it.
	//
	// Three things this records. `y: "center"` is NRL-110's deliberate
	// behaviour change away from NRL-72's `"nearest"` AND away from the
	// zero-movement property that `"nearest"` bought: measured on a real
	// Android Obsidian, `"nearest"` parked the spoken sentence's top at 973px
	// of a 997px viewport on every chunk from the eleventh onward - flush with
	// the bottom edge, nothing below it - which is the defect. `x` MUST stay
	// `"nearest"`, so a later edit cannot start yanking the view horizontally
	// on every sentence; only the y strategy was in scope. And `yMargin` is
	// still deliberately not asserted, now for a stronger reason than "a
	// library default we do not own": the vendored `center` branch never reads
	// it at all, so asserting it would pin dead config.
	check("14c the scroll centres the sentence vertically and leaves the horizontal axis to CodeMirror", scrolls[0]?.y === "center" && scrolls[0]?.x === "nearest", JSON.stringify(scrolls[0]));

	check("14d GUARD the scroll effect leaves the decoration layers alone", marks(editor.state).join() === "local-tts-reader-sentence[18,37]", marks(editor.state).join());

	// One transaction, not two. Two would give CodeMirror a legal intermediate
	// state in which the previous sentence's word mark is still lit, which is
	// the one-frame disagreement ADR 0020 exists to prevent.
	//
	// GUARD, not evidence, and the plan predicted otherwise: it expected this
	// to be red pre-NRL-72 and it was measured green, because the old code also
	// dispatched exactly one transaction - it simply put no scroll in it. The
	// count alone therefore cannot tell the two versions apart. Conjoining it
	// with 14a would manufacture a red out of a check that constrains nothing
	// on its own, so it is relabelled rather than strengthened. Post-change it
	// does constrain: it is what forbids a second dispatch for the scroll.
	check("14e GUARD one transaction carries both layers and the scroll", editor.dispatched.length === 1, `${editor.dispatched.length}`);

	// 14h GUARD, added by NRL-110 and green on both sides of its change, so it
	// is not counted as evidence for anything. 14a only counts three effects
	// and 14e only counts one transaction; neither pins identity AND order, so
	// a tidy-up could move the scroll into a second dispatch or push it ahead
	// of a decoration effect while both stayed green. A second dispatch is the
	// legal intermediate state ADR 0020 and NRL-54 exist to prevent, and the
	// scroll riding last is what makes "a third effect in the same dispatch"
	// mean something.
	check(
		"14h GUARD the one dispatch carries sentence, then word, then exactly one scroll",
		tr.effects[0]!.is(setSentenceHighlight) &&
			tr.effects[1]!.is(setWordHighlight) &&
			scrollEffects(tr).length === 1 &&
			editor.dispatched.length === 1,
		JSON.stringify({
			zero: tr.effects[0]!.is(setSentenceHighlight),
			one: tr.effects[1]!.is(setWordHighlight),
			scrolls: scrollEffects(tr).length,
			dispatches: editor.dispatched.length,
		}),
	);
}
{
	// A stale offset from a document edited mid-read is the real case. An
	// unclamped head does not throw at dispatch time - measured, it rides
	// forward as `range.head 9999` - so this is about scrolling somewhere
	// wrong, not about a crash.
	const editor = fakeEditor(fresh());
	applyHighlightLayers(editor as never, { sentence: null, word: null }, 9999);
	const scrolls = scrollEffects(editor.dispatched[0]!.tr);
	check("14f an offset past the document end is clamped to its length", scrolls[0]?.range?.head === DOC.length, JSON.stringify(scrolls));
}
{
	// Every pre-existing call site omits the parameter, clearHighlights among
	// them, and must be behaviourally byte-unchanged.
	const editor = fakeEditor(fresh());
	applyHighlightLayers(editor as never, { sentence: null, word: null });
	const tr = editor.dispatched[0]!.tr;
	check("14g GUARD omitting the offset dispatches the two layer effects and nothing else", tr.effects.length === 2 && scrollEffects(tr).length === 0, `${tr.effects.length}`);
}

console.log("15. GUARDS: the scroll moves the viewport, never the cursor or the document");
{
	/*
	 * All four are green before NRL-72 too, because the old code dispatched no
	 * scroll at all. They are not evidence of the feature. They forbid the
	 * wrong implementation: a `dispatch({ selection, scrollIntoView: true })`
	 * would put the highlight on screen and move the user's cursor to do it.
	 */
	const editor = fakeEditor(fresh());
	const before = JSON.stringify(editor.state.selection.toJSON());
	applyHighlightLayers(editor as never, { sentence: { from: 18, to: 37 }, word: null }, 18);
	const { spec, tr } = editor.dispatched[0]!;

	check("15a GUARD the selection is byte-identical after the scrolling dispatch", JSON.stringify(tr.state.selection.toJSON()) === before, JSON.stringify(tr.state.selection.toJSON()));
	check("15b GUARD the scrolling dispatch changes no document text", tr.docChanged === false);
	check("15c GUARD the dispatch spec carries no selection key", !("selection" in (spec as object)), JSON.stringify(Object.keys(spec as object)));
	check("15d GUARD the dispatch spec carries no changes key", !("changes" in (spec as object)), JSON.stringify(Object.keys(spec as object)));
}

console.log("16. GUARDS: only the chunk event scrolls, never a word tick or a clear");
{
	/*
	 * Green on both sides, again. The point is the pin: scrolling per word
	 * would override a manual mid-read scroll several times a second instead of
	 * once a sentence, and scrolling on the clear would yank the viewport at
	 * the moment the user pressed Stop.
	 */
	const editor = fakeEditor(fresh());
	applyWordHighlight(editor as never, { from: 0, to: 5 });
	const wordTr = editor.dispatched[0]!.tr;
	check("16a GUARD a word tick dispatches one effect and it is the word effect", wordTr.effects.length === 1 && wordTr.effects[0]!.is(setWordHighlight), `${wordTr.effects.length}`);

	clearHighlights(editor as never);
	const clearTr = editor.dispatched[1]!.tr;
	check("16b GUARD ending a reading dispatches two effects and no scroll", clearTr.effects.length === 2 && scrollEffects(clearTr).length === 0, `${clearTr.effects.length}`);

	// The settings-toggle redraw goes through applySentenceHighlight, which
	// gains no scroll parameter at all: a settings change is not playback
	// advancing, so flipping a toggle mid-read must not move the viewport.
	applySentenceHighlight(editor as never, { from: 0, to: 17 });
	const redrawTr = editor.dispatched[2]!.tr;
	check("16c GUARD a sentence-only redraw dispatches one effect and no scroll", redrawTr.effects.length === 1 && scrollEffects(redrawTr).length === 0, `${redrawTr.effects.length}`);
}

// --- NRL-72 F1: no layer drawn means no scroll (ADR 0022 decision 7) -------

console.log("17. NRL-72 F1: the scroll is gated on a layer being drawn");
{
	/*
	 * The defect: NRL-72 passed `chunk.sourceStart` unconditionally, so with
	 * highlighting switched off the chunk dispatch drew zero decoration ranges
	 * and still carried one scroll effect at head 18. Measured against
	 * `e8ec604` by staging the old unconditional expression in this same block:
	 * 17a and 17f red, the rest green. 17g is red there too, but for a
	 * different reason - the function did not exist - so it is labelled new
	 * capability rather than counted as a reproduction.
	 *
	 * `main.ts`'s chunk handler is TRANSCRIBED below, because `main.ts` imports
	 * `obsidian` and has no runtime in this suite. What is transcribed is the
	 * shape of the call and nothing else: `highlightPlan`,
	 * `scrollTargetForChunk` and `applyHighlightLayers` are all the real
	 * symbols, and `word: null` at chunk time is main.ts's own value, not a
	 * simplification - the word range is not known until the word event.
	 *
	 * `suppressed: false` is passed explicitly everywhere in this block
	 * (NRL-90 added the parameter after this block was written): these checks
	 * predate scroll suppression and must stay pinned to the unsuppressed
	 * behaviour they already assert. Block 19 covers the `suppressed: true`
	 * case this block deliberately does not touch.
	 */
	const chunk = { sourceStart: 18, sourceEnd: 37 };
	const chunkDispatch = (toggles: HighlightToggles, hasWordTiming: boolean) => {
		const editor = fakeEditor(fresh());
		const layers = highlightPlan(toggles, hasWordTiming);
		applyHighlightLayers(
			editor as never,
			{
				sentence: layers.sentence ? { from: chunk.sourceStart, to: chunk.sourceEnd } : null,
				word: null,
			},
			scrollTargetForChunk(layers, chunk.sourceStart, false),
		);
		return editor;
	};

	// The master switch off. Nothing can ever be drawn for this reading.
	const off = chunkDispatch({ enabled: false, sentence: true, word: true }, true);
	const offTr = off.dispatched[0]!.tr;
	check("17a highlighting disabled dispatches no scroll effect", scrollEffects(offTr).length === 0, JSON.stringify(scrollEffects(offTr)));
	// The premise of the finding, and green on both sides: the old code drew no
	// ranges either. It is here so 17a cannot be read as gating on something
	// other than "no highlight is drawn".
	check("17b GUARD highlighting disabled draws zero decoration ranges", marks(off.state).length === 0, marks(off.state).join());

	// Master on, both rows off. Also reachable, also nothing drawn.
	const bothRowsOff = chunkDispatch({ enabled: true, sentence: false, word: false }, true);
	check("17f both layer rows off dispatches no scroll effect", scrollEffects(bothRowsOff.dispatched[0]!.tr).length === 0, JSON.stringify(scrollEffects(bothRowsOff.dispatched[0]!.tr)));

	// The common case must not regress. Green on both sides by construction.
	const on = chunkDispatch({ enabled: true, sentence: true, word: true }, true);
	const onScrolls = scrollEffects(on.dispatched[0]!.tr);
	check("17c GUARD the default settings still scroll to the chunk's sourceStart", onScrolls.length === 1 && onScrolls[0]?.range?.head === 18, JSON.stringify(onScrolls));

	// speech-dispatcher: no word timings, so the sentence is the only layer it
	// can ever show. The gate must not consult the word row, or the one engine
	// that most needs this loses it (ADR 0020: a capability gates only its own
	// layer).
	const noTiming = chunkDispatch({ enabled: true, sentence: true, word: true }, false);
	const noTimingScrolls = scrollEffects(noTiming.dispatched[0]!.tr);
	check("17d GUARD an engine with no word timings still scrolls on the sentence", noTimingScrolls.length === 1 && noTimingScrolls[0]?.range?.head === 18, JSON.stringify(noTimingScrolls));
	check("17d2 GUARD and that plan really is sentence-only", JSON.stringify(highlightPlan({ enabled: true, sentence: true, word: true }, false)) === '{"sentence":true,"word":false}', JSON.stringify(highlightPlan({ enabled: true, sentence: true, word: true }, false)));

	// Word drawn, sentence not. Reachable: three independent toggles. The word
	// mark arrives inside this chunk on the next word event, so the viewport
	// has to follow even though this transaction draws nothing.
	const wordOnly = chunkDispatch({ enabled: true, sentence: false, word: true }, true);
	const wordOnlyScrolls = scrollEffects(wordOnly.dispatched[0]!.tr);
	check("17e GUARD a word-only plan still scrolls, though the chunk draws no range yet", wordOnlyScrolls.length === 1 && wordOnlyScrolls[0]?.range?.head === 18, JSON.stringify(wordOnlyScrolls));
	check("17e2 GUARD and that plan really is word-only", JSON.stringify(highlightPlan({ enabled: true, sentence: false, word: true }, true)) === '{"sentence":false,"word":true}', JSON.stringify(highlightPlan({ enabled: true, sentence: false, word: true }, true)));

	// The gate itself, over all four layer combinations. NEW CAPABILITY, not a
	// reproduction: this function did not exist before the fix.
	const table = [
		[{ sentence: false, word: false }, null],
		[{ sentence: true, word: false }, 18],
		[{ sentence: false, word: true }, 18],
		[{ sentence: true, word: true }, 18],
	] as const;
	const got = table.map(([layers]) => scrollTargetForChunk(layers, 18, false));
	const want = table.map(([, expected]) => expected);
	check("17g NEW scrollTargetForChunk is null only when neither layer is drawn", JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));

	// Zero is a real offset: the first chunk of a note starts there, and a
	// `!target` test would silently stop scrolling to the top of every note.
	check("17h GUARD sourceStart 0 is returned, not treated as absent", scrollTargetForChunk({ sentence: true, word: false }, 0, false) === 0, `${scrollTargetForChunk({ sentence: true, word: false }, 0, false)}`);
}

// --- NRL-89: a leaf-change must not decorate or scroll the wrong document --

console.log("18. NRL-89: a leaf only gets the playback highlight while its file matches the in-flight read");
{
	/*
	 * The defect: there was no leaf-change handler anywhere in the plugin, so
	 * switching notes mid-read left the chunk/word handlers' existing
	 * `if (!this.activeEditor) return;` guards pointed at whatever editor
	 * `retargetHighlightEditor` last touched - the note the read STARTED on,
	 * not the one in front. Before NRL-72 that drew a stale decoration on the
	 * wrong document; after NRL-72's viewport scroll the same path also moves
	 * that document, which is what made this worth a ticket of its own.
	 *
	 * `shouldHighlightLeaf` is the pure decision `handleActiveLeafChange` (in
	 * main.ts, which cannot run in this suite) consults before touching the
	 * editor. `readingFilePath` alone cannot answer it: `Player.getFilePath()`
	 * is deliberately not cleared by `stop()` (player.ts:147-171), so a
	 * finished or stopped read still names its note by path long after
	 * nothing is in flight - without `readingInFlight`, switching back to a
	 * note whose reading already ended would re-arm its highlight.
	 */
	check("match while in flight -> true", shouldHighlightLeaf("Notes/A.md", "Notes/A.md", true) === true);
	check("different file while in flight -> false", shouldHighlightLeaf("Notes/B.md", "Notes/A.md", true) === false);
	check("match but NOT in flight (finished/stopped read) -> false", shouldHighlightLeaf("Notes/A.md", "Notes/A.md", false) === false);
	check("non-markdown leaf (null active path) while in flight -> false", shouldHighlightLeaf(null, "Notes/A.md", true) === false);
	check("no read ever started (readingFilePath empty) -> false even if in flight", shouldHighlightLeaf("Notes/A.md", "", true) === false);
	check("neither in flight nor matching -> false", shouldHighlightLeaf("Notes/B.md", "Notes/A.md", false) === false);
}

// --- NRL-90: auto-scroll must not fight a manual scroll mid-read -----------

console.log("19. NRL-90: scroll suppression after a manual scroll, until playback restarts");
{
	/*
	 * DEFECT REPRODUCTION for `scrollTargetForChunk`.
	 *
	 * `oldScrollTargetForChunk` below is the function exactly as it existed
	 * before this ticket - a verbatim transcription of the two-parameter
	 * version, the same transcribe-old-vs-real-new technique the NRL-63/73/74
	 * family uses, chosen because there is no base commit to check out inside
	 * this test file and the point is to demonstrate the OLD shape had no way
	 * to express "a manual scroll happened", not to diff two commits.
	 *
	 * It returns a non-null scroll target regardless of any prior manual
	 * scroll, because the concept does not exist in its signature at all -
	 * this IS acceptance criterion 5 from the ticket's own description made
	 * concrete: "every chunk event scrolls unconditionally regardless of any
	 * prior manual scroll". Confirmed by direct code reading before this
	 * ticket touched the file (`src/ui/highlight.ts`, pre-NRL-90):
	 *
	 *   export function scrollTargetForChunk(layers: HighlightLayers, sourceStart: number): number | null {
	 *       if (!layers.sentence && !layers.word) return null;
	 *       return sourceStart;
	 *   }
	 *
	 * and confirmed by `grep -rn "suppress\|WeakMap\|scrollDOM" src/ui/highlight.ts src/main.ts`
	 * returning zero matches for any suppression mechanism anywhere in the
	 * codebase before this ticket's changes.
	 */
	function oldScrollTargetForChunk(layers: HighlightLayers, sourceStart: number): number | null {
		if (!layers.sentence && !layers.word) return null;
		return sourceStart;
	}
	const layers: HighlightLayers = { sentence: true, word: false };
	check(
		"REPRO: the pre-NRL-90 function always scrolls, with no way to express a manual scroll happened",
		oldScrollTargetForChunk(layers, 100) === 100,
		`${oldScrollTargetForChunk(layers, 100)}`,
	);

	// The real (fixed) three-arg export. `suppressed: true` MUST return no
	// scroll target - this is the check that fails before the fix, since
	// `oldScrollTargetForChunk` above has no third parameter to pass it to at
	// all and the real export did not accept one either until this ticket.
	check(
		"FIX: suppressed=true returns no scroll target even though a layer is drawn",
		scrollTargetForChunk(layers, 100, true) === null,
		`${scrollTargetForChunk(layers, 100, true)}`,
	);
	// GUARD: suppressed=false is byte-identical to the pre-fix behaviour above,
	// so a caller that never suppresses sees no change at all.
	check(
		"GUARD: suppressed=false still scrolls exactly as before",
		scrollTargetForChunk(layers, 100, false) === 100,
		`${scrollTargetForChunk(layers, 100, false)}`,
	);

	/*
	 * NEW CAPABILITY, pinned fail-safe (no prior function existed to fail):
	 * `nextScrollSuppression`'s whole state machine. No failing-before count
	 * is claimed for these four, consistent with how NRL-89's block 18 above
	 * was labelled - this function did not exist before this ticket, so
	 * there is nothing to reproduce.
	 *
	 * The four cases are the full 2x2 of (currently suppressed, user scroll
	 * observed now): a fresh editor with no user scroll stays clear; a user
	 * scroll observed while clear arms suppression; suppression already
	 * armed with no new user scroll stays armed (it latches - there is no
	 * "no scroll seen this tick" auto-clear); and the idempotent case of both
	 * true. `resetScrollSuppression` is the only way out, and it is not a
	 * `nextScrollSuppression` input at all - see the doc comment on the
	 * function for why conflating "reset" with "no user scroll" would be a
	 * different, wrong, policy.
	 */
	check("armed by programmatic scroll: not suppressed, no user scroll -> stays clear", nextScrollSuppression(false, false) === false);
	check("a user scroll while clear -> suppression latches on", nextScrollSuppression(false, true) === true);
	check("already suppressed, no new user scroll -> stays suppressed (latches, no auto-clear)", nextScrollSuppression(true, false) === true);
	check("already suppressed, another user scroll -> stays suppressed (idempotent)", nextScrollSuppression(true, true) === true);

	/*
	 * ----------------------------------------------------------------------
	 * NRL-90 follow-up (Q6): `registerScrollSuppression`'s LISTENER BODY,
	 * covered here for the first time via `fakeEditor`'s additive `scrollDOM`
	 * stub.
	 *
	 * THE DEFECT, reproduced before it was fixed. `resetScrollSuppression`
	 * wrote only `scrollSuppressed.set(editor, false)` and left
	 * `expectingOwnScroll` alone. That matters because a scroll dispatch can
	 * arm the flag and then move the DOM by zero pixels, in which case no
	 * native 'scroll' event ever fires and nothing consumes the arm:
	 * `scrollRectIntoView` computes a non-zero `moveY` and passes the
	 * `if (moveX || moveY)` gate at node_modules/@codemirror/view/dist/
	 * index.js:200, but the write seven lines later
	 * (`cur.scrollTop += moveY / scaleY`, :207-209; the `scrollLeft` twin is at
	 * :211-214) is CLAMPED by the browser,
	 * and a `scrollTop` write that does not change the value fires no event.
	 * This is the ordinary case at the opening of a read: centring a chunk in
	 * the first half-viewport needs a negative `scrollTop`. It is measured on
	 * a real device already, in this repo - docs/adr/0022:242-243 records
	 * chunks 0-4 holding `scrollTop` 0 on NRL-110's own post-`center` series,
	 * five of twenty-two dispatches moving the DOM by zero.
	 *
	 * So a stale arm survived a playback restart, and the FIRST genuine user
	 * scroll after that restart was misread as the plugin's own - which
	 * contradicts `resetScrollSuppression`'s own claim to return the editor to
	 * normal follow behaviour, and is acceptance criterion 4 of the ticket
	 * ("playback restarting resets to the normal follow behaviour").
	 *
	 * Measured against the unfixed `resetScrollSuppression` by staging these
	 * checks before the one-line fix: 19h and 19i RED, every guard and the
	 * tripwire below GREEN on both sides.
	 */
	const defaultToggles: HighlightToggles = { enabled: true, sentence: true, word: true };
	/** A chunk dispatch in main.ts's own shape, with suppression consulted. */
	function suppressibleChunkDispatch(
		editor: ReturnType<typeof fakeEditor>,
		sourceStart: number,
		sourceEnd: number,
	): void {
		const plan = highlightPlan(defaultToggles, true);
		applyHighlightLayers(
			editor as never,
			{ sentence: plan.sentence ? { from: sourceStart, to: sourceEnd } : null, word: null },
			scrollTargetForChunk(plan, sourceStart, isScrollSuppressed(editor as never)),
		);
	}

	// 19h REPRO. Arm via a real scroll dispatch, then model the zero-movement
	// case by firing NO scroll event (R1), restart playback, and let the user
	// scroll once. The stale arm must not eat that event.
	{
		const editor = fakeEditor(fresh());
		registerScrollSuppression(editor as never);
		suppressibleChunkDispatch(editor, 0, 17); // arms expectingOwnScroll
		// (no fireScroll here: the DOM did not move, so no event exists)
		resetScrollSuppression(editor as never); // playback restarts
		editor.fireScroll(); // the user's first scroll of the restarted read
		check(
			"19h REPRO a pre-restart arm does not survive resetScrollSuppression",
			isScrollSuppressed(editor as never) === true,
			`isScrollSuppressed=${isScrollSuppressed(editor as never)}`,
		);
	}

	// 19i REPRO, the same defect observed where the user actually sees it: on
	// the next chunk dispatch. main.ts reads the flag through
	// `scrollTargetForChunk`, not directly, so this is a second observable of
	// one defect and worth pinning separately.
	{
		const editor = fakeEditor(fresh());
		registerScrollSuppression(editor as never);
		suppressibleChunkDispatch(editor, 0, 17);
		resetScrollSuppression(editor as never);
		editor.fireScroll();
		const before = editor.dispatched.length;
		suppressibleChunkDispatch(editor, 18, 37);
		const tr = editor.dispatched[before]!.tr;
		check(
			"19i REPRO after a restart and one user scroll, the next chunk carries no scroll effect",
			scrollEffects(tr).length === 0,
			JSON.stringify(scrollEffects(tr)),
		);
	}

	// 19j GUARD, green on both sides: a chunk dispatch with no scroll target
	// must not arm, so the very next scroll event latches immediately.
	{
		const editor = fakeEditor(fresh());
		registerScrollSuppression(editor as never);
		applyHighlightLayers(
			editor as never,
			{ sentence: null, word: null },
			scrollTargetForChunk({ sentence: false, word: false }, 0, false),
		);
		editor.fireScroll();
		check(
			"19j GUARD a dispatch with no scroll target does not arm, so one event latches",
			isScrollSuppressed(editor as never) === true,
			`${isScrollSuppressed(editor as never)}`,
		);
	}

	// 19k GUARD, green on both sides, and the PREMISE 19h depends on: the arm
	// is consumed by exactly one scroll event, never more. Stated separately
	// so 19h cannot be read as gating on something else.
	{
		const editor = fakeEditor(fresh());
		registerScrollSuppression(editor as never);
		suppressibleChunkDispatch(editor, 0, 17);
		editor.fireScroll();
		const afterOwn = isScrollSuppressed(editor as never);
		editor.fireScroll();
		check(
			"19k GUARD the arm is consumed exactly once (first event ours, second latches)",
			afterOwn === false && isScrollSuppressed(editor as never) === true,
			`${afterOwn} then ${isScrollSuppressed(editor as never)}`,
		);
	}

	// 19l GUARD, green on both sides: the idempotence `registerScrollSuppression`'s
	// docstring claims, observable only as a listener count.
	{
		const editor = fakeEditor(fresh());
		registerScrollSuppression(editor as never);
		registerScrollSuppression(editor as never);
		registerScrollSuppression(editor as never);
		check(
			"19l GUARD registerScrollSuppression attaches exactly one listener however often it is called",
			editor.scrollListenerCount() === 1,
			`${editor.scrollListenerCount()}`,
		);
	}

	// 19m GUARD, green on both sides: the pre-existing half of
	// `resetScrollSuppression` still works - a LATCHED suppression clears.
	{
		const editor = fakeEditor(fresh());
		registerScrollSuppression(editor as never);
		editor.fireScroll(); // unarmed, so this latches
		const latched = isScrollSuppressed(editor as never);
		resetScrollSuppression(editor as never);
		check(
			"19m GUARD resetScrollSuppression still clears a latched suppression",
			latched === true && isScrollSuppressed(editor as never) === false,
			`${latched} then ${isScrollSuppressed(editor as never)}`,
		);
	}

	/*
	 * 19n TRIPWIRE, green on both sides, and NOT a fix - the same convention
	 * `pin-nrl74-container-label-still-leaks-destination` uses in
	 * tests/extract.test.ts. This pins F1's ACCEPTED residual, both halves of
	 * it, so either half can only change deliberately.
	 *
	 * F1: within a single read (no restart, so Q6's fix does not apply), a
	 * zero-movement scroll dispatch leaves the arm set, and the FIRST event of
	 * the user's next gesture is swallowed. That is accepted rather than
	 * fixed: the alternative - clearing the arm on a microtask or a single
	 * rAF - lands BEFORE the scroll event exists, because CodeMirror does not
	 * scroll inside `dispatch` (index.js:7714-7715 requests a measure,
	 * :8003-8005 schedules it on `requestAnimationFrame`) and a `scrollTop`
	 * write fires `scroll` asynchronously after that. It would therefore read
	 * every one of our own scrolls as a user scroll and kill auto-scroll from
	 * chunk 1 - fail-CLOSED, where F1 is fail-OPEN at a cost of one swallowed
	 * event. See docs/adr/0030.
	 *
	 * The bound rests on `expectingOwnScroll` being a single read-and-cleared
	 * boolean: however many no-op dispatches pile up, at most ONE stale arm is
	 * pending, so a gesture emitting two or more scroll events still latches.
	 * Whether a real gesture does emit two or more is a device measurement,
	 * not something this suite can judge.
	 */
	{
		const editor = fakeEditor(fresh());
		registerScrollSuppression(editor as never);
		suppressibleChunkDispatch(editor, 0, 17); // arms; DOM moves zero (R1)
		editor.fireScroll(); // first event of the user's gesture - SWALLOWED
		const afterFirst = isScrollSuppressed(editor as never);
		editor.fireScroll(); // second event of the same gesture - latches
		check(
			"19n TRIPWIRE F1 accepted residual: a zero-movement arm swallows the first user scroll event, the second latches",
			afterFirst === false && isScrollSuppressed(editor as never) === true,
			`${afterFirst} then ${isScrollSuppressed(editor as never)}`,
		);
	}
}

/*
 * KNOWN GAP, stated honestly rather than left implicit. AMENDED by NRL-90's
 * follow-up rather than deleted: the gap got NARROWER, not empty, and what is
 * left has to be said precisely or the new coverage will be read as more than
 * it is.
 *
 * WHAT IS NOW COVERED, where nothing was before. The checks 19h-19n above drive
 * `registerScrollSuppression`'s listener BODY, via `fakeEditor`'s additive
 * `scrollDOM` stub: the read-and-clear of `expectingOwnScroll`, the WeakSet
 * dedupe observed as a listener count, the arming site inside
 * `applyHighlightLayers`, and `resetScrollSuppression` clearing both pieces of
 * state. So the sentence this comment used to carry - that the listener has no
 * automated coverage of any kind - is no longer true and has been removed
 * rather than left standing.
 *
 * WHAT IS STILL NOT COVERED, and cannot be in this suite:
 *
 *   - EVENT TIMING. `fireScroll()` invokes the captured handler directly, in
 *     the same task as the dispatch. A real browser fires 'scroll'
 *     asynchronously, at least one frame after the `scrollTop` write, which
 *     CodeMirror itself performs in a `requestAnimationFrame` measure pass
 *     (index.js:7714-7715 requests, :8003-8005 schedules) rather than inside
 *     `dispatch`. Nothing here tests that ordering, and it is exactly what
 *     docs/adr/0030 rejects the self-expiring-arm alternative on.
 *   - GESTURE MULTIPLICITY. 19n pins that the second event of a gesture
 *     latches, but how many 'scroll' events one real touch drag or wheel
 *     gesture emits is a device fact. It is the single measurement that decides
 *     whether F1's accepted residual has any user-visible consequence at all.
 *   - WHETHER `scrollDOM` IS THE ELEMENT OBSIDIAN SCROLLS. This file never
 *     instantiates a real `EditorView` (ADR 0022 decision 3's own comment says
 *     so, and that remains true), so the stub asserts our own contract with
 *     ourselves. If Obsidian scrolls an ancestor instead - which
 *     `scrollRectIntoView`'s parent walk at index.js:152-155 can reach - the
 *     listener never fires and none of this would show it.
 *
 * All three need a real EditorView and a real DOM `scroll` event, neither of
 * which bare Node can build. main.ts's three call-site edits
 * (`registerScrollSuppression`/`resetScrollSuppression` at readActiveNote,
 * readSelection and readFromCursor) also have no automated coverage: main.ts
 * imports `obsidian` and cannot run in this suite, the same gap every prior
 * highlight-wiring ticket (NRL-54, NRL-72, NRL-89) already carries.
 */

// --- NRL-112: the mobile placement of the floating control bar ------------

/*
 * `src/ui/controlBar.ts` imports `obsidian` at line 1, so it has NO runtime in
 * this suite and nothing here can observe a rect, a wrap, a safe-area inset or
 * whether a 44px target is actually tappable. All of that was measured on a
 * real device and is recorded in docs/adr/0032; a green run of this section is
 * NOT evidence that the bar is reachable (AGENTS.md rule 11).
 *
 * What IS checkable is styles.css as text, which is the whole of the change.
 * These checks exist so a later tidy-up cannot delete a load-bearing
 * declaration, cannot "simplify" the mobile override into an edit of the
 * desktop rule, and cannot hide a control instead of letting the row wrap.
 *
 * The existing `ruleBody()` above builds its pattern as `\\${selector}`, which
 * escapes a leading `.` and takes one simple class. It cannot match
 * `body.is-mobile .local-tts-control-bar`, and it is deliberately left
 * byte-identical here so blocks 11 and 12 cannot move; this section uses its
 * own scanner instead.
 */

type CssRule = { selectors: string[]; body: string };

// Comments are stripped before scanning, so prose in a comment can never
// satisfy or break a check - the NRL-112 block's own comment contains the
// strings "display: none" and "visibility: hidden" while describing why
// neither appears in a rule.
const CSS_NO_COMMENTS = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

// This scanner is flat and cannot parse a NESTED at-rule. `styles.css`'s one
// at-rule today is `@keyframes local-tts-spin` (:152), which yields phantom
// rules whose selectors are `from` and `to`; nothing below matches those, and
// the file has zero `@media` queries. If a mobile rule is ever wrapped in an
// `@media`, the hidden-control sweep stops covering it SILENTLY - teach this
// function about nesting at that point rather than trusting it.
const CSS_RULES: CssRule[] = (() => {
	const rules: CssRule[] = [];
	const re = /([^{}]+)\{([^{}]*)\}/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(CSS_NO_COMMENTS)) !== null) {
		const head = (m[1] ?? "").trim();
		if (!head || head.startsWith("@")) continue;
		rules.push({
			selectors: head.split(",").map((s) => s.trim()).filter(Boolean),
			body: m[2] ?? "",
		});
	}
	return rules;
})();

function rulesMatching(predicate: (selector: string) => boolean): CssRule[] {
	return CSS_RULES.filter((rule) => rule.selectors.some(predicate));
}
function declarations(body: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const decl of body.split(";")) {
		const line = decl.trim();
		const colon = line.indexOf(":");
		if (colon <= 0) continue;
		out.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
	}
	return out;
}

console.log("20. NRL-112: styles.css carries the mobile control-bar placement");
{
	const mobile = rulesMatching((s) => s.startsWith("body.is-mobile"));
	check("a body.is-mobile block exists at all", mobile.length > 0, `${mobile.length} rule(s)`);

	const barRule = rulesMatching((s) => s === "body.is-mobile .local-tts-control-bar")[0];
	check("a body.is-mobile .local-tts-control-bar rule exists", barRule !== undefined);
	const bar = declarations(barRule?.body ?? "");

	/*
	 * The offset must be built from Obsidian's own variables, never a literal.
	 * Measured on the device 2026-10-01: --safe-area-inset-top 66.333336px and
	 * --view-header-height 44px. A frozen number would be wrong on the next
	 * device and is exactly what rule 13 forbids.
	 */
	const top = bar.get("top") ?? "";
	check("the bar's mobile top is declared", bar.has("top"), top);
	check("top reads --safe-area-inset-top", top.includes("var(--safe-area-inset-top)"), top);
	check("top reads --view-header-height", top.includes("var(--view-header-height)"), top);
	check("top is not a frozen pixel literal", !/\d+px/.test(top), top);

	/*
	 * flex-wrap is the load-bearing one: at 44px targets the content sums past
	 * the device's measured 448px viewport, and wrapping is what absorbs that
	 * without shrinking a target or removing a control. Measured post-fix, the
	 * bar wraps into three rows at 224px with scrollWidth == clientWidth.
	 *
	 * max-width is NOT what forced that wrap and was measured not to be: its
	 * computed value was 432px against a settled width of 224px (ADR 0032
	 * decision 4). It is kept as the landscape/notched-side guard, so this
	 * check asserts only that it is present and does not claim it binds.
	 */
	check("the bar wraps rather than overflowing", bar.get("flex-wrap") === "wrap", bar.get("flex-wrap") ?? "(absent)");
	check("the bar is clamped to the viewport", bar.has("max-width"), bar.get("max-width") ?? "(absent)");

	const btnRule = rulesMatching((s) => s === "body.is-mobile .local-tts-cb-btn")[0];
	check("a body.is-mobile button rule exists", btnRule !== undefined);
	check(
		"the same rule covers the speed buttons, which were the smallest targets",
		btnRule?.selectors.includes("body.is-mobile .local-tts-cb-speed-btn") === true,
		JSON.stringify(btnRule?.selectors ?? []),
	);
	const btn = declarations(btnRule?.body ?? "");
	// 44px is Obsidian's own --input-height, measured at 44px on the device.
	check("transport and speed targets are at least 44px wide", btn.get("min-width") === "44px", btn.get("min-width") ?? "(absent)");
	check("transport and speed targets are at least 44px tall", btn.get("min-height") === "44px", btn.get("min-height") ?? "(absent)");
	/*
	 * min-* rather than width/height is what keeps the desktop declarations
	 * authoritative on desktop: CSS clamps the used value to
	 * max(min-width, width), so 44 wins on mobile with 28 still in the file.
	 */
	// TRIPWIRES for the wrong implementation of the same fix: these two and
	// "top is not a frozen pixel literal" pass on the unmodified stylesheet
	// (there is no mobile rule to get wrong), so they are not reproductions.
	check("the mobile rule does not restate width", !btn.has("width"), JSON.stringify([...btn]));
	check("the mobile rule does not restate height", !btn.has("height"), JSON.stringify([...btn]));

	/*
	 * TRIPWIRE, not a reproduction: this passes on the unmodified stylesheet
	 * too. R-M14 requires a control the engine cannot honour to be disabled and
	 * visibly so rather than removed - see the comment block above
	 * `.local-tts-cb-btn:disabled`. A future mobile tidy-up that buys space by
	 * hiding the progress readout or a button instead of letting the row wrap
	 * fails here by name.
	 */
	for (const rule of mobile) {
		const decls = declarations(rule.body);
		check(
			`no control is hidden on mobile: ${rule.selectors[0]}`,
			decls.get("display") !== "none" && decls.get("visibility") !== "hidden",
			rule.body.trim(),
		);
	}

	/*
	 * TRIPWIRE, not a reproduction. Chrome/88 is the floor (SPIKE-ANDROID-001),
	 * where color-mix() and relative colour syntax compute to nothing rather
	 * than degrading - which would break mobile only, the one platform this
	 * block exists for. calc(), min-width, flex-wrap and custom properties are
	 * all fine on 88.
	 */
	const mobileText = mobile.map((r) => r.body).join("");
	check("no color-mix() in the mobile rules", !/color-mix\(/.test(mobileText));
	check("no :has() in the mobile selectors", !mobile.some((r) => r.selectors.some((s) => s.includes(":has("))));
}

console.log("21. GUARDS: the desktop control-bar rules are still literally present");
{
	/*
	 * Green on both sides of NRL-112 by design - these are the "desktop
	 * unchanged" tripwire, and they are the one thing that would catch someone
	 * rewriting the mobile override as an edit to the desktop rule. The
	 * stronger demonstration is that the NRL-112 diff deletes zero lines from
	 * this file; no desktop Obsidian was observed (CDP 9222 unreachable).
	 */
	const desktopBar = declarations(rulesMatching((s) => s === ".local-tts-control-bar")[0]?.body ?? "");
	check("GUARD: the desktop bar still pins top: 0", desktopBar.get("top") === "0", desktopBar.get("top") ?? "(absent)");

	const desktopBtn = declarations(rulesMatching((s) => s === ".local-tts-cb-btn")[0]?.body ?? "");
	check("GUARD: desktop transport buttons are still 28px wide", desktopBtn.get("width") === "28px", desktopBtn.get("width") ?? "(absent)");
	check("GUARD: desktop transport buttons are still 28px tall", desktopBtn.get("height") === "28px", desktopBtn.get("height") ?? "(absent)");

	const desktopSpeed = declarations(rulesMatching((s) => s === ".local-tts-cb-speed-btn")[0]?.body ?? "");
	check("GUARD: desktop speed buttons are still 20px wide", desktopSpeed.get("width") === "20px", desktopSpeed.get("width") ?? "(absent)");
	check("GUARD: desktop speed buttons are still 20px tall", desktopSpeed.get("height") === "20px", desktopSpeed.get("height") ?? "(absent)");
}

if (failures > 0) {
	console.log(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall highlight checks passed");
