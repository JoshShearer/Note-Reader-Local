/**
 * Automatic, quality-ranked engine selection (NRL-24, docs/adr/0010).
 *
 * Pure over `EngineProbe[]`, mirroring tests/affordances.test.ts's style: a
 * plain `check()` harness, no obsidian import needed since selection.ts has
 * none. The probes here stand in for what main.ts resolves from the real
 * engines (kokoro.isAvailable() + plannedBackend(), a subprocess
 * isAvailable(), webspeech's isAvailable() && hasLocalVoice()) - this file
 * never touches any of that, only the ranking rule itself.
 */

import {
	rankEngines,
	selectEngine,
	resolveSelection,
	type EngineProbe,
} from "../src/engines/selection.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
	if (cond) console.log(`  ok   ${name}`);
	else {
		failures += 1;
		console.log(`  FAIL ${name} ${detail}`);
	}
}

const espeakOn: EngineProbe = { id: "espeak", available: true };
const espeakOff: EngineProbe = { id: "espeak", available: false };
const speechdOn: EngineProbe = { id: "speechd", available: true };
const speechdOff: EngineProbe = { id: "speechd", available: false };
const webOn: EngineProbe = { id: "webspeech", available: true };
const webOff: EngineProbe = { id: "webspeech", available: false };
const kokoroGpuLive: EngineProbe = { id: "kokoro", available: true, kokoroGpuFp32Live: true };
const kokoroCpuOnly: EngineProbe = { id: "kokoro", available: true, kokoroGpuFp32Live: false };
const kokoroUnavailable: EngineProbe = { id: "kokoro", available: false, kokoroGpuFp32Live: false };

console.log("GPU/fp32-live kokoro outranks speech-dispatcher");
{
	const ranked = rankEngines([kokoroGpuLive, speechdOn, espeakOff, webOff]);
	check("kokoro is first", ranked[0]?.id === "kokoro", JSON.stringify(ranked));
	check(
		"reason mentions the GPU/live path",
		/gpu/i.test(ranked[0]?.reason ?? ""),
		ranked[0]?.reason,
	);
}

console.log("CPU-only kokoro (the recorded clarification) ranks below speech-dispatcher");
{
	// This is the direct test of the clarification answer: "Automatic picks
	// Kokoro only when the GPU/fp32 path is live; any CPU Kokoro path ranks
	// below speech-dispatcher."
	const ranked = rankEngines([kokoroCpuOnly, speechdOn, espeakOff, webOff]);
	check("top pick is speechd, not kokoro", ranked[0]?.id === "speechd", JSON.stringify(ranked));
}

console.log("kokoro unavailable (fresh install): speechd is picked immediately");
{
	const ranked = rankEngines([kokoroUnavailable, speechdOn, espeakOff, webOff]);
	check("speechd first", ranked[0]?.id === "speechd", JSON.stringify(ranked));
	check(
		"reason does not mention downloading anything",
		!/download/i.test(ranked[0]?.reason ?? ""),
		ranked[0]?.reason,
	);
}

console.log("everything unavailable except espeak: espeak is picked");
{
	const ranked = rankEngines([kokoroUnavailable, speechdOff, espeakOn, webOff]);
	check("espeak", ranked[0]?.id === "espeak", JSON.stringify(ranked));
}

console.log("everything unavailable except webspeech (already confirmed local): webspeech is picked");
{
	const ranked = rankEngines([kokoroUnavailable, speechdOff, espeakOff, webOn]);
	check("webspeech", ranked[0]?.id === "webspeech", JSON.stringify(ranked));
}

console.log(
	"webspeech probe available:false (no local voice found) never silently wins, even if isAvailable() alone would have been true",
);
{
	// This is the test that pins the binding correction at the
	// selection-algorithm level: the caller is responsible for folding
	// hasLocalVoice() into `available` before this module ever sees it, and
	// this module must never second-guess that by picking webspeech anyway.
	const result = selectEngine([kokoroUnavailable, speechdOff, espeakOff, webOff]);
	check("falls through to the nothing-is-ready result", result.id === "kokoro", JSON.stringify(result));
	check(
		"reason is actionable, not a silent webspeech pick",
		/download|install/i.test(result.reason),
		result.reason,
	);
}

console.log("a CPU-only kokoro still outranks webspeech (5-tier order, not the 4-tier one)");
{
	// Deviation from the plan's literal rankEngines() sketch, which only ever
	// put kokoro in the list when kokoroGpuFp32Live: true. The task's own
	// ranking table is 5 tiers - GPU/fp32 kokoro > speechd > espeak > CPU
	// kokoro > webspeech - and the clarification's wording ("ranks below
	// speech-dispatcher") is consistent with CPU kokoro still being a
	// candidate, just a low one, rather than excluded outright. This test
	// pins that reading.
	const ranked = rankEngines([kokoroCpuOnly, speechdOff, espeakOff, webOn]);
	check("CPU kokoro beats webspeech", ranked[0]?.id === "kokoro", JSON.stringify(ranked));
	check("webspeech is still present, just second", ranked[1]?.id === "webspeech", JSON.stringify(ranked));
}

console.log("manual pin always wins over automatic ranking, never re-ranked");
{
	const result = resolveSelection("espeak", [kokoroGpuLive, speechdOn, espeakOn, webOn]);
	check("espeak, even though kokoro is GPU-live", result.id === "espeak", JSON.stringify(result));
	check("reason says it was manual", /manual/i.test(result.reason), result.reason);
}

console.log("resolveSelection(\"auto\", ...) delegates to selectEngine()");
{
	const result = resolveSelection("auto", [kokoroGpuLive, speechdOn, espeakOn, webOn]);
	check("picks kokoro", result.id === "kokoro", JSON.stringify(result));
}

console.log("all probes unavailable: selectEngine never throws and never returns undefined");
{
	const result = selectEngine([kokoroUnavailable, speechdOff, espeakOff, webOff]);
	check("defined result", result !== undefined && result !== null);
	check("names kokoro", result.id === "kokoro", result.id);
	check("actionable reason", result.reason.length > 0, result.reason);
}

console.log("");
if (failures > 0) {
	console.log(`${failures} FAILURE(S)`);
	process.exit(1);
}
console.log("all engine selection tests passed");
