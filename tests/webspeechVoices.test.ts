/**
 * Web Speech's local-voice signal (NRL-24, AGENTS.md non-negotiable 4).
 *
 * Before this ticket, webspeech.ts had no local/network signal at all:
 * `CAPABILITIES.offlineStatus = false`, with a comment admitting the API
 * does not say which. `hasLocalVoice()`/`listLocalVoices()` are the minimal
 * fix, used only by automatic selection (main.ts) - a manual pin to Web
 * Speech is unaffected and still sees every voice via `listVoices()`.
 *
 * Fails closed: `SpeechSynthesisVoice.localService` is `boolean |
 * undefined` in the DOM lib, and an `undefined` value is treated the same as
 * "confirmed remote" here, not as "unknown, assume fine" - a deliberate
 * reading of "no automatic fallback to a cloud voice" applied to an unknown
 * signal.
 *
 * Mocks `window.speechSynthesis` the way tests/kokoro.test.ts mocks
 * `navigator.gpu`: a fake global, restored per test block.
 */

import { WebSpeechEngine } from "../src/engines/webspeech.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
	if (cond) console.log(`  ok   ${name}`);
	else {
		failures += 1;
		console.log(`  FAIL ${name} ${detail}`);
	}
}

interface FakeVoice {
	voiceURI: string;
	name: string;
	lang: string;
	localService?: boolean;
}

function withVoices(voices: FakeVoice[]): void {
	const speechSynthesis = {
		getVoices: () => voices,
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
	};
	Object.defineProperty(globalThis, "window", {
		// A zero-voices case falls through to waitForVoices()'s poll loop,
		// which calls window.setTimeout - fire it on a microtask instead of
		// a real delay, or the empty-voices test would take VOICE_TIMEOUT_MS
		// (5s) of real wall time to resolve.
		value: { speechSynthesis, setTimeout: (fn: () => void) => void Promise.resolve().then(fn) },
		configurable: true,
		writable: true,
	});
	Object.defineProperty(globalThis, "speechSynthesis", {
		value: speechSynthesis,
		configurable: true,
		writable: true,
	});
}

console.log("hasLocalVoice() is true when at least one voice is local");
{
	withVoices([
		{ voiceURI: "remote-1", name: "Cloud Voice", lang: "en-US", localService: false },
		{ voiceURI: "local-1", name: "System Voice", lang: "en-US", localService: true },
	]);
	const engine = new WebSpeechEngine();
	check("hasLocalVoice true", await engine.hasLocalVoice());
}

console.log("hasLocalVoice() is false when every voice is explicitly remote");
{
	withVoices([
		{ voiceURI: "remote-1", name: "Cloud Voice A", lang: "en-US", localService: false },
		{ voiceURI: "remote-2", name: "Cloud Voice B", lang: "en-GB", localService: false },
	]);
	const engine = new WebSpeechEngine();
	check("hasLocalVoice false", !(await engine.hasLocalVoice()));
}

console.log(
	"hasLocalVoice() is false when localService is undefined on every voice (fail-closed)",
);
{
	// The deliberate reading: "not confirmed local" is treated the same as
	// "confirmed remote" for automatic selection, not as "assume it's fine".
	withVoices([
		{ voiceURI: "unknown-1", name: "Some Voice", lang: "en-US" },
		{ voiceURI: "unknown-2", name: "Another Voice", lang: "en-GB" },
	]);
	const engine = new WebSpeechEngine();
	check("hasLocalVoice false (fail-closed on unknown)", !(await engine.hasLocalVoice()));
}

console.log("listLocalVoices() returns only the local ones, mapped like listVoices()");
{
	withVoices([
		{ voiceURI: "remote-1", name: "Cloud Voice", lang: "en-US", localService: false },
		{ voiceURI: "local-1", name: "System Voice (Extra)", lang: "en-GB", localService: true },
		{ voiceURI: "unknown-1", name: "Mystery Voice", lang: "fr-FR" },
	]);
	const engine = new WebSpeechEngine();
	const local = await engine.listLocalVoices();
	check("exactly one local voice", local.length === 1, JSON.stringify(local));
	check("id carries the webspeech prefix", local[0]?.id === "webspeech:local-1", local[0]?.id);
	check("name mapping matches listVoices()'s own", local[0]?.name === "System Voice", local[0]?.name);
	check("lang preserved", local[0]?.lang === "en-GB", local[0]?.lang);
	check("engineId is webspeech", local[0]?.engineId === "webspeech", local[0]?.engineId);

	const all = await engine.listVoices();
	check("listVoices() is unaffected: still returns all three", all.length === 3, String(all.length));
}

console.log(
	"NRL-26: listVoices() maps localService to local/requiresNetwork honestly (tri-state)",
);
{
	withVoices([
		{ voiceURI: "local-1", name: "System Voice", lang: "en-US", localService: true },
		{ voiceURI: "remote-1", name: "Cloud Voice", lang: "en-GB", localService: false },
		{ voiceURI: "unknown-1", name: "Mystery Voice", lang: "fr-FR" },
	]);
	const engine = new WebSpeechEngine();
	const voices = await engine.listVoices();
	const local = voices.find((v) => v.id === "webspeech:local-1");
	const remote = voices.find((v) => v.id === "webspeech:remote-1");
	const unknown = voices.find((v) => v.id === "webspeech:unknown-1");

	check("localService: true -> local: true", local?.local === true, JSON.stringify(local));
	check("localService: true -> requiresNetwork: false", local?.requiresNetwork === false, JSON.stringify(local));

	check("localService: false -> local: false", remote?.local === false, JSON.stringify(remote));
	check("localService: false -> requiresNetwork: true", remote?.requiresNetwork === true, JSON.stringify(remote));

	// The honest reading: undefined must never be coerced to a boolean.
	check("localService: undefined -> local: \"unknown\"", unknown?.local === "unknown", JSON.stringify(unknown));
	check(
		"localService: undefined -> requiresNetwork: \"unknown\"",
		unknown?.requiresNetwork === "unknown",
		JSON.stringify(unknown),
	);
}

console.log("isAvailable() distinguishes its failure modes (NRL-25)");
{
	// No window/speechSynthesis at all.
	Object.defineProperty(globalThis, "window", {
		value: undefined,
		configurable: true,
		writable: true,
	});
	Object.defineProperty(globalThis, "speechSynthesis", {
		value: undefined,
		configurable: true,
		writable: true,
	});
	const engine = new WebSpeechEngine();
	const result = await engine.isAvailable();
	check("no API: not available", result.available === false);
	check(
		"no API: reason names the Web Speech API",
		!result.available && /web speech api/i.test(result.reason),
		!result.available ? result.reason : "available:true",
	);
}
{
	withVoices([]);
	const engine = new WebSpeechEngine();
	const result = await engine.isAvailable();
	check("zero voices: not available", result.available === false);
	check(
		"zero voices: reason names voices installed, a DIFFERENT reason than no-API",
		!result.available && /voice/i.test(result.reason) && /install/i.test(result.reason),
		!result.available ? result.reason : "available:true",
	);
}
{
	withVoices([{ voiceURI: "local-1", name: "System Voice", lang: "en-US", localService: true }]);
	const engine = new WebSpeechEngine();
	const result = await engine.isAvailable();
	check("at least one voice: available", result.available === true, JSON.stringify(result));
}

// ---------------------------------------------------------------------------
// NRL-141: the no-voices probe is paid once per engine, not once per call.
//
// Measured before this fix, bundling the real webspeech.ts at 28eef81 with
// real timers and a zero-voice fake: every hasLocalVoice()/isAvailable()/
// listLocalVoices() call took 4,910-4,918 ms and scheduled 49 poll timers,
// the second call exactly as slow as the first, and a concurrent pair
// scheduled 98. In a live Flatpak Obsidian with getVoices().length 0,
// buildProbes() took 4,909 ms on both of two consecutive calls.
//
// The fake counts window.setTimeout calls and runs each on a microtask, so a
// count of scheduled timers is the cost measure and no test waits on a real
// clock. `fire()` dispatches voiceschanged to every registered listener.
// Tests marked CORE were measured red against the unfixed module; GUARD
// tests hold on both sides and are not evidence of the fix.
// ---------------------------------------------------------------------------

interface ProbeFake {
	voices: FakeVoice[];
	timers: number;
	listeners: Set<() => void>;
	fire(): void;
}

function probeFake(initial: FakeVoice[] = []): ProbeFake {
	const fake: ProbeFake = {
		voices: initial,
		timers: 0,
		listeners: new Set(),
		fire() {
			for (const l of [...fake.listeners]) l();
		},
	};
	const speechSynthesis = {
		getVoices: () => fake.voices,
		addEventListener: (_type: string, fn: () => void) => void fake.listeners.add(fn),
		removeEventListener: (_type: string, fn: () => void) => void fake.listeners.delete(fn),
		cancel: () => undefined,
		resume: () => undefined,
	};
	Object.defineProperty(globalThis, "window", {
		value: {
			speechSynthesis,
			setTimeout: (fn: () => void) => {
				fake.timers += 1;
				void Promise.resolve().then(fn);
				return 0;
			},
		},
		configurable: true,
		writable: true,
	});
	Object.defineProperty(globalThis, "speechSynthesis", {
		value: speechSynthesis,
		configurable: true,
		writable: true,
	});
	return fake;
}

const LOCAL: FakeVoice = { voiceURI: "local-1", name: "System Voice", lang: "en-US", localService: true };

console.log("NRL-141 CORE C1: a second hasLocalVoice() after an empty first schedules no poll timers");
{
	const fake = probeFake();
	const engine = new WebSpeechEngine();
	const first = await engine.hasLocalVoice();
	const firstTimers = fake.timers;
	fake.timers = 0;
	const second = await engine.hasLocalVoice();
	check("C1 first call false", first === false);
	check("C1 first call did poll (non-vacuous)", firstTimers > 0, String(firstTimers));
	check("C1 second call false", second === false);
	check("C1 second call schedules 0 timers", fake.timers === 0, `scheduled ${fake.timers}`);
}

console.log("NRL-141 CORE C2: isAvailable() after an empty hasLocalVoice() reuses the same outcome");
{
	const fake = probeFake();
	const engine = new WebSpeechEngine();
	await engine.hasLocalVoice();
	fake.timers = 0;
	const result = await engine.isAvailable();
	check("C2 still unavailable", result.available === false);
	check("C2 isAvailable schedules 0 timers", fake.timers === 0, `scheduled ${fake.timers}`);
	fake.timers = 0;
	const local = await engine.listLocalVoices();
	check("C2 listLocalVoices empty", local.length === 0);
	check("C2 listLocalVoices schedules 0 timers", fake.timers === 0, `scheduled ${fake.timers}`);
}

console.log("NRL-141 CORE C3: concurrent hasLocalVoice() + isAvailable() share one poll loop");
{
	const solo = probeFake();
	await new WebSpeechEngine().hasLocalVoice();
	const oneLoop = solo.timers;

	const fake = probeFake();
	const engine = new WebSpeechEngine();
	const [has, avail] = await Promise.all([engine.hasLocalVoice(), engine.isAvailable()]);
	check("C3 both report no voice", has === false && avail.available === false);
	check(
		"C3 the pair schedules exactly one loop's timers",
		oneLoop > 0 && fake.timers === oneLoop,
		`pair ${fake.timers}, one loop ${oneLoop}`,
	);
}

console.log("NRL-141 CORE C4: listVoices() sees voices that arrive by voiceschanged after an empty answer");
{
	const fake = probeFake();
	const engine = new WebSpeechEngine();
	const before = await engine.listVoices();
	check("C4 empty before", before.length === 0);
	fake.voices = [LOCAL];
	fake.fire();
	const after = await engine.listVoices();
	check("C4 listVoices returns the late voice", after.length === 1 && after[0]?.id === "webspeech:local-1", JSON.stringify(after));
}

console.log("NRL-141 GUARD G1: cached empty, then voiceschanged with a local voice -> hasLocalVoice() true");
{
	const fake = probeFake();
	const engine = new WebSpeechEngine();
	check("G1 empty first", (await engine.hasLocalVoice()) === false);
	fake.voices = [LOCAL];
	fake.fire();
	check("G1 local voice now seen", (await engine.hasLocalVoice()) === true);
	check("G1 isAvailable now true", (await engine.isAvailable()).available === true);
}

console.log("NRL-141 GUARD G2: voices that appear with NO event are still picked up by a fresh read");
{
	const fake = probeFake();
	const engine = new WebSpeechEngine();
	check("G2 empty first", (await engine.hasLocalVoice()) === false);
	fake.voices = [LOCAL];
	check("G2 hasLocalVoice true without voiceschanged", (await engine.hasLocalVoice()) === true);
	const listed = await engine.listLocalVoices();
	check("G2 listLocalVoices finds it", listed.length === 1, JSON.stringify(listed));
}

console.log("NRL-141 GUARD G3: a late voice that is not confirmed local stays fail-closed");
{
	const fake = probeFake();
	const engine = new WebSpeechEngine();
	await engine.hasLocalVoice();
	fake.voices = [
		{ voiceURI: "remote-1", name: "Cloud Voice", lang: "en-US", localService: false },
		{ voiceURI: "unknown-1", name: "Mystery Voice", lang: "en-GB" },
	];
	fake.fire();
	check("G3 hasLocalVoice false", (await engine.hasLocalVoice()) === false);
	check("G3 listLocalVoices empty", (await engine.listLocalVoices()).length === 0);
}

console.log("NRL-141 GUARD G4: a cached empty answer never becomes a voice by itself");
{
	const fake = probeFake();
	const engine = new WebSpeechEngine();
	await engine.hasLocalVoice();
	fake.fire(); // an event that brought no voices
	check("G4 hasLocalVoice false after an empty event", (await engine.hasLocalVoice()) === false);
	const result = await engine.isAvailable();
	check(
		"G4 zero-voices reason byte-identical",
		!result.available &&
			result.reason ===
				"No voices are installed for this platform's speech synthesis. Install a system voice and retry.",
		!result.available ? result.reason : "available:true",
	);
}

console.log("NRL-141 GUARD G5: no-API reason byte-identical");
{
	Object.defineProperty(globalThis, "window", { value: undefined, configurable: true, writable: true });
	const result = await new WebSpeechEngine().isAvailable();
	check(
		"G5 no-API reason",
		!result.available && result.reason === "This platform has no Web Speech API.",
		!result.available ? result.reason : "available:true",
	);
}

console.log("NRL-141 NEW BEHAVIOUR N1: dispose() leaves no voiceschanged listener behind");
{
	const fake = probeFake();
	const engine = new WebSpeechEngine();
	await engine.hasLocalVoice();
	await engine.isAvailable();
	await engine.dispose();
	check("N1 no listeners after dispose", fake.listeners.size === 0, `left ${fake.listeners.size}`);
}

console.log("");
if (failures > 0) {
	console.log(`${failures} FAILURE(S)`);
	process.exit(1);
}
console.log("all webspeech local-voice tests passed");
