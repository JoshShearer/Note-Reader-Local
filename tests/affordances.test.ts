/**
 * Capabilities the UI actually honours (NRL-22, R-M14).
 *
 * Two separate claims are checked here, and they fail for different reasons.
 *
 * 1. The mapping rules: given a capability table, which controls are offered
 *    and what does the UI say when one is not. Driven with hand-written fakes,
 *    including the ticket's required case of an engine that declares nothing.
 * 2. The four real engines' declarations. The plan for this ticket assumed
 *    these were unreachable in bare Node (it expected `./spawn` to drag in
 *    `obsidian`). It does not: `spawn.ts` imports only a type from
 *    `child_process`, and none of the four constructors touch their
 *    collaborators. So "speech-dispatcher declares that it cannot pause" is a
 *    thing a test can see rather than something only a reader can confirm.
 *
 * What is still not proved here: that a disabled button in the real control
 * bar looks disabled, and that switching engines refreshes it. Those need
 * Obsidian (AGENTS.md rule 11).
 */

import {
	controlAffordances,
	engineLimitations,
	type Limitation,
} from "../src/ui/affordances.ts";
import type { EngineCapabilities } from "../src/audio/types.ts";
import { EspeakEngine } from "../src/engines/system/espeak.ts";
import { SpeechDispatcherEngine } from "../src/engines/system/speechd.ts";
import { WebSpeechEngine } from "../src/engines/webspeech.ts";
import { KokoroEngine, type ModelStore } from "../src/engines/onnx/kokoro.ts";
import type { ProcessRunner } from "../src/engines/system/spawn.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
	if (cond) console.log(`  ok   ${name}`);
	else {
		failures += 1;
		console.log(`  FAIL ${name} ${detail}`);
	}
}

/** Nothing about a capability table should require a subprocess or the vault. */
function refuse(what: string): never {
	throw new Error(`reading capabilities must not touch ${what}`);
}
const noRunner: ProcessRunner = {
	run: () => refuse("a process"),
	spawn: () => refuse("a process"),
	which: () => refuse("a process"),
};
const noStore = new Proxy({}, { get: () => refuse("the vault") }) as ModelStore;

const NOTHING: EngineCapabilities = {
	voices: false,
	timing: "none",
	rate: false,
	pitch: false,
	desktopOnly: false,
	ownsPlayback: false,
	pause: false,
	resume: false,
	sentenceBoundary: false,
	offlineStatus: false,
};

const EVERYTHING: EngineCapabilities = {
	voices: true,
	timing: "measured",
	rate: true,
	pitch: true,
	desktopOnly: false,
	ownsPlayback: false,
	pause: true,
	resume: true,
	sentenceBoundary: true,
	offlineStatus: true,
};

const ids = (ls: Limitation[]): string[] => ls.map((l) => l.id);

// The ticket's required test.
console.log("an engine that declares nothing gets a UI with those controls disabled");
{
	const a = controlAffordances(NOTHING, "Nothing Engine");
	for (const id of ["playPause", "rate", "highlightToggle"] as const) {
		check(`${id} disabled`, !a[id].enabled);
		check(`${id} says why`, a[id].reason.length > 0, JSON.stringify(a[id].reason));
		check(`${id} names the engine`, a[id].reason.includes("Nothing Engine"), a[id].reason);
	}
}

console.log("an engine that declares everything gets every control, with nothing to explain");
{
	const a = controlAffordances(EVERYTHING, "Everything Engine");
	for (const id of ["playPause", "rate", "highlightToggle"] as const) {
		check(`${id} enabled`, a[id].enabled);
		check(`${id} has no reason`, a[id].reason === "", JSON.stringify(a[id].reason));
	}
	check("no limitations to report", engineLimitations(EVERYTHING, "Everything Engine").length === 0,
		JSON.stringify(ids(engineLimitations(EVERYTHING, "Everything Engine"))));
}

console.log("each control is gated by its own capability and no other");
{
	const noTiming = controlAffordances({ ...EVERYTHING, timing: "none" }, "E");
	check("timing none disables the highlight toggle", !noTiming.highlightToggle.enabled);
	check("timing none leaves pause alone", noTiming.playPause.enabled);
	check("timing none leaves rate alone", noTiming.rate.enabled);

	const noRate = controlAffordances({ ...EVERYTHING, rate: false }, "E");
	check("rate false disables the rate control", !noRate.rate.enabled);
	check("rate false leaves pause alone", noRate.playPause.enabled);
	check("rate false leaves the highlight toggle alone", noRate.highlightToggle.enabled);

	// Both halves are required: a pause the user cannot come back from is not
	// a pause, so half-declared support must not light the button up.
	check(
		"pause without resume still disables the button",
		!controlAffordances({ ...EVERYTHING, resume: false }, "E").playPause.enabled,
	);
	check(
		"resume without pause still disables the button",
		!controlAffordances({ ...EVERYTHING, pause: false }, "E").playPause.enabled,
	);
}

console.log("ownsPlayback does not gate anything (non-negotiable 9 keeps it for rate routing)");
{
	const owns = controlAffordances({ ...EVERYTHING, ownsPlayback: true }, "E");
	check("ownsPlayback true changes no affordance", owns.playPause.enabled && owns.rate.enabled && owns.highlightToggle.enabled);
}

console.log("an unknown engine is not a disabled engine");
{
	const a = controlAffordances(null, "This engine");
	for (const id of ["playPause", "rate", "highlightToggle"] as const) {
		check(`${id} still enabled`, a[id].enabled);
		check(`${id} has no reason`, a[id].reason === "");
	}
}

console.log("engineLimitations turns the quiet fields into something a user can read");
{
	const speechdShaped: EngineCapabilities = {
		...NOTHING, voices: true, rate: true, pitch: true, desktopOnly: true,
		ownsPlayback: true, offlineStatus: true,
	};
	const got = ids(engineLimitations(speechdShaped, "speech-dispatcher"));
	check("speechd-shaped: no highlighting", got.includes("highlightToggle"), got.join(","));
	check("speechd-shaped: cannot pause", got.includes("playPause"), got.join(","));
	check("speechd-shaped: no sentence boundaries", got.includes("sentenceBoundary"), got.join(","));
	check("speechd-shaped: rate is not listed, it has one", !got.includes("rate"), got.join(","));
	check("speechd-shaped: offline status is not listed, it has one", !got.includes("offlineStatus"), got.join(","));

	const kokoroShaped: EngineCapabilities = { ...EVERYTHING, sentenceBoundary: false };
	check("kokoro-shaped lists only the sentence boundary entry",
		ids(engineLimitations(kokoroShaped, "Kokoro")).join(",") === "sentenceBoundary",
		ids(engineLimitations(kokoroShaped, "Kokoro")).join(","));

	for (const l of engineLimitations(NOTHING, "Nothing Engine")) {
		check(`limitation ${l.id} has text`, l.text.trim().length > 0);
	}
}

console.log("the four real engines declare their new capabilities honestly");
{
	const real = [
		{ e: new KokoroEngine(noStore), pause: true, sentenceBoundary: false, offlineStatus: true },
		{ e: new EspeakEngine(noRunner), pause: true, sentenceBoundary: false, offlineStatus: true },
		{ e: new SpeechDispatcherEngine(noRunner), pause: false, sentenceBoundary: false, offlineStatus: true },
		{ e: new WebSpeechEngine(), pause: false, sentenceBoundary: false, offlineStatus: false },
	];
	for (const { e, pause, sentenceBoundary, offlineStatus } of real) {
		const c = e.capabilities;
		check(`${e.id} pause === ${pause}`, c.pause === pause, String(c.pause));
		// pause and resume are one decision today: an engine the player can
		// pause is one it can resume. Kept as two fields because the spec has
		// two.
		check(`${e.id} resume matches pause`, c.resume === pause, String(c.resume));
		check(`${e.id} sentenceBoundary === ${sentenceBoundary}`, c.sentenceBoundary === sentenceBoundary, String(c.sentenceBoundary));
		check(`${e.id} offlineStatus === ${offlineStatus}`, c.offlineStatus === offlineStatus, String(c.offlineStatus));
	}

	// The bug this ticket makes honest: the two engines whose audio the player
	// never holds are the two that must not offer a pause button. `pause` is
	// deliberately a separate field from `ownsPlayback`, so that NRL-23 can
	// make webspeech pausable without touching rate routing.
	const speechd = new SpeechDispatcherEngine(noRunner);
	const webspeech = new WebSpeechEngine();
	check("speechd's pause button is disabled",
		!controlAffordances(speechd.capabilities, speechd.label).playPause.enabled);
	check("webspeech's pause button is disabled",
		!controlAffordances(webspeech.capabilities, webspeech.label).playPause.enabled);
	check("speechd's highlight toggle is disabled",
		!controlAffordances(speechd.capabilities, speechd.label).highlightToggle.enabled);
	check("kokoro keeps its pause button",
		controlAffordances(new KokoroEngine(noStore).capabilities, "Kokoro").playPause.enabled);
}

if (failures > 0) {
	console.log(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall affordance checks passed");
