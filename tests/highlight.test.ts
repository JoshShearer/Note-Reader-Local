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
	scrollTargetForChunk,
} from "../src/ui/highlight.ts";
import type { HighlightToggles } from "../src/ui/highlight.ts";
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
 */
type DispatchSpec = Parameters<EditorState["update"]>[0];
function fakeEditor(initial: EditorState) {
	const editor = {
		state: initial,
		dispatched: [] as { spec: DispatchSpec; tr: Transaction }[],
		dispatch(spec: DispatchSpec) {
			const tr = editor.state.update(spec);
			editor.dispatched.push({ spec, tr });
			editor.state = tr.state;
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

	// No options object is passed to EditorView.scrollIntoView, so CodeMirror's
	// own defaults apply. `yMargin` is deliberately NOT asserted: it is a
	// library default we do not own and do not rely on.
	check("14c the scroll uses CodeMirror's nearest defaults on both axes", scrolls[0]?.y === "nearest" && scrolls[0]?.x === "nearest", JSON.stringify(scrolls[0]));

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
			scrollTargetForChunk(layers, chunk.sourceStart),
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
	const got = table.map(([layers]) => scrollTargetForChunk(layers, 18));
	const want = table.map(([, expected]) => expected);
	check("17g NEW scrollTargetForChunk is null only when neither layer is drawn", JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));

	// Zero is a real offset: the first chunk of a note starts there, and a
	// `!target` test would silently stop scrolling to the top of every note.
	check("17h GUARD sourceStart 0 is returned, not treated as absent", scrollTargetForChunk({ sentence: true, word: false }, 0) === 0, `${scrollTargetForChunk({ sentence: true, word: false }, 0)}`);
}

if (failures > 0) {
	console.log(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall highlight checks passed");
