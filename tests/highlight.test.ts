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

import { EditorState } from "@codemirror/state";
import {
	sentenceHighlightField,
	wordHighlightField,
	setSentenceHighlight,
	setWordHighlight,
	applySentenceHighlight,
	applyWordHighlight,
	clearHighlights,
	clearSentenceHighlight,
	clearWordHighlight,
	highlightPlan,
} from "../src/ui/highlight.ts";
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
 */
function fakeEditor(initial: EditorState) {
	const editor = {
		state: initial,
		dispatch(spec: Parameters<EditorState["update"]>[0]) {
			editor.state = editor.state.update(spec).state;
		},
	};
	return editor as typeof editor & { state: EditorState };
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

if (failures > 0) {
	console.log(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall highlight checks passed");
