/**
 * Exercises the real pipeline against engines that exist on this machine.
 *
 * speech-dispatcher is present with an espeak-ng output module, so this covers
 * a genuine end-to-end run: markdown in, audio out, word timings computed.
 */

import { extractChunks } from "../src/text/extract.ts";
import { parseWav, pcmToWav } from "../src/audio/wav.ts";
import { allocateWordTimings, wordAt } from "../src/audio/words.ts";
import { getProcessRunner } from "../src/engines/system/spawn.ts";
import { SpeechDispatcherEngine } from "../src/engines/system/speechd.ts";
import type { ProcessRunner, RunResult } from "../src/engines/system/spawn.ts";
import type { SpeechEngine, VoiceInfo } from "../src/audio/types.ts";
import { pickLocaleVoice, resolveStoredVoice } from "../src/audio/voiceChoice.ts";

let failures = 0;
let skipped = 0;
// NRL-69. Two regions of this file need a running speech-dispatcher daemon and
// an audio sink: the preamble below and the real-binary block further down,
// which speaks aloud and asserts wall-clock duration. A stock CI runner has
// neither, so they are bypassed when NRL_SKIP_REAL_SPEECHD is exactly "1".
// Exactly, not truthily: "0", "" or a typo must still run the real checks, so a
// mistyped variable can never quietly delete the only real-binary coverage this
// repo has. With the variable unset a missing binary or a dead daemon still
// fails the suite, which is why neither region is wrapped in a try/catch.
const SKIP_REAL_SPEECHD = process.env.NRL_SKIP_REAL_SPEECHD === "1";
function check(name: string, cond: boolean, detail = ""): void {
	if (cond) console.log(`  ok   ${name}`);
	else {
		failures += 1;
		console.log(`  FAIL ${name} ${detail}`);
	}
}
// A skip never touches `failures` and never prints `ok`, so a bypassed check
// cannot be read as a passing one.
function skip(name: string): void {
	skipped += 1;
	console.log(`  SKIP ${name} (NRL_SKIP_REAL_SPEECHD=1)`);
}

console.log(`NRL_SKIP_REAL_SPEECHD=${process.env.NRL_SKIP_REAL_SPEECHD ?? "(unset)"}`);
console.log(
	SKIP_REAL_SPEECHD
		? "speech-dispatcher real-binary checks are skipped here"
		: "speech-dispatcher is usable here",
);
const runner = getProcessRunner();
const spd = new SpeechDispatcherEngine(runner);
if (SKIP_REAL_SPEECHD) {
	skip("spd-say on PATH");
	skip("reports available");
} else {
	check("spd-say on PATH", (await runner.which("spd-say")) !== null);
	check("reports available", (await spd.isAvailable()).available);
}

// A trimmed copy of real `spd-say -L` output. The NAME column already
// carries the variant, which is what the old id format got wrong.
const SPD_LIST = [
	"                     NAME                 LANGUAGE                  VARIANT",
	"                Afrikaans                       af                     none",
	"           Afrikaans+Adam                       af                     Adam",
	"      English (Caribbean)                   en-029                     none",
	"        English (America)                    en-US                     none",
	"   English (America)+Adam                    en-US                     Adam",
	"  English (Great Britain)                    en-GB                     none",
	"",
].join("\n");

const TEXT = "Testing one two three.";
const CHUNK = {
	id: "test1",
	sequence: 0,
	blockType: "paragraph" as const,
	filePath: "test.md",
	text: TEXT,
	sourceIndex: [],
	sourceStart: 0,
	sourceEnd: TEXT.length,
};

/** Fake runner: canned voice list, scripted reply for every speaking call. */
function fakeRunner(reply: Partial<RunResult> & { stdoutText?: string }) {
	const calls: { args: string[]; stdin?: string }[] = [];
	const runner: ProcessRunner = {
		async run(_cmd, args, stdin) {
			if (args[0] === "-L") return { code: 0, signal: null, stderr: "", stdout: Buffer.from(SPD_LIST) };
			// NRL-55's module-attribution probe. Answering -O with a failure is
			// what keeps this default fake producing all-"unknown" voices, which
			// is the behaviour the assertions below were written against. The
			// -o …-L arm exists only so a probe that ignored the failed -O would
			// not land in `calls` and corrupt every calls.at(-1) assertion.
			if (args[0] === "-O") return { code: 1, signal: null, stderr: "", stdout: Buffer.from("") };
			if (args[0] === "-o" && args.includes("-L")) {
				return { code: 0, signal: null, stderr: "", stdout: Buffer.from(SPD_LIST) };
			}
			calls.push({ args, stdin });
			return {
				code: reply.code ?? 0,
				signal: reply.signal ?? null,
				stderr: reply.stderr ?? "",
				stdout: reply.stdout ?? Buffer.from(reply.stdoutText ?? ""),
			};
		},
		async spawn() {
			throw new Error("not used");
		},
		async which() {
			return "/usr/bin/spd-say";
		},
	};
	return { runner, calls };
}

async function synthErr(engine: SpeechDispatcherEngine): Promise<Error | null> {
	try {
		await engine.synthesize({ chunk: CHUNK, rate: 1, pitch: 0 }, new AbortController().signal);
		return null;
	} catch (err) {
		return err as Error;
	}
}

console.log("speechd: failures are not silent (fake runner)");
{
	// What spd-say actually does when given no text: usage on stdout, exit 1,
	// nothing on stderr. The old guard needed stderr, so this "succeeded".
	const usage = "send text-to-speech output request to speech-dispatcher\n\nUsage: spd-say [options] \"some text\"\n";
	const { runner } = fakeRunner({ code: 1, stdoutText: usage });
	const spd2 = new SpeechDispatcherEngine(runner);
	const err = await synthErr(spd2);
	check("non-zero exit with empty stderr throws", err !== null);
	check("error message is the fixed string", err?.message === "Speech synthesis failed", `got ${err?.message}`);
	check("error message carries no stdout", !!err && !err.message.includes("Usage"));
}
{
	// A bad voice type: spd-say says so on stdout and exits 0.
	const { runner } = fakeRunner({ code: 0, stdoutText: "Invalid voice\n" + TEXT });
	const spd2 = new SpeechDispatcherEngine(runner);
	const err = await synthErr(spd2);
	check("'Invalid voice' on stdout with exit 0 throws", err !== null);
	check("error does not echo note text", !!err && !err.message.includes(TEXT));
}
{
	// With -e, stdout is an echo of the text. A note that itself says
	// "Invalid voice" must not be mistaken for a failure.
	const { runner } = fakeRunner({ code: 0, stdoutText: "Invalid voice\nmore" });
	const spd2 = new SpeechDispatcherEngine(runner);
	try {
		await spd2.synthesize(
			{ chunk: { ...CHUNK, text: "Invalid voice\nmore" }, rate: 1, pitch: 0 },
			new AbortController().signal,
		);
		check("echoed note text is not a failure", true);
	} catch {
		check("echoed note text is not a failure", false);
	}
}
{
	const { runner, calls } = fakeRunner({ code: 0, stdoutText: TEXT });
	const spd2 = new SpeechDispatcherEngine(runner);
	const voices = await spd2.listVoices();
	const variant = voices.find((v) => v.name.includes("Adam") && v.lang === "af");
	check("variant voice listed", variant !== undefined);
	check("variant id is the NAME column", variant?.id === "speechd:Afrikaans+Adam", `got ${variant?.id}`);
	// NRL-26: `spd-say -L` has no module column (verified live on this
	// machine), so no speechd voice's network need is ever knowable. Every
	// voice must report "unknown" on both fields, never a guessed boolean.
	check("every voice reports local: unknown", voices.every((v) => v.local === "unknown"), JSON.stringify(voices.map((v) => v.local)));
	check("every voice reports requiresNetwork: unknown", voices.every((v) => v.requiresNetwork === "unknown"), JSON.stringify(voices.map((v) => v.requiresNetwork)));
	if (variant) {
		await spd2.selectVoice(variant);
		const err = await synthErr(spd2);
		check("variant voice speaks", err === null, `${err?.message}`);
		const args = calls.at(-1)?.args ?? [];
		check(
			"argv is -w -e -y NAME",
			JSON.stringify(args.slice(0, 4)) === JSON.stringify(["-w", "-e", "-y", "Afrikaans+Adam"]),
			JSON.stringify(args),
		);
		check("never passes -t", !args.includes("-t"));
		check("text is not in argv", !args.some((a) => a.includes(TEXT)));
		check("text goes on stdin", calls.at(-1)?.stdin === TEXT);
	}
}

/**
 * NRL-55: module attribution via the undocumented `spd-say -o <module> -L`
 * scoping, gated by a runtime differential self-check.
 *
 * Every case here uses a fake ProcessRunner: none of them talks to the real
 * daemon. The point of the whole block is that every failure mode lands on
 * "unknown" rather than on a guessed `true`, because `srs.md` R-S01 forbids
 * claiming a voice is offline when the backend cannot determine it.
 */
/**
 * One `-O` reply, shared by both `-O` fields below.
 *
 * It is a named alias rather than two spelled-out unions because
 * `attributionRunner` narrows a single `spec` variable for both calls: the two
 * arms have to stay structurally identical or the narrowing stops compiling, and
 * an alias makes that impossible to break by editing one of them.
 *
 * A name array is wrapped in the real "OUTPUT MODULES" header and answers
 * `code: 0, signal: null`. `signal` is what the real spawn.ts reports for a
 * child that was terminated rather than exiting, which arrives alongside
 * `code: 0` (cases I-L). `delayMs` holds the reply back so the probe's own
 * deadline can expire during this `-O` run, which only the CLOSING call needs
 * today (case M5); it lives on the alias because the alias is shared, not
 * because the opening call has a use for it.
 */
type OutputModulesSpec =
	| string[]
	| { code: number; stdout: string; delayMs?: number; signal?: NodeJS.Signals | null };
/**
 * One `attributionRunner()` handle serves exactly ONE `probeAttribution()`, i.e.
 * exactly one `SpeechDispatcherEngine` instance. Attribution is memoised per
 * instance, so case G's two sequential `listVoices()` calls and its two
 * concurrent ones are still one probe and still obey this.
 *
 * NRL-83, why the constraint exists: `oCalls` lives on the runner, not on the
 * probe, so "call 1 is the opener, call 2 is NRL-71's closer" only holds while
 * one runner serves one probe. A third `-O` makes `modulesAgain` answer a second
 * probe's OPENING call, so that probe takes the divergent module set as its
 * BASELINE, sees no divergence and attributes - the opposite of what such a case
 * would be written to express, and a pass for the wrong reason.
 *
 * Breaking it is recorded on the handle's `violations` array rather than thrown,
 * and every block below asserts that array empty via `noReuse()`. Case M6 is the
 * one deliberate exception: it reuses a runner on purpose to measure exactly this
 * divergence, so it carries no `noReuse()` guard.
 */
interface AttributionScript {
	/** `-O` reply. See {@link OutputModulesSpec}. */
	modules?: OutputModulesSpec;
	/**
	 * Reply to the CLOSING `-O` only, i.e. NRL-71's atomicity re-read. Same alias
	 * as `modules`.
	 *
	 * Left undefined, both `-O` calls answer with the same bytes, so every case
	 * written before NRL-71 keeps its fixtures verbatim and becomes a free control
	 * arm proving the re-read did not switch attribution off. That is why `modules`
	 * was not turned into a consumed queue: a queue would have required every
	 * existing case to grow a second entry. A, B, F, G and K are those free arms,
	 * and the default is kept for them (NRL-87 decision).
	 *
	 * The side effect of that default, recorded because it silently cost coverage
	 * once: leaving it unset also replays the case's INJECTED FAILURE onto the
	 * closing `-O`, so a case whose failure is meant to be caught earlier can end
	 * up being caught at the closing call instead, and the guard it was written to
	 * pin stops discriminating. Measured by mutation (NRL-87): with case J's
	 * `modulesAgain` unset, deleting the opening run's `modulesRun.signal !== null`
	 * clause - or the whole opening guard - left the suite green. So a case that
	 * injects a failure into `modules` and means it to land on the OPENING run must
	 * set an explicit clean `modulesAgain`, as J now does.
	 */
	modulesAgain?: OutputModulesSpec;
	/**
	 * `-o <module> -L` replies, per module. "throw" makes run() reject,
	 * `delayMs` holds the reply back so the probe's own deadline can expire
	 * first (case H), and `signal` marks the child as signal-terminated.
	 */
	lists?: Record<
		string,
		| string
		| { code: number; stdout?: string; delayMs?: number; signal?: NodeJS.Signals | null }
		| "throw"
	>;
	/** Bare `-L` reply, i.e. what listVoices() itself enumerates. */
	bare: string;
}
function attributionRunner(script: AttributionScript) {
	const scopedCalls: string[] = [];
	const violations: string[] = [];
	const oAborted: boolean[] = [];
	let oCalls = 0;
	const runner: ProcessRunner = {
		async run(_cmd, args, _stdin, signal): Promise<RunResult> {
			if (args[0] === "-O") {
				oCalls += 1;
				// NRL-83. Recorded, never thrown: probeAttribution() ends in a bare
				// `catch { return null; }`, so a throw here would be laundered into
				// exactly the silent give-up this cap exists to make loud. `<= 2`
				// rather than `=== 2` because a future path may legitimately skip
				// the closing `-O`; what is forbidden is a THIRD call, i.e. a second
				// probe on the same runner. See the contract on AttributionScript.
				if (oCalls > 2)
					violations.push(`-O call ${oCalls}: one runner served more than one probe`);
				const spec = (oCalls > 1 ? script.modulesAgain : undefined) ?? script.modules ?? [];
				if (Array.isArray(spec)) {
					oAborted.push(signal?.aborted === true);
					return {
						code: 0,
						signal: null,
						stderr: "",
						stdout: Buffer.from(["OUTPUT MODULES", ...spec, ""].join("\n")),
					};
				}
				// Same hold-back the `-o <m> -L` branch below applies, so a probe
				// deadline can expire during an `-O` run rather than only during a
				// per-module listing (case M5).
				if (spec.delayMs) await new Promise((r) => setTimeout(r, spec.delayMs));
				// NRL-84. Record WHICH signal this run was handed, by the only
				// property that distinguishes them here: whether it had already
				// aborted when the reply was produced. Nothing else in this fake
				// reads the signal at all, so without this a change that passed the
				// OUTER controller to the closing run instead of its own scope
				// would be invisible to every case in the file (measured: that
				// mutation left the whole suite green before this was added).
				//
				// Deliberately an OBSERVATION and not a behaviour: the real runner
				// SIGKILLs an aborted child, and modelling that here would make the
				// closing run's `againRun.signal !== null` clause catch M5's
				// expired closing budget instead of its abort clause, which would
				// cost M5 its pin on exactly the clause it exists to pin.
				oAborted.push(signal?.aborted === true);
				return {
					code: spec.code,
					signal: spec.signal ?? null,
					stderr: "",
					stdout: Buffer.from(spec.stdout),
				};
			}
			if (args[0] === "-o" && args[2] === "-L") {
				const module = args[1]!;
				scopedCalls.push(module);
				const reply = script.lists?.[module];
				if (reply === "throw") throw new Error("spd-say could not be spawned");
				if (typeof reply === "string")
					return { code: 0, signal: null, stderr: "", stdout: Buffer.from(reply) };
				if (reply) {
					if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
					return {
						code: reply.code,
						signal: reply.signal ?? null,
						stderr: "",
						stdout: Buffer.from(reply.stdout ?? ""),
					};
				}
				throw new Error(`unscripted module: ${module}`);
			}
			if (args[0] === "-L")
				return { code: 0, signal: null, stderr: "", stdout: Buffer.from(script.bare) };
			throw new Error(`unexpected call: ${args.join(" ")}`);
		},
		async spawn() {
			throw new Error("not used");
		},
		async which() {
			return "/usr/bin/spd-say";
		},
	};
	// oCount is a function, not a number: `oCalls` is captured by value at return
	// time, so a plain property would read 0 in every assertion. `violations` is
	// deliberately NOT a function for the mirror-image reason: an array is
	// captured by reference and mutated in place, so it already reads correctly
	// at assertion time.
	// oAborted is an array mutated in place, so it reads correctly at assertion
	// time for the same reason `violations` does; see the note above.
	return { runner, scopedCalls, oCount: () => oCalls, violations, oAborted };
}

/** Build a `spd-say -L` listing from rows, column widths as spd-say prints them. */
function spdList(rows: [name: string, lang: string, variant: string][]): string {
	return [
		"                     NAME                 LANGUAGE                  VARIANT",
		...rows.map(([n, l, v]) => `${n.padStart(25)}${l.padStart(25)}${v.padStart(25)}`),
		"",
	].join("\n");
}

const ESPEAK_ROWS: [string, string, string][] = [
	["Afrikaans", "af", "none"],
	["Afrikaans+Adam", "af", "Adam"],
	["English (America)", "en-US", "none"],
];
const ESPEAK_LIST = spdList(ESPEAK_ROWS);
const OPENJTALK_LIST = spdList([["Default", "ja", "none"]]);
const FESTIVAL_LIST = spdList([["Festival Voice", "en-US", "none"]]);

/**
 * NRL-83. Every block but M6 obeys the one-runner-one-probe contract documented
 * on {@link AttributionScript}, so its handle must come back with no recorded
 * violations. These are GUARDS - green before and after the cap was added - not
 * pins on a defect: they exist so a later edit that quietly reuses a runner
 * fails loudly instead of passing for the wrong reason.
 */
function noReuse(tag: string, h: { violations: string[] }): void {
	check(`${tag}: the harness made at most two -O calls`, h.violations.length === 0, JSON.stringify(h.violations));
}

/** local must never be false, on any path: the engine can only ever say true or unknown. */
function neverFalse(voices: VoiceInfo[]): boolean {
	return voices.every((v) => v.local !== false && v.requiresNetwork !== true);
}
function localOf(voices: VoiceInfo[], name: string): VoiceInfo["local"] | "missing" {
	return voices.find((v) => v.id === `speechd:${name}`)?.local ?? "missing";
}
function networkOf(voices: VoiceInfo[], name: string): VoiceInfo["requiresNetwork"] | "missing" {
	return voices.find((v) => v.id === `speechd:${name}`)?.requiresNetwork ?? "missing";
}

console.log("speechd: module attribution resolves known-local voices (fake runner, NRL-55)");
{
	// A. Two allowlisted modules with genuinely different row sets, which is
	// what this machine really looks like (espeak-ng + openjtalk).
	const { violations, runner } = attributionRunner({
		modules: ["espeak-ng", "openjtalk"],
		lists: { "espeak-ng": ESPEAK_LIST, openjtalk: OPENJTALK_LIST },
		bare: spdList([...ESPEAK_ROWS, ["Default", "ja", "none"], ["Ghost", "xx", "none"]]),
	});
	const spd2 = new SpeechDispatcherEngine(runner);
	const voices = await spd2.listVoices();
	check("A: espeak voice is local", localOf(voices, "Afrikaans") === true, `${localOf(voices, "Afrikaans")}`);
	check("A: espeak variant is local", localOf(voices, "Afrikaans+Adam") === true, `${localOf(voices, "Afrikaans+Adam")}`);
	check("A: openjtalk voice is local", localOf(voices, "Default") === true, `${localOf(voices, "Default")}`);
	check("A: requiresNetwork is the exact negation", networkOf(voices, "Afrikaans") === false, `${networkOf(voices, "Afrikaans")}`);
	// A name in the bare listing that no module claimed cannot be attributed.
	check("A: an unattributed name stays unknown", localOf(voices, "Ghost") === "unknown", `${localOf(voices, "Ghost")}`);
	check("A: nothing reports local false", neverFalse(voices));
	noReuse("A", { violations });
}
{
	// B. A module that is not on the allowlist. Its voices stay unknown even
	// though the differential proved scoping works.
	const { violations, runner } = attributionRunner({
		modules: ["espeak-ng", "festival"],
		lists: { "espeak-ng": ESPEAK_LIST, festival: FESTIVAL_LIST },
		bare: spdList([...ESPEAK_ROWS, ["Festival Voice", "en-US", "none"]]),
	});
	const voices = await new SpeechDispatcherEngine(runner).listVoices();
	check("B: allowlisted module's voice is local", localOf(voices, "Afrikaans") === true, `${localOf(voices, "Afrikaans")}`);
	check("B: non-allowlisted module's voice stays unknown", localOf(voices, "Festival Voice") === "unknown", `${localOf(voices, "Festival Voice")}`);
	check("B: and its requiresNetwork stays unknown", networkOf(voices, "Festival Voice") === "unknown", `${networkOf(voices, "Festival Voice")}`);
	check("B: nothing reports local false", neverFalse(voices));
	noReuse("B", { violations });
}
{
	// C. The measured hazard, and the reason for the whole differential gate.
	// On this machine `spd-say -o no-such-module -L` exits 0 and returns the
	// full 13363-line default list, so a build that ignores -o hands every
	// module the same listing. A naive allowlist would then call 13,362
	// espeak-ng voices local on a build where -o means nothing.
	const { violations, runner } = attributionRunner({
		modules: ["espeak-ng", "openjtalk"],
		lists: { "espeak-ng": ESPEAK_LIST, openjtalk: ESPEAK_LIST },
		bare: ESPEAK_LIST,
	});
	const voices = await new SpeechDispatcherEngine(runner).listVoices();
	check(
		"C: identical listings per module means -o is ignored: every voice unknown",
		voices.length > 0 && voices.every((v) => v.local === "unknown" && v.requiresNetwork === "unknown"),
		JSON.stringify(voices.map((v) => v.local)),
	);
	noReuse("C", { violations });
}
{
	// D. A scoped listing that fails. Not a partial attribution: the module we
	// could not read might be exactly the one that made a name ambiguous.
	const { violations, runner } = attributionRunner({
		modules: ["espeak-ng", "openjtalk"],
		lists: { "espeak-ng": ESPEAK_LIST, openjtalk: { code: 1 } },
		bare: ESPEAK_LIST,
	});
	const voices = await new SpeechDispatcherEngine(runner).listVoices();
	check("D: a non-zero -o listing leaves everything unknown", voices.length === 3 && voices.every((v) => v.local === "unknown"), JSON.stringify(voices.map((v) => v.local)));
	noReuse("D", { violations });
}
{
	// D2. Same, but run() rejects rather than exiting non-zero.
	const { violations, runner } = attributionRunner({
		modules: ["espeak-ng", "openjtalk"],
		lists: { "espeak-ng": ESPEAK_LIST, openjtalk: "throw" },
		bare: ESPEAK_LIST,
	});
	let escaped: unknown = null;
	let voices: VoiceInfo[] = [];
	try {
		voices = await new SpeechDispatcherEngine(runner).listVoices();
	} catch (e) {
		escaped = e;
	}
	check("D2: a throwing -o listing does not escape listVoices", escaped === null, `${(escaped as Error | null)?.message}`);
	check("D2: and leaves the voices listed and unknown", voices.length === 3 && voices.every((v) => v.local === "unknown"), JSON.stringify(voices.map((v) => v.local)));
	noReuse("D2", { violations });
}
{
	// D3. An unparseable scoped listing. Zero rows must not be treated as a
	// module that "differs" from the others: that would falsely prove scoping.
	const { violations, runner } = attributionRunner({
		modules: ["espeak-ng", "openjtalk"],
		lists: { "espeak-ng": ESPEAK_LIST, openjtalk: "some unrelated output\n" },
		bare: ESPEAK_LIST,
	});
	const voices = await new SpeechDispatcherEngine(runner).listVoices();
	check("D3: an unparseable -o listing leaves everything unknown", voices.length === 3 && voices.every((v) => v.local === "unknown"), JSON.stringify(voices.map((v) => v.local)));
	noReuse("D3", { violations });
}
{
	// E. One module only: nothing to compare, so no differential is possible.
	const { violations, runner, scopedCalls } = attributionRunner({
		modules: ["espeak-ng"],
		lists: { "espeak-ng": ESPEAK_LIST },
		bare: ESPEAK_LIST,
	});
	const voices = await new SpeechDispatcherEngine(runner).listVoices();
	check("E: a single output module leaves everything unknown", voices.length === 3 && voices.every((v) => v.local === "unknown"), JSON.stringify(voices.map((v) => v.local)));
	check("E: and no scoped listing is even attempted", scopedCalls.length === 0, JSON.stringify(scopedCalls));
	noReuse("E", { violations });
}
{
	// E2. -O itself fails, and -O without its header.
	const failing = attributionRunner({ modules: { code: 1, stdout: "" }, bare: ESPEAK_LIST });
	const v1 = await new SpeechDispatcherEngine(failing.runner).listVoices();
	check("E2: a failed -O leaves everything unknown", v1.length === 3 && v1.every((v) => v.local === "unknown"), JSON.stringify(v1.map((v) => v.local)));
	const headerless = attributionRunner({ modules: { code: 0, stdout: "espeak-ng\nopenjtalk\n" }, bare: ESPEAK_LIST });
	const v2 = await new SpeechDispatcherEngine(headerless.runner).listVoices();
	check("E2: -O with no OUTPUT MODULES header leaves everything unknown", v2.every((v) => v.local === "unknown"), JSON.stringify(v2.map((v) => v.local)));
	noReuse("E2 (failing)", failing);
	noReuse("E2 (headerless)", headerless);
}
{
	// F. Ambiguity. A NAME served by both an allowlisted and a non-allowlisted
	// module cannot be called local: we do not know which one would speak it.
	const { violations, runner } = attributionRunner({
		modules: ["espeak-ng", "festival"],
		lists: {
			"espeak-ng": ESPEAK_LIST,
			festival: spdList([["Afrikaans", "af", "none"], ["Festival Voice", "en-US", "none"]]),
		},
		bare: spdList([...ESPEAK_ROWS, ["Festival Voice", "en-US", "none"]]),
	});
	const voices = await new SpeechDispatcherEngine(runner).listVoices();
	check("F: a name served by two modules, one not allowlisted, stays unknown", localOf(voices, "Afrikaans") === "unknown", `${localOf(voices, "Afrikaans")}`);
	check("F: an unambiguous allowlisted name is still local", localOf(voices, "Afrikaans+Adam") === true, `${localOf(voices, "Afrikaans+Adam")}`);
	check("F: nothing reports local false", neverFalse(voices));
	noReuse("F", { violations });
}
{
	// G. The probe costs a full listing per module (0.387s for espeak-ng on
	// this machine), and listVoices() runs on every settings-tab render, so it
	// must be paid once per engine instance.
	const { violations, runner, scopedCalls } = attributionRunner({
		modules: ["espeak-ng", "openjtalk"],
		lists: { "espeak-ng": ESPEAK_LIST, openjtalk: OPENJTALK_LIST },
		bare: ESPEAK_LIST,
	});
	const spd2 = new SpeechDispatcherEngine(runner);
	await spd2.listVoices();
	await spd2.listVoices();
	check("G: the probe runs once per instance, not once per listVoices", scopedCalls.length === 2, JSON.stringify(scopedCalls));
	const concurrent = attributionRunner({
		modules: ["espeak-ng", "openjtalk"],
		lists: { "espeak-ng": ESPEAK_LIST, openjtalk: OPENJTALK_LIST },
		bare: ESPEAK_LIST,
	});
	const spd3 = new SpeechDispatcherEngine(concurrent.runner);
	const [a, b] = await Promise.all([spd3.listVoices(), spd3.listVoices()]);
	check("G: two concurrent listVoices share one probe", concurrent.scopedCalls.length === 2, JSON.stringify(concurrent.scopedCalls));
	check("G: and both get the attribution", localOf(a!, "Afrikaans") === true && localOf(b!, "Afrikaans") === true);
	noReuse("G (sequential)", { violations });
	noReuse("G (concurrent)", concurrent);
}
{
	// H. The probe deadline has to fail closed, and the exit code cannot tell it
	// that it expired. Measured this session against the real runner: aborting
	// kills the child with SIGKILL, the child closes with `code === null`, and
	// NodeProcessRunner resolves `code ?? 0` (spawn.ts:56), i.e. zero, carrying
	// whatever stdout arrived before the kill. So a listing cut short by the
	// deadline looks like a successful short listing.
	//
	// That is not merely less information. Here festival really serves
	// "Afrikaans" as well as espeak-ng, exactly as in case F, but the listing
	// that arrives after the deadline has lost that row. The ambiguity which
	// should keep Afrikaans unknown disappears with it, and the voice would be
	// reported local although a non-allowlisted module serves it - the claim
	// `srs.md` R-S01 forbids. The same truncation makes two otherwise identical
	// listings differ, so it can also carry the differential gate on a build
	// that ignores `-o` altogether.
	const { violations, runner } = attributionRunner({
		modules: ["espeak-ng", "festival"],
		lists: {
			"espeak-ng": ESPEAK_LIST,
			festival: {
				code: 0,
				stdout: spdList([["Festival Voice", "en-US", "none"]]),
				delayMs: 60,
			},
		},
		bare: spdList([...ESPEAK_ROWS, ["Festival Voice", "en-US", "none"]]),
	});
	const voices = await new SpeechDispatcherEngine(runner, 10).listVoices();
	check(
		"H: a listing that lands after the deadline attributes nothing",
		voices.length === 4 && voices.every((v) => v.local === "unknown" && v.requiresNetwork === "unknown"),
		JSON.stringify(voices.map((v) => `${v.id}=${String(v.local)}`)),
	);
	check("H: and the ambiguous name is not called local", localOf(voices, "Afrikaans") !== true, `${localOf(voices, "Afrikaans")}`);
	check("H: nothing reports local false", neverFalse(voices));
	noReuse("H", { violations });
}
{
	// H2 (NRL-87). Case H above pins that a deadline fails closed. When this case
	// was written H could not also pin the LOOP's own `controller.signal.aborted`
	// clause: its delayed module is the last of two, so deleting that clause left
	// H's verdict and call trace alike. Case H was therefore left byte-identical
	// and this sibling took the pin.
	//
	// NRL-84 changed that, and H is still left byte-identical. With the closing
	// `-O` on its own controller, H's expired OUTER deadline no longer reaches
	// that run, so deleting the loop clause makes H attribute and H goes red too.
	// Re-measured: mutation P1 now turns four checks red across H and H2, where
	// it turned one.
	//
	// Three modules with the deadline on the MIDDLE one, so the clause has
	// somewhere to fail: the loop must stop at festival and never query openjtalk.
	//
	// CORRECTED BY NRL-84. This comment used to say the verdict was deliberately
	// not the discriminator, because "with the clause deleted the probe runs the
	// whole loop and is then caught by the closing `-O`'s own abort check, so
	// every voice is still unknown". That stopped being true when the closing
	// `-O` got its own controller: the outer deadline no longer reaches it, so
	// with the loop clause deleted the closing run answers cleanly under its own
	// budget and the probe ATTRIBUTES. Re-measured after the fix, deleting the
	// loop's abort clause turns BOTH checks below red, not only the call trace.
	// The call trace is kept as a check in its own right - it is the only thing
	// that says WHERE the loop stopped, and it was the sole discriminator for
	// the whole of NRL-87 - but it is no longer the only observable that moves.
	const { violations, runner, scopedCalls } = attributionRunner({
		modules: ["espeak-ng", "festival", "openjtalk"],
		lists: {
			"espeak-ng": ESPEAK_LIST,
			festival: { code: 0, stdout: FESTIVAL_LIST, delayMs: 60 },
			openjtalk: OPENJTALK_LIST,
		},
		bare: spdList([...ESPEAK_ROWS, ["Festival Voice", "en-US", "none"], ["Default", "ja", "none"]]),
	});
	const voices2 = await new SpeechDispatcherEngine(runner, 10).listVoices();
	check(
		"H2: a deadline inside the per-module loop attributes nothing",
		voices2.length === 5 && voices2.every((v) => v.local === "unknown" && v.requiresNetwork === "unknown"),
		JSON.stringify(voices2.map((v) => `${v.id}=${String(v.local)}`)),
	);
	check("H2: nothing reports local false", neverFalse(voices2));
	check(
		"H2: and the loop stops at the module the deadline expired on",
		scopedCalls.join(",") === "espeak-ng,festival",
		JSON.stringify(scopedCalls),
	);
	noReuse("H2", { violations });
}
/**
 * Cases I-L: the same truncation as case H, but caused by a kill the plugin did
 * not issue. Case H's guard is `controller.signal.aborted`, which only ever sees
 * our own deadline; an external `SIGTERM` (an OOM killer, a session teardown, a
 * user's `pkill`) leaves that flag false. Measured this session against the real
 * `NodeProcessRunner.run`: an externally SIGTERMed child closes with
 * `code === null, signal === "SIGTERM"`, node's `close` handler discarded the
 * second argument, and run() resolved `code: 0` with stdout cut short
 * ("line1\nline2\n" of three lines). So the only remaining way to tell a
 * truncated listing from a short one is the terminating signal, which
 * `RunResult.signal` now carries.
 *
 * Three modules throughout, so dropping the non-allowlisted one still leaves the
 * two the differential gate needs.
 */
const FESTIVAL_SHARES_EN = spdList([
	["English (America)", "en-US", "none"],
	["Festival Voice", "en-US", "none"],
]);
const THREE_MODULES = ["espeak-ng", "openjtalk", "festival"];
const THREE_MODULE_BARE = spdList([...ESPEAK_ROWS, ["Festival Voice", "en-US", "none"]]);
{
	// I. The exact Verify failure. festival really serves "English (America)" as
	// well as espeak-ng, so that NAME is ambiguous and must stay unknown (case F).
	// Its listing arrives truncated past the shared row, as `code: 0` plus a
	// SIGTERM, and the lost row takes the ambiguity with it.
	const { violations, runner } = attributionRunner({
		modules: THREE_MODULES,
		lists: {
			"espeak-ng": ESPEAK_LIST,
			openjtalk: OPENJTALK_LIST,
			festival: { code: 0, stdout: FESTIVAL_LIST, signal: "SIGTERM" },
		},
		bare: THREE_MODULE_BARE,
	});
	const voices = await new SpeechDispatcherEngine(runner).listVoices();
	check(
		"I: a signal-terminated -o listing attributes nothing",
		voices.length === 4 && voices.every((v) => v.local === "unknown" && v.requiresNetwork === "unknown"),
		JSON.stringify(voices.map((v) => `${v.id}=${String(v.local)}`)),
	);
	check("I: the shared name is not called local", localOf(voices, "English (America)") === "unknown", `${localOf(voices, "English (America)")}`);
	check("I: and its requiresNetwork is not false", networkOf(voices, "English (America)") === "unknown", `${networkOf(voices, "English (America)")}`);
	check("I: nothing reports local false", neverFalse(voices));
	noReuse("I", { violations });
}
{
	// J. The same kill on the `-O` run instead. The truncated module list has
	// dropped festival, the only non-allowlisted module, so every remaining
	// module is allowlisted and the shared NAME would be attributed local - and
	// two modules are still listed, so the arity guard does not catch it either.
	//
	// NRL-87: `modulesAgain` is explicit and CLEAN, which is what makes this case
	// pin the opening run's signal check rather than NRL-71's closing one. Left
	// unset it defaults to `modules`, so the same SIGTERM was replayed onto the
	// closing `-O` and deleting the opening `modulesRun.signal !== null` clause -
	// or the whole opening guard - left the suite green (measured). With the
	// guard intact this field is inert: the probe gives up at the opening run and
	// the closing `-O` is never reached.
	const { violations, runner } = attributionRunner({
		modules: { code: 0, stdout: ["OUTPUT MODULES", "espeak-ng", "openjtalk", ""].join("\n"), signal: "SIGTERM" },
		modulesAgain: ["espeak-ng", "openjtalk"],
		lists: {
			"espeak-ng": ESPEAK_LIST,
			openjtalk: OPENJTALK_LIST,
			festival: FESTIVAL_SHARES_EN,
		},
		bare: THREE_MODULE_BARE,
	});
	const voices = await new SpeechDispatcherEngine(runner).listVoices();
	check(
		"J: a signal-terminated -O attributes nothing",
		voices.length === 4 && voices.every((v) => v.local === "unknown" && v.requiresNetwork === "unknown"),
		JSON.stringify(voices.map((v) => `${v.id}=${String(v.local)}`)),
	);
	check("J: nothing reports local false", neverFalse(voices));
	noReuse("J", { violations });
}
{
	// K. The control arm. Identical fixtures to I and J with every child exiting
	// normally: attribution must still happen, or the fix has simply switched the
	// probe off. Afrikaans is served by espeak-ng alone, English (America) by
	// espeak-ng and festival.
	const { violations, runner } = attributionRunner({
		modules: THREE_MODULES,
		lists: {
			"espeak-ng": ESPEAK_LIST,
			openjtalk: OPENJTALK_LIST,
			festival: FESTIVAL_SHARES_EN,
		},
		bare: THREE_MODULE_BARE,
	});
	const voices = await new SpeechDispatcherEngine(runner).listVoices();
	check("K: control, no signal: an unambiguous allowlisted name is local", localOf(voices, "Afrikaans") === true, `${localOf(voices, "Afrikaans")}`);
	check("K: control: the variant is local too", localOf(voices, "Afrikaans+Adam") === true, `${localOf(voices, "Afrikaans+Adam")}`);
	check("K: control: the shared name stays unknown", localOf(voices, "English (America)") === "unknown", `${localOf(voices, "English (America)")}`);
	check("K: control: nothing reports local false", neverFalse(voices));
	noReuse("K", { violations });
}
{
	// L. A signal can only ever cost information, never invert it: even when the
	// killed module is the allowlisted one, no voice may come back local: false.
	const { violations, runner } = attributionRunner({
		modules: THREE_MODULES,
		lists: {
			"espeak-ng": { code: 0, stdout: spdList([["Afrikaans", "af", "none"]]), signal: "SIGKILL" },
			openjtalk: OPENJTALK_LIST,
			festival: FESTIVAL_SHARES_EN,
		},
		bare: THREE_MODULE_BARE,
	});
	const voices = await new SpeechDispatcherEngine(runner).listVoices();
	check("L: a signal on the allowlisted module's listing yields only unknown", voices.every((v) => v.local === "unknown"), JSON.stringify(voices.map((v) => String(v.local))));
	check("L: and never local false", neverFalse(voices));
	noReuse("L", { violations });
}

/**
 * NRL-71: the probe is a sequence of separate `spd-say` runs, so the daemon's
 * module set can change underneath it. Module ADDITION is the direction that can
 * produce a wrong `local: true`, because a non-allowlisted module configured in
 * after `-O` was read serves names the probe never sees it serving. So `-O` is
 * run again at the end and the parsed module set must be unchanged.
 *
 * The cases below are the divergence arms. The control arms come for free from
 * the cases above that attribute today and set no `modulesAgain`, so each now
 * answers both `-O` calls with the same bytes: A, B, F, G (including its
 * `scopedCalls.length === 2` memo assertion and its two-concurrent-listVoices
 * assertion) and K. C, D, D2, D3, E, E2, H, H2, I, J and L give up before the
 * closing `-O` is ever reached, so they are unaffected by construction rather
 * than by assertion; a reviewer should not expect them to move.
 *
 * J is the one exception to "unset means a free control arm" (NRL-87): it sets
 * an explicit clean `modulesAgain` precisely so its injected SIGTERM is not
 * replayed onto the closing call, because that replay was catching the case
 * before the opening guard it exists to pin was reached. See the comment on
 * `AttributionScript.modulesAgain`.
 */
{
	// M1. A module appears between the two `-O` calls. Only the first `-O`'s two
	// modules are ever queried, so festival deliberately gets no `lists` entry:
	// an unscripted module throws, which would make the case pass for the wrong
	// reason. Pre-NRL-71 this fixture attributes (Afrikaans === true).
	const { violations, runner, oCount } = attributionRunner({
		modules: ["espeak-ng", "openjtalk"],
		modulesAgain: THREE_MODULES,
		lists: { "espeak-ng": ESPEAK_LIST, openjtalk: OPENJTALK_LIST },
		bare: THREE_MODULE_BARE,
	});
	const voices = await new SpeechDispatcherEngine(runner).listVoices();
	check(
		"M1: a module set that changed under the probe attributes nothing",
		voices.length === 4 && voices.every((v) => v.local === "unknown" && v.requiresNetwork === "unknown"),
		JSON.stringify(voices.map((v) => `${v.id}=${String(v.local)}`)),
	);
	check("M1: nothing reports local false", neverFalse(voices));
	check("M1: the closing -O really ran", oCount() === 2, `${oCount()}`);
	noReuse("M1", { violations });
}
{
	// M2. The same set in reversed order. The daemon is not promised a stable
	// module order, so this is the case that pins "compare the parsed set, not the
	// stdout bytes": a byte comparison gives up here and costs every voice its
	// attribution for nothing.
	const { violations, runner, oCount } = attributionRunner({
		modules: ["espeak-ng", "openjtalk"],
		modulesAgain: ["openjtalk", "espeak-ng"],
		lists: { "espeak-ng": ESPEAK_LIST, openjtalk: OPENJTALK_LIST },
		bare: spdList([...ESPEAK_ROWS, ["Default", "ja", "none"], ["Ghost", "xx", "none"]]),
	});
	const voices = await new SpeechDispatcherEngine(runner).listVoices();
	check("M2: a reordered module set still attributes", localOf(voices, "Afrikaans") === true, `${localOf(voices, "Afrikaans")}`);
	check("M2: and the other module's voice too", localOf(voices, "Default") === true, `${localOf(voices, "Default")}`);
	check("M2: nothing reports local false", neverFalse(voices));
	check("M2: the closing -O really ran", oCount() === 2, `${oCount()}`);
	noReuse("M2", { violations });
}
{
	// M3. The closing `-O` is signal-terminated while reporting the same module
	// set, so only the signal check can catch it. Without this case the closing
	// run's `RunResult.signal` check is only established by reading the code.
	const { violations, runner } = attributionRunner({
		modules: ["espeak-ng", "openjtalk"],
		modulesAgain: {
			code: 0,
			stdout: ["OUTPUT MODULES", "espeak-ng", "openjtalk", ""].join("\n"),
			signal: "SIGTERM",
		},
		lists: { "espeak-ng": ESPEAK_LIST, openjtalk: OPENJTALK_LIST },
		bare: spdList([...ESPEAK_ROWS, ["Default", "ja", "none"]]),
	});
	const voices = await new SpeechDispatcherEngine(runner).listVoices();
	check(
		"M3: a signal-terminated closing -O attributes nothing",
		voices.every((v) => v.local === "unknown" && v.requiresNetwork === "unknown"),
		JSON.stringify(voices.map((v) => `${v.id}=${String(v.local)}`)),
	);
	check("M3: nothing reports local false", neverFalse(voices));
	noReuse("M3", { violations });
}
{
	// M4. The closing `-O` exits non-zero while reporting the SAME module set, so
	// only the exit-code check can catch it. The set has to match for this case to
	// mean anything: with an empty or truncated stdout the set comparison catches
	// it instead, M1 already pins that comparison, and deleting the `code !== 0`
	// clause then leaves the whole suite green. Mutation-checked both ways.
	const { violations, runner } = attributionRunner({
		modules: ["espeak-ng", "openjtalk"],
		modulesAgain: {
			code: 1,
			stdout: ["OUTPUT MODULES", "espeak-ng", "openjtalk", ""].join("\n"),
		},
		lists: { "espeak-ng": ESPEAK_LIST, openjtalk: OPENJTALK_LIST },
		bare: spdList([...ESPEAK_ROWS, ["Default", "ja", "none"]]),
	});
	const voices = await new SpeechDispatcherEngine(runner).listVoices();
	check(
		"M4: a non-zero closing -O attributes nothing",
		voices.every((v) => v.local === "unknown" && v.requiresNetwork === "unknown"),
		JSON.stringify(voices.map((v) => `${v.id}=${String(v.local)}`)),
	);
	check("M4: nothing reports local false", neverFalse(voices));
	noReuse("M4", { violations });
}
{
	// M5 (NRL-87). A deadline expires DURING the closing `-O`, which is the one
	// thing only that run's own abort clause can catch: the reply itself is a
	// perfectly good one - code 0, no signal, the same two modules - so the
	// signal check (M3), the exit-code check (M4) and the set comparison (M1, M2)
	// all pass it. Deleting that clause attributes Afrikaans local. Before this
	// case it was green under that deletion, i.e. unpinned.
	//
	// RE-FIXTURED BY NRL-84, and the move is deliberate rather than cosmetic.
	// The deadline this case expires is now the CLOSING one - a generous outer
	// budget and a tiny closing one - because NRL-84 gave the closing `-O` its
	// own controller precisely so the OUTER deadline can no longer discard a
	// clean reply. Left on the outer budget this case would have pinned the
	// behaviour the fix removes, and the clause it exists to pin would have gone
	// unpinned again. M5 and M7 now hold the two opposite halves of that guard:
	// M5 says the closing budget MUST discard, M7 says the outer one must NOT.
	//
	// `oCount() === 2` is load-bearing rather than decoration: it is what proves
	// the deadline fired during the CLOSING run and not earlier. Without it the
	// case could silently degrade into being caught by the loop's abort clause -
	// which would leave the verdict identical and the closing clause unpinned
	// again, the exact failure NRL-87 exists to fix.
	//
	// Margins, measured this session: the 60 ms held-back reply against a 10 ms
	// closing budget is the file's existing 6x convention (case H), and the
	// 5,000 ms outer budget is ~80x the ~60 ms the whole case takes, so the
	// outer timer cannot fire at all. A slipped margin makes this case RED, not
	// silently green.
	const { violations, runner, oCount } = attributionRunner({
		modules: ["espeak-ng", "openjtalk"],
		modulesAgain: {
			code: 0,
			stdout: ["OUTPUT MODULES", "espeak-ng", "openjtalk", ""].join("\n"),
			delayMs: 60,
		},
		lists: { "espeak-ng": ESPEAK_LIST, openjtalk: OPENJTALK_LIST },
		bare: spdList([...ESPEAK_ROWS, ["Default", "ja", "none"]]),
	});
	const voices = await new SpeechDispatcherEngine(runner, 5000, 10).listVoices();
	check(
		"M5: a deadline that expires during the closing -O attributes nothing",
		voices.every((v) => v.local === "unknown" && v.requiresNetwork === "unknown"),
		JSON.stringify(voices.map((v) => `${v.id}=${String(v.local)}`)),
	);
	check("M5: nothing reports local false", neverFalse(voices));
	check("M5: the closing budget fired on the closing -O, not before it", oCount() === 2, `${oCount()}`);
	noReuse("M5", { violations });
}
{
	// M7 (NRL-84). The mirror image of M5, and the case the ticket is about. The
	// OUTER probe deadline expires while the closing `-O` is in flight, and that
	// run answers cleanly anyway - code 0, no signal, the identical module set.
	// It must be believed, not discarded.
	//
	// Before NRL-84 the closing run shared the outer controller, so this fixture
	// gave up and every voice reported "unknown" for the life of the engine
	// instance (the give-up is memoised with no retry). Reproduced against the
	// unmodified file before the fix: this check failed with all four voices
	// "unknown" while `oCount() === 2` passed, i.e. the closing `-O` really ran
	// and really answered. Deleting `controller.signal.aborted ||` from the
	// closing guard was the single edit that flipped it green, which is what
	// identifies the outer abort as the sole cause.
	//
	// So M7 pins the ABSENCE of the outer clause from that guard while M5 pins
	// the PRESENCE of the inner one. They must stay opposite: a guard carrying
	// both clauses would set both flags on M5's fixture, and each clause alone
	// would then survive deletion while the pair only looked pinned.
	//
	// Margins, measured this session over 12 runs with the real module bundled:
	// everything before the closing run finished at worst +2 ms against the
	// 200 ms outer budget (100x), and the closing reply cannot arrive before
	// +400 ms because `setTimeout` is never early, so it is always still in
	// flight when the outer timer fires at +200 ms. The closing budget is 5,000
	// ms, 12x the 400 ms reply. A slipped margin means the loop overran the outer
	// budget, the loop's own abort clause gives up, and this case goes RED - it
	// cannot slip into being silently green.
	const { violations, runner, oCount, oAborted } = attributionRunner({
		modules: ["espeak-ng", "openjtalk"],
		modulesAgain: {
			code: 0,
			stdout: ["OUTPUT MODULES", "espeak-ng", "openjtalk", ""].join("\n"),
			delayMs: 400,
		},
		lists: { "espeak-ng": ESPEAK_LIST, openjtalk: OPENJTALK_LIST },
		bare: spdList([...ESPEAK_ROWS, ["Default", "ja", "none"]]),
	});
	const voices = await new SpeechDispatcherEngine(runner, 200, 5000).listVoices();
	check(
		"M7: a clean closing -O is not discarded by the OUTER deadline",
		localOf(voices, "Afrikaans") === true,
		JSON.stringify(voices.map((v) => `${v.id}=${String(v.local)}`)),
	);
	check("M7: nothing reports local false", neverFalse(voices));
	check("M7: the closing -O really ran", oCount() === 2, `${oCount()}`);
	// The outer signal HAS aborted by now (the timer fired at +200 ms and the
	// reply lands at +400 ms), so a closing run handed the outer controller
	// would record true here. Recording false is what says it was handed its own
	// scope. Without this check, passing `controller.signal` to that run instead
	// of `closingScope.signal` left the whole suite green (measured, NRL-84).
	check(
		"M7: and it did not run under the outer probe signal",
		oAborted[1] === false,
		JSON.stringify(oAborted),
	);
	noReuse("M7", { violations });
}
{
	// M6 (NRL-83). The one deliberate violation of the one-runner-one-probe
	// contract documented on `AttributionScript`, and the case the cap inside
	// `attributionRunner` exists for. ONE runner serves TWO probes - two engine
	// instances, because attribution is memoised per instance, so two instances
	// is what makes two probes - which is four `-O` calls through one counter.
	//
	// `oCalls` lives on the runner, so calls 3 and 4 are probe 2's OPENING and
	// CLOSING calls and BOTH are answered with `modulesAgain`. Probe 2 therefore
	// takes the divergent three-module set as its baseline, sees no divergence
	// and attributes, while probe 1 sees calls 1 and 2, spots the change and
	// correctly gives up. One script, two probes, opposite verdicts.
	//
	// festival gets a `lists` entry here, unlike M1, precisely so probe 2 runs to
	// completion and attributes instead of dying on "unscripted module": the
	// divergence has to be reachable for this case to show it.
	//
	// This block must NOT get the `noReuse` guard every other block carries. It
	// is the deliberate violator, so guarding it would assert the opposite of
	// what it measures.
	const { runner, violations, oCount } = attributionRunner({
		modules: ["espeak-ng", "openjtalk"],
		modulesAgain: THREE_MODULES,
		lists: {
			"espeak-ng": ESPEAK_LIST,
			openjtalk: OPENJTALK_LIST,
			festival: FESTIVAL_LIST,
		},
		bare: THREE_MODULE_BARE,
	});
	const probe1 = await new SpeechDispatcherEngine(runner).listVoices();
	const probe2 = await new SpeechDispatcherEngine(runner).listVoices();
	check(
		"M6: reusing one runner across two probes is recorded, not swallowed",
		violations.length === 2,
		`${violations.length}: ${JSON.stringify(violations)}`,
	);
	// Guards, green on both sides of the cap. They establish that the reuse the
	// violation names really happened, and that the hazard it warns about is
	// real. (c) is deliberately phrased as "the two probes disagree" rather than
	// "probe 2 says true", so nothing here pins the wrong verdict as expected.
	check("M6: guard: the shared runner really made four -O calls", oCount() === 4, `${oCount()}`);
	check(
		"M6: guard: the two probes disagree although the script is one script",
		localOf(probe1, "Afrikaans") !== localOf(probe2, "Afrikaans"),
		`probe1=${String(localOf(probe1, "Afrikaans"))} probe2=${String(localOf(probe2, "Afrikaans"))}`,
	);
}
{
	// In -e mode spd-say runs any line starting "!-!" as a raw SSIP command
	// instead of speaking it: the sentence vanishes with exit 0, and note
	// text gets to drive the daemon. A leading space defuses it.
	const bang = "!-!Third one\n!-!SET SELF RATE -100";
	const calls: { stdin?: string }[] = [];
	const runner: ProcessRunner = {
		async run(_cmd, args, stdin) {
			if (args[0] === "-L") return { code: 0, signal: null, stderr: "", stdout: Buffer.from(SPD_LIST) };
			calls.push({ stdin });
			// spd-say -e echoes what it read, byte for byte.
			return { code: 0, signal: null, stderr: "", stdout: Buffer.from(stdin ?? "") };
		},
		async spawn() {
			throw new Error("not used");
		},
		async which() {
			return "/usr/bin/spd-say";
		},
	};
	const spd2 = new SpeechDispatcherEngine(runner);
	let err: Error | null = null;
	try {
		await spd2.synthesize({ chunk: { ...CHUNK, text: bang }, rate: 1, pitch: 0 }, new AbortController().signal);
	} catch (e) {
		err = e as Error;
	}
	const sent = calls.at(-1)?.stdin ?? "";
	check("no stdin line starts with the SSIP command prefix", !/^!-!/m.test(sent), JSON.stringify(sent));
	check("the words are still sent", sent.includes("Third one"));
	check("defused echo is not a failure", err === null, `${err?.message}`);
}
{
	const { runner, calls } = fakeRunner({ code: 0 });
	const spd2 = new SpeechDispatcherEngine(runner);
	await spd2.selectVoice({ id: "speechd:NoSuchVoice", name: "x", lang: "xx", gender: "neutral", engineId: "speechd", local: "unknown", requiresNetwork: "unknown" });
	const err = await synthErr(spd2);
	check("unknown voice throws", err !== null);
	check("unknown voice message", err?.message === "Requested voice unavailable", `got ${err?.message}`);
	check("unknown voice never reaches spd-say", calls.length === 0, `${calls.length} calls`);
}

/**
 * Fake runner for the abort path.
 *
 * The speaking call (-w) stays pending until its signal aborts, which is what
 * spawn.ts does for real: it SIGKILLs the child, and the killed spd-say then
 * resolves as a successful empty run. Control calls can be held pending on
 * request, so the ordering between the cancel and the next utterance is
 * observable rather than assumed.
 */
interface AbortCall {
	args: string[];
	stdin?: string;
	done: boolean;
	/** Speaking calls still unfinished when this call was made. */
	speakersOpen: number;
}
function abortRunner(opts: { holdCancel?: boolean } = {}) {
	const calls: AbortCall[] = [];
	let releaseCancel: (() => void) | null = null;
	const openSpeakers = (): number =>
		calls.filter((c) => c.args.includes("-w") && !c.done).length;

	const runner: ProcessRunner = {
		async run(_cmd, args, stdin, signal): Promise<RunResult> {
			if (args[0] === "-L") return { code: 0, signal: null, stderr: "", stdout: Buffer.from(SPD_LIST) };
			const call: AbortCall = { args, stdin, done: false, speakersOpen: openSpeakers() };
			calls.push(call);
			if (args.includes("-w")) {
				await new Promise<void>((resolve) => {
					if (signal?.aborted) resolve();
					else signal?.addEventListener("abort", () => resolve(), { once: true });
				});
			} else if (opts.holdCancel) {
				await new Promise<void>((resolve) => {
					releaseCancel = resolve;
				});
			}
			call.done = true;
			return { code: 0, signal: null, stderr: "", stdout: Buffer.from("") };
		},
		async spawn() {
			throw new Error("not used");
		},
		async which() {
			return "/usr/bin/spd-say";
		},
	};
	return {
		runner,
		calls,
		speaking: (): AbortCall[] => calls.filter((c) => c.args.includes("-w")),
		cancels: (): AbortCall[] => calls.filter((c) => c.args.includes("-S")),
		releaseCancel: (): void => releaseCancel?.(),
	};
}

async function tick(): Promise<void> {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
}

console.log("speechd: aborting mid-utterance stops the daemon, not just the client");
{
	// SIGKILLing spd-say only kills the client. The daemon already has the text
	// and keeps speaking it, so stop and replay were up to a sentence late
	// (measured on this machine off the sink monitor: 7509 ms of audio still
	// playing after Player.stop(), against 90 ms with this fix).
	const h = abortRunner();
	const spd2 = new SpeechDispatcherEngine(h.runner);
	const ac = new AbortController();
	const p = spd2
		.synthesize({ chunk: CHUNK, rate: 1, pitch: 0 }, ac.signal)
		.catch(() => undefined);
	await tick();
	check("utterance is in flight", h.speaking().length === 1, `${h.speaking().length}`);
	check("no cancel before the abort", h.cancels().length === 0);

	ac.abort();
	const cancel = h.cancels()[0];
	check("abort issues a cancel", cancel !== undefined, JSON.stringify(h.calls.map((c) => c.args)));
	check("cancel is exactly -S", JSON.stringify(cancel?.args) === '["-S"]', JSON.stringify(cancel?.args));
	// -C cancels every client's messages, including a screen reader's queue.
	check("never -C", !h.calls.some((c) => c.args.includes("-C")), JSON.stringify(h.calls.map((c) => c.args)));
	check("cancel carries no stdin", cancel?.stdin === undefined, JSON.stringify(cancel?.stdin));
	check("cancel carries no note text in argv", !(cancel?.args ?? []).some((a) => a.includes(TEXT)));
	check(
		"cancel is issued while the utterance is still in flight",
		cancel?.speakersOpen === 1,
		`${cancel?.speakersOpen}`,
	);
	await p;
}
{
	// -S is SSIP STOP ALL, not connection-scoped, so a stray one cuts off
	// whatever a screen reader sharing the daemon is saying.
	const { runner, calls } = fakeRunner({ code: 0, stdoutText: TEXT });
	const spd2 = new SpeechDispatcherEngine(runner);
	const ac = new AbortController();
	await spd2.synthesize({ chunk: CHUNK, rate: 1, pitch: 0 }, ac.signal);
	check("a successful utterance issues no -S", !calls.some((c) => c.args.includes("-S")), JSON.stringify(calls.map((c) => c.args)));
	ac.abort();
	await tick();
	check(
		"aborting a signal whose utterance already finished issues no -S",
		!calls.some((c) => c.args.includes("-S")),
		JSON.stringify(calls.map((c) => c.args)),
	);
}
{
	const h = abortRunner();
	const spd2 = new SpeechDispatcherEngine(h.runner);
	const ac = new AbortController();
	ac.abort();
	let err: Error | null = null;
	try {
		await spd2.synthesize({ chunk: CHUNK, rate: 1, pitch: 0 }, ac.signal);
	} catch (e) {
		err = e as Error;
	}
	check("a signal aborted on entry spawns no speaking process", h.speaking().length === 0, `${h.speaking().length}`);
	check("a signal aborted on entry issues no -S", h.cancels().length === 0, JSON.stringify(h.calls.map((c) => c.args)));
	check("a signal aborted on entry is not an error", err === null, `${err?.message}`);
}
{
	// Sequencing. If the replacement's SPEAK reaches the daemon before the
	// -S does, the STOP ALL stops the replacement and replay goes silent,
	// which is worse than replay being late.
	const h = abortRunner({ holdCancel: true });
	const spd2 = new SpeechDispatcherEngine(h.runner);
	const ac = new AbortController();
	const first = spd2
		.synthesize({ chunk: CHUNK, rate: 1, pitch: 0 }, ac.signal)
		.catch(() => undefined);
	await tick();
	ac.abort();
	await first;
	check("cancel issued on abort", h.cancels().length === 1, `${h.cancels().length}`);

	const ac2 = new AbortController();
	const second = spd2
		.synthesize({ chunk: CHUNK, rate: 1, pitch: 0 }, ac2.signal)
		.catch(() => undefined);
	await tick();
	check("replacement waits for the cancel to land", h.speaking().length === 1, `${h.speaking().length}`);
	h.releaseCancel();
	await tick();
	check("replacement speaks once the cancel has landed", h.speaking().length === 2, `${h.speaking().length}`);
	ac2.abort();
	await second;
}
{
	const h = abortRunner();
	const spd2 = new SpeechDispatcherEngine(h.runner);
	await spd2.dispose();
	check("dispose with nothing in flight issues no -S", h.calls.length === 0, JSON.stringify(h.calls.map((c) => c.args)));
}
{
	const h = abortRunner();
	const spd2 = new SpeechDispatcherEngine(h.runner);
	const ac = new AbortController();
	const p = spd2
		.synthesize({ chunk: CHUNK, rate: 1, pitch: 0 }, ac.signal)
		.catch(() => undefined);
	await tick();
	await spd2.dispose();
	check("dispose with an utterance in flight issues -S", h.cancels().length === 1, JSON.stringify(h.calls.map((c) => c.args)));
	check("dispose never issues -C", !h.calls.some((c) => c.args.includes("-C")), JSON.stringify(h.calls.map((c) => c.args)));
	ac.abort();
	await p;
}

console.log("speechd: isAvailable() distinguishes its failure modes (fake runner, NRL-25)");
{
	// Binary missing entirely.
	const runner2: ProcessRunner = {
		async run() {
			throw new Error("should not run when which() fails");
		},
		async spawn() {
			throw new Error("not used");
		},
		async which() {
			return null;
		},
	};
	const spd2 = new SpeechDispatcherEngine(runner2);
	const result = await spd2.isAvailable();
	check("binary missing: not available", result.available === false);
	check(
		"binary missing: reason names spd-say",
		!result.available && result.reason.includes("spd-say"),
		!result.available ? result.reason : "available:true",
	);
}
{
	// This is the regression test for the latent bug this ticket fixes: the
	// old check was `/OUTPUT MODULES/i.test(stdout)`, which only confirms the
	// header line is present, never that any module name follows it. A
	// daemon with the header and zero modules configured must NOT be
	// reported available.
	const runner2: ProcessRunner = {
		async run(_cmd, args) {
			if (args[0] === "-O") return { code: 0, signal: null, stderr: "", stdout: Buffer.from("OUTPUT MODULES\n") };
			throw new Error(`unexpected call: ${args.join(" ")}`);
		},
		async spawn() {
			throw new Error("not used");
		},
		async which() {
			return "/usr/bin/spd-say";
		},
	};
	const spd2 = new SpeechDispatcherEngine(runner2);
	const result = await spd2.isAvailable();
	check(
		"header present but zero modules: not available (regression for the latent bug)",
		result.available === false,
		JSON.stringify(result),
	);
	check(
		"zero modules: reason mentions output module",
		!result.available && /output module/i.test(result.reason),
		!result.available ? result.reason : "available:true",
	);
}
{
	// -O reachable, real modules present: available.
	const runner2: ProcessRunner = {
		async run(_cmd, args) {
			if (args[0] === "-O") {
				return { code: 0, signal: null, stderr: "", stdout: Buffer.from("OUTPUT MODULES\nespeak-ng\nopenjtalk\n") };
			}
			throw new Error(`unexpected call: ${args.join(" ")}`);
		},
		async spawn() {
			throw new Error("not used");
		},
		async which() {
			return "/usr/bin/spd-say";
		},
	};
	const spd2 = new SpeechDispatcherEngine(runner2);
	const result = await spd2.isAvailable();
	check("real modules present: available", result.available === true, JSON.stringify(result));
}
{
	// -O reachable but returns something unrelated / non-zero: the generic
	// "could not be reached" bucket, deliberately not a fake "daemon
	// unreachable" distinction the probe cannot actually produce (spd-say
	// autospawns the daemon on connect, verified for real on this machine).
	const runner2: ProcessRunner = {
		async run(_cmd, args) {
			if (args[0] === "-O") return { code: 1, signal: null, stderr: "", stdout: Buffer.from("") };
			throw new Error(`unexpected call: ${args.join(" ")}`);
		},
		async spawn() {
			throw new Error("not used");
		},
		async which() {
			return "/usr/bin/spd-say";
		},
	};
	const spd2 = new SpeechDispatcherEngine(runner2);
	const result = await spd2.isAvailable();
	check("non-zero exit: not available", result.available === false, JSON.stringify(result));
	check(
		"non-zero exit: generic could-not-be-reached reason",
		!result.available && /could not be reached/i.test(result.reason),
		!result.available ? result.reason : "available:true",
	);
}
{
	// run() throws: caught, not propagated, reason carries the message.
	const runner2: ProcessRunner = {
		async run() {
			throw new Error("ECONNREFUSED talking to spd-say");
		},
		async spawn() {
			throw new Error("not used");
		},
		async which() {
			return "/usr/bin/spd-say";
		},
	};
	const spd2 = new SpeechDispatcherEngine(runner2);
	const result = await spd2.isAvailable();
	check("probe throws: not available, does not propagate", result.available === false);
	check(
		"probe throws: reason carries the thrown message",
		!result.available && result.reason.includes("ECONNREFUSED talking to spd-say"),
		!result.available ? result.reason : "available:true",
	);
}

console.log("voice ids resolve across the format change");
{
	const { runner } = fakeRunner({});
	const spd2 = new SpeechDispatcherEngine(runner);
	const voices = await spd2.listVoices();
	const resolve = (id: string) => spd2.resolveVoiceId?.(id, voices)?.id;
	check("old variant id remaps", resolve("speechd:Afrikaans+Adam+Adam") === "speechd:Afrikaans+Adam", `got ${resolve("speechd:Afrikaans+Adam+Adam")}`);
	check("old base id remaps", resolve("speechd:English (America)+none") === "speechd:English (America)", `got ${resolve("speechd:English (America)+none")}`);
	check("new id resolves to itself", resolve("speechd:English (America)+Adam") === "speechd:English (America)+Adam");
	check("absent id does not resolve", resolve("speechd:Klingon+none") === undefined);

	const old = resolveStoredVoice(spd2, "speechd:Afrikaans+Adam+Adam", voices, undefined, "en");
	check("old id: corrected voice", old.id === "speechd:Afrikaans+Adam", `got ${old.id}`);
	check("old id: no notice", old.notice === null, `got ${old.notice}`);

	const same = resolveStoredVoice(spd2, "speechd:English (Great Britain)", voices, undefined, "en");
	check("current id: same voice, no notice", same.id === "speechd:English (Great Britain)" && same.notice === null);

	const gone = resolveStoredVoice(spd2, "speechd:Klingon+none", voices, undefined, "en-US");
	check("absent id: substitutes by locale, not voices[0]", gone.id === "speechd:English (America)", `got ${gone.id}`);
	check("absent id: notice names the missing voice", !!gone.notice?.includes("Klingon"), `got ${gone.notice}`);
	check("absent id: notice names the substitute", !!gone.notice?.includes("English (America)"), `got ${gone.notice}`);

	// Another engine's id, e.g. the kokoro default, still gets a notice.
	const cross = resolveStoredVoice(spd2, "kokoro:af_heart", voices, undefined, "en-GB");
	check("cross-engine id: locale substitute", cross.id === "speechd:English (Great Britain)", `got ${cross.id}`);
	check("cross-engine id: notice", cross.notice !== null);

	const empty = resolveStoredVoice(spd2, "", voices, undefined, "fr");
	check("empty id: notice even with no locale match", empty.notice !== null);
	check("empty id: notice says no language match", !!empty.notice?.includes("fr"), `got ${empty.notice}`);
}
{
	const v = (id: string, lang: string, isVariant = false): VoiceInfo => ({
		id, name: id, lang, gender: "neutral", engineId: "speechd", isVariant, local: "unknown", requiresNetwork: "unknown",
	});
	const list = [v("a", "af"), v("b+x", "en-US", true), v("c", "en-GB"), v("d", "en-US")];
	check("locale: exact tag, preferring non-variant", pickLocaleVoice(list, "en-US")?.voice.id === "d");
	check("locale: case-insensitive, underscore", pickLocaleVoice(list, "en_gb")?.voice.id === "c");
	check("locale: primary subtag", pickLocaleVoice(list, "en")?.matched === true);
	check("locale: no match reports it", pickLocaleVoice(list, "ja")?.matched === false);

	// Obsidian's default language is plain "en". The first en-* row
	// speech-dispatcher lists is English (Caribbean); the deliberate default
	// is the language's most likely region (CLDR likely subtags: en -> US).
	const spdOrder = [v("car", "en-029"), v("gb", "en-GB"), v("scot", "en-GB-SCOTLAND"), v("us+x", "en-US", true), v("us", "en-US"), v("nyc", "en-US-NYC")];
	check("locale: bare en picks en-US, not the first en-* row", pickLocaleVoice(spdOrder, "en")?.voice.id === "us", `got ${pickLocaleVoice(spdOrder, "en")?.voice.id}`);
	check("locale: bare en prefers a plain en voice when one exists", pickLocaleVoice([...spdOrder, v("plain", "en")], "en")?.voice.id === "plain");
	check("locale: bare pt picks pt-BR", pickLocaleVoice([v("pt", "pt-PT"), v("br", "pt-BR")], "pt")?.voice.id === "br");
	check("locale: region with no exact row uses its subtags", pickLocaleVoice(spdOrder, "en-US-x-foo")?.voice.id === "us");
	check("locale: explicit region is respected", pickLocaleVoice(spdOrder, "en-GB")?.voice.id === "gb");
	check("locale: likely region missing falls back to any primary match", pickLocaleVoice([v("car", "en-029"), v("gb", "en-GB")], "en")?.matched === true);
}

console.log("speech-dispatcher speaks a variant voice (real binary)");
if (SKIP_REAL_SPEECHD) {
	// One SKIP line per assertion this block makes, under the same names, so a
	// CI log lines up one-for-one against a desktop run. The five variant
	// checks and the !-! check are nested behind finding a voice on the real
	// daemon; with no daemon there is nothing to find, so they are named here
	// rather than vanishing from the count.
	skip("voices found");
	skip("has english voices");
	skip("real daemon: no voice ever reports local false");
	skip("real daemon: local is true or unknown, never anything else");
	skip("real daemon: requiresNetwork is the negation of local");
	skip("real list: app language en picks English (America)");
	skip("has an english variant voice");
	skip("variant id round-trips");
	skip("variant voice does not throw");
	skip("returns streamed result");
	skip("estimates a duration");
	skip("took long enough to have spoken");
	skip("real daemon: a !-! chunk is spoken, not run as a command");
	skip("unknown voice throws against the real daemon");
} else {
	const voices = await spd.listVoices();
	check("voices found", voices.length > 0, `got ${voices.length}`);
	const en = voices.filter((v) => v.lang.toLowerCase().startsWith("en"));
	check("has english voices", en.length > 0, `got ${en.length}`);
	console.log(`       (${voices.length} total, ${en.length} english)`);
	// NRL-55, deliberately tolerant: the module set differs per machine, so the
	// suite asserts only the invariants, never this machine's counts. The count
	// itself is recorded in the ticket's live re-verification, not here.
	check("real daemon: no voice ever reports local false", voices.every((v) => v.local !== false), JSON.stringify(voices.filter((v) => v.local === false).map((v) => v.id)));
	check("real daemon: local is true or unknown, never anything else", voices.every((v) => v.local === true || v.local === "unknown"));
	check("real daemon: requiresNetwork is the negation of local", voices.every((v) => (v.local === true ? v.requiresNetwork === false : v.requiresNetwork === "unknown")));
	console.log(`       (${voices.filter((v) => v.local === true).length} attributed local, ${voices.filter((v) => v.local === "unknown").length} unknown)`);

	// Obsidian's default language against the real list.
	const forEn = pickLocaleVoice(voices, "en")?.voice;
	check("real list: app language en picks English (America)", forEn?.id === "speechd:English (America)", `got ${forEn?.id}`);

	// A variant: its spd-say NAME has a "+" in it.
	const variant = en.find((v) => v.id.replace(/^speechd:/, "").includes("+"));
	check("has an english variant voice", variant !== undefined);
	if (variant) {
		check("variant id round-trips", spd.resolveVoiceId?.(variant.id, voices)?.id === variant.id);
		await spd.selectVoice(variant);
		// Guard against a hung spd-say (it waits for stdin EOF with -e).
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), 15000);
		const started = Date.now();
		let result: Awaited<ReturnType<typeof spd.synthesize>> | null = null;
		let err: unknown = null;
		try {
			result = await spd.synthesize({ chunk: CHUNK, rate: 1, pitch: 0 }, ac.signal);
		} catch (e) {
			err = e;
		} finally {
			clearTimeout(timer);
		}
		const took = Date.now() - started;
		check("variant voice does not throw", err === null, `${(err as Error | null)?.message}`);
		check("returns streamed result", result?.kind === "streamed");
		check("estimates a duration", result?.kind === "streamed" && result.estimatedMs > 200);
		// -w blocks until the daemon finishes speaking. The broken path
		// returned in ~5ms having said nothing.
		check("took long enough to have spoken", took > 500 && !ac.signal.aborted, `${took}ms`);
		console.log(`       (spoke in ${took}ms)`);
	}

	// A chunk opening with "!-!" is spoken, not swallowed as an SSIP command
	// (measured this session: 5ms and silent raw, ~0.7s with a leading space).
	const us = voices.find((v) => v.id === "speechd:English (America)");
	if (us) {
		await spd.selectVoice(us);
		const bangStart = Date.now();
		let bangErr: unknown = null;
		try {
			await spd.synthesize({ chunk: { ...CHUNK, text: "!-!one two three four five six" }, rate: 1, pitch: 0 }, new AbortController().signal);
		} catch (e) {
			bangErr = e;
		}
		const bangTook = Date.now() - bangStart;
		check("real daemon: a !-! chunk is spoken, not run as a command", bangErr === null && bangTook > 300, `${bangTook}ms ${(bangErr as Error | null)?.message}`);
	}

	await spd.selectVoice({ id: "speechd:NoSuchVoice", name: "x", lang: "xx", gender: "neutral", engineId: "speechd", local: "unknown", requiresNetwork: "unknown" });
	let unknown: Error | null = null;
	try {
		await spd.synthesize({ chunk: CHUNK, rate: 1, pitch: 0 }, new AbortController().signal);
	} catch (e) {
		unknown = e as Error;
	}
	check("unknown voice throws against the real daemon", unknown?.message === "Requested voice unavailable", `got ${unknown?.message}`);
}

console.log("wav round-trip");
{
	const pcm = new Int16Array(24000).fill(1000);
	const wav = pcmToWav(pcm.buffer, 24000);
	check("is RIFF", Buffer.from(wav).subarray(0, 4).toString() === "RIFF");
	const info = parseWav(wav);
	check("sample rate round-trips", info.sampleRate === 24000, `got ${info.sampleRate}`);
	check("duration is ~1s", Math.abs(info.durationMs - 1000) < 2, `got ${info.durationMs}`);
}

console.log("word timings cover the sentence");
{
	// "a" needs to stand alone for the weight comparison to mean anything;
	// in "lazy" the a is part of a longer word.
	const src = "The quick brown fox jumps over a lazy dog.";
	const EXPECTED_WORDS = 9; // The quick brown fox jumps over a lazy dog.
	const chunks = extractChunks(src, {
		stripTags: true,
		speakUrls: false,
		skipCodeBlocks: true,
		skipInlineCode: true,
		skipTables: true,
		skipHeadings: false,
		skipFrontmatter: true,
		speakImageAlt: true,
		speakEmbeds: false,
		locale: "en",
	});
	const chunk = chunks[0]!;
	const words = allocateWordTimings(chunk, 2000);

	check("one timing per word", words.length === EXPECTED_WORDS, `got ${words.length}`);
	check("monotonic offsets", words.every((w, i) => i === 0 || w.offsetMs >= words[i - 1]!.offsetMs));
	check("last ends near duration", Math.abs((words.at(-1)!.offsetMs + words.at(-1)!.durationMs) - 2000) < 60);
	check("no overlap", words.every((w, i) => i === 0 || w.offsetMs >= words[i - 1]!.offsetMs + words[i - 1]!.durationMs - 0.001));

	// Heavier words should get a wider slot than light ones. "quick" has a
	// diphthong; "a" is a single vowel and the shortest word in the sentence.
	const byText = (want: string) =>
		words.find((w) => src.slice(w.sourceStart, w.sourceEnd) === want)!;
	const quick = byText("quick");
	const a = byText("a");
	check("found 'quick'", quick !== undefined);
	check("found 'a'", a !== undefined);
	if (quick && a) {
		check(
			"multi-syllable word outranks single vowel",
			quick.durationMs > a.durationMs,
			`${quick.durationMs} vs ${a.durationMs}`,
		);
	}

	// Every timing must land on real source text.
	const bad = words.filter((w) => {
		const got = src.slice(w.sourceStart, w.sourceEnd);
		return got !== chunk.text.slice(w.start, w.end);
	});
	check("timings land on matching source text", bad.length === 0, `${bad.length} mismatched`);

	check("lookup before first word is -1", wordAt(words, 0) === -1);
	check("lookup mid-sentence finds a word", wordAt(words, 1000) >= 0);
	check("lookup past end holds last word", wordAt(words, 99999) === words.length - 1);
}

/*
 * NRL-47 / ADR 0014, the end-to-end half.
 *
 * P3 is acceptance criterion 3 in its strongest form: the timings a player
 * actually receives must name the same raw-markdown characters they name in
 * the chunk text. P5 is acceptance criterion 2: the scripts that must not move
 * are asserted against durations captured from the code before this change.
 */
console.log("NRL-47 CJK word timings");
{
	const OPTS = {
		stripTags: true,
		speakUrls: false,
		skipCodeBlocks: true,
		skipInlineCode: true,
		skipTables: true,
		skipHeadings: false,
		skipFrontmatter: true,
		speakImageAlt: true,
		speakEmbeds: false,
		locale: "en",
	};

	// P3. Every timing lands on matching source text, on the CJK fixtures.
	for (const src of ["这是第一句。这是第二句。第三句结束了。", "日本語のテキストを読み上げます。", "안녕하세요세계반갑습니다."]) {
		const chunks = extractChunks(src, OPTS, undefined, "Notes/cjk.md");
		let bad = 0;
		let total = 0;
		for (const chunk of chunks) {
			for (const w of allocateWordTimings(chunk, 3000, 1)) {
				total += 1;
				if (src.slice(w.sourceStart, w.sourceEnd) !== chunk.text.slice(w.start, w.end)) bad += 1;
			}
		}
		// `total > chunks.length` and not `total > 1`: the Chinese fixture is
		// three chunks, so one timing each already clears a bare `> 1`.
		check(
			`NRL-47 P3 timings land on matching source text ${JSON.stringify(src)}`,
			bad === 0 && total > chunks.length,
			`${bad} bad of ${total} over ${chunks.length} chunks`,
		);

		// Monotonic and non-overlapping still, now that there are many of them.
		for (const chunk of chunks) {
			const t = allocateWordTimings(chunk, 3000, 1);
			check(
				`NRL-47 P3 timings stay ordered ${JSON.stringify(chunk.text)}`,
				t.every((w, i) => i === 0 || w.offsetMs >= t[i - 1]!.offsetMs + t[i - 1]!.durationMs - 0.001),
			);
		}
	}

	/*
	 * P5. Identity sweep. A regex span holding no Han, Kana or Hangul code
	 * point is pushed through subdivision untouched, and `weightOf`'s new CJK
	 * term is zero for these scripts, so both the spans and their weights are
	 * unchanged by construction. The durations below were captured by running
	 * the pre-NRL-47 code, so this is evidence rather than restatement.
	 */
	const SNAPSHOT: Array<[string, string, number, number[]]> = [
		["latin", "The quick brown fox jumps over a lazy dog.", 9, [279, 300, 300, 279, 300, 461, 259, 461, 279]],
		["cyrillic", "Съешь ещё этих мягких французских булок.", 6, [476, 443, 459, 492, 574, 476]],
		["greek", "Ο γρήγορος καφέ αλεπού πηδάει.", 5, [504, 644, 564, 604, 604]],
		["arabic", "نص حكيم له سر قاطع وذو شأن.", 7, [404, 435, 404, 404, 435, 419, 419]],
	];
	for (const [name, src, count, durations] of SNAPSHOT) {
		const chunk = extractChunks(src, OPTS, undefined, `Notes/${name}.md`)[0]!;
		const t = allocateWordTimings(chunk, 3000, 1);
		check(`NRL-47 P5 ${name} span count unchanged`, t.length === count, `got ${t.length}`);
		check(
			`NRL-47 P5 ${name} durations unchanged`,
			t.length === durations.length && t.every((w, i) => Math.round(w.durationMs) === durations[i]),
			JSON.stringify(t.map((w) => Math.round(w.durationMs))),
		);
	}
}

console.log("");
if (skipped > 0) console.log(`${skipped} SKIPPED (NRL_SKIP_REAL_SPEECHD=1)`);
if (failures > 0) {
	console.log(`${failures} FAILURE(S)`);
	process.exit(1);
}
// The bare line must never print when anything was skipped: a reader grepping
// for it would otherwise take a partial run for a full one.
console.log(skipped > 0 ? `all engine tests passed (${skipped} skipped)` : "all engine tests passed");
