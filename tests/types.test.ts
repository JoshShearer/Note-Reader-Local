/**
 * `describeUnavailable` (NRL-25 ship fix): joins an `isAvailable()` reason
 * with a generic next step, guaranteeing exactly one sentence break.
 *
 * Found during /ship's adversarial pass: every engine's `isAvailable()`
 * catch-all branch interpolates a caught error's `.message`, which usually
 * carries no trailing punctuation. `main.ts` concatenated that directly
 * against "Pick another engine in settings.", producing a run-on
 * ("...vault adapter Pick another engine in settings.") for exactly the
 * message this ticket exists to make readable. `main.ts` itself imports
 * `obsidian` at module scope and cannot be bundled in bare Node (the same
 * blocker documented for `registry.ts`), so the fix is isolated here as a
 * pure function instead.
 */

import { describeUnavailable } from "../src/audio/types.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
	if (cond) console.log(`  ok   ${name}`);
	else {
		failures += 1;
		console.log(`  FAIL ${name} ${detail}`);
	}
}

console.log("describeUnavailable joins a reason and a next step with exactly one sentence break");
{
	const withPeriod = describeUnavailable(
		"Kokoro weights are missing. Download them from settings.",
		"Pick another engine in settings.",
	);
	check(
		"a reason that already ends in a period is not doubled up",
		withPeriod ===
			"Kokoro weights are missing. Download them from settings. Pick another engine in settings.",
		withPeriod,
	);
}
{
	// The exact shape a catch-all branch produces: an interpolated
	// Error#message, no trailing punctuation.
	const noPeriod = describeUnavailable(
		"Could not check whether Kokoro is installed: EIO reading vault adapter",
		"Pick another engine in settings.",
	);
	check(
		"a reason with no trailing punctuation gets one inserted, not run on",
		noPeriod ===
			"Could not check whether Kokoro is installed: EIO reading vault adapter. Pick another engine in settings.",
		noPeriod,
	);
	check("never a run-on: the reason and next step are not glued with no separator", !noPeriod.includes("adapter Pick"));
}
{
	const trailingWhitespace = describeUnavailable("No voices are installed.  ", "Pick another engine in settings.");
	check(
		"trailing whitespace before the missing terminator is trimmed, not preserved",
		trailingWhitespace === "No voices are installed. Pick another engine in settings.",
		trailingWhitespace,
	);
}
{
	const question = describeUnavailable("Is espeak-ng really missing?", "Pick another engine in settings.");
	check(
		"a non-period terminator (! or ?) is respected, not doubled",
		question === "Is espeak-ng really missing? Pick another engine in settings.",
		question,
	);
}

console.log("");
if (failures > 0) {
	console.log(`${failures} FAILURE(S)`);
	process.exit(1);
}
console.log("all types tests passed");
