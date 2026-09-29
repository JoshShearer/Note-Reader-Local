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

console.log("");
if (failures > 0) {
	console.log(`${failures} FAILURE(S)`);
	process.exit(1);
}
console.log("all webspeech local-voice tests passed");
