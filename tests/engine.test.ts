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
function check(name: string, cond: boolean, detail = ""): void {
	if (cond) console.log(`  ok   ${name}`);
	else {
		failures += 1;
		console.log(`  FAIL ${name} ${detail}`);
	}
}

console.log("speech-dispatcher is usable here");
const runner = getProcessRunner();
const spd = new SpeechDispatcherEngine(runner);
check("spd-say on PATH", (await runner.which("spd-say")) !== null);
check("reports available", (await spd.isAvailable()).available);

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
			if (args[0] === "-L") return { code: 0, stderr: "", stdout: Buffer.from(SPD_LIST) };
			// NRL-55's module-attribution probe. Answering -O with a failure is
			// what keeps this default fake producing all-"unknown" voices, which
			// is the behaviour the assertions below were written against. The
			// -o …-L arm exists only so a probe that ignored the failed -O would
			// not land in `calls` and corrupt every calls.at(-1) assertion.
			if (args[0] === "-O") return { code: 1, stderr: "", stdout: Buffer.from("") };
			if (args[0] === "-o" && args.includes("-L")) {
				return { code: 0, stderr: "", stdout: Buffer.from(SPD_LIST) };
			}
			calls.push({ args, stdin });
			return {
				code: reply.code ?? 0,
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
 * "unknown" rather than on a guessed `true`, because srs.md:663 forbids
 * claiming a voice is offline when the backend cannot determine it.
 */
interface AttributionScript {
	/** `-O` reply. A name array is wrapped in the real "OUTPUT MODULES" header. */
	modules?: string[] | { code: number; stdout: string };
	/**
	 * `-o <module> -L` replies, per module. "throw" makes run() reject, and
	 * `delayMs` holds the reply back so the probe's own deadline can expire
	 * first (case H).
	 */
	lists?: Record<string, string | { code: number; stdout?: string; delayMs?: number } | "throw">;
	/** Bare `-L` reply, i.e. what listVoices() itself enumerates. */
	bare: string;
}
function attributionRunner(script: AttributionScript) {
	const scopedCalls: string[] = [];
	const runner: ProcessRunner = {
		async run(_cmd, args): Promise<RunResult> {
			if (args[0] === "-O") {
				const spec = script.modules ?? [];
				if (Array.isArray(spec)) {
					return {
						code: 0,
						stderr: "",
						stdout: Buffer.from(["OUTPUT MODULES", ...spec, ""].join("\n")),
					};
				}
				return { code: spec.code, stderr: "", stdout: Buffer.from(spec.stdout) };
			}
			if (args[0] === "-o" && args[2] === "-L") {
				const module = args[1]!;
				scopedCalls.push(module);
				const reply = script.lists?.[module];
				if (reply === "throw") throw new Error("spd-say could not be spawned");
				if (typeof reply === "string") return { code: 0, stderr: "", stdout: Buffer.from(reply) };
				if (reply) {
					if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
					return { code: reply.code, stderr: "", stdout: Buffer.from(reply.stdout ?? "") };
				}
				throw new Error(`unscripted module: ${module}`);
			}
			if (args[0] === "-L") return { code: 0, stderr: "", stdout: Buffer.from(script.bare) };
			throw new Error(`unexpected call: ${args.join(" ")}`);
		},
		async spawn() {
			throw new Error("not used");
		},
		async which() {
			return "/usr/bin/spd-say";
		},
	};
	return { runner, scopedCalls };
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
	const { runner } = attributionRunner({
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
}
{
	// B. A module that is not on the allowlist. Its voices stay unknown even
	// though the differential proved scoping works.
	const { runner } = attributionRunner({
		modules: ["espeak-ng", "festival"],
		lists: { "espeak-ng": ESPEAK_LIST, festival: FESTIVAL_LIST },
		bare: spdList([...ESPEAK_ROWS, ["Festival Voice", "en-US", "none"]]),
	});
	const voices = await new SpeechDispatcherEngine(runner).listVoices();
	check("B: allowlisted module's voice is local", localOf(voices, "Afrikaans") === true, `${localOf(voices, "Afrikaans")}`);
	check("B: non-allowlisted module's voice stays unknown", localOf(voices, "Festival Voice") === "unknown", `${localOf(voices, "Festival Voice")}`);
	check("B: and its requiresNetwork stays unknown", networkOf(voices, "Festival Voice") === "unknown", `${networkOf(voices, "Festival Voice")}`);
	check("B: nothing reports local false", neverFalse(voices));
}
{
	// C. The measured hazard, and the reason for the whole differential gate.
	// On this machine `spd-say -o no-such-module -L` exits 0 and returns the
	// full 13363-line default list, so a build that ignores -o hands every
	// module the same listing. A naive allowlist would then call 13,362
	// espeak-ng voices local on a build where -o means nothing.
	const { runner } = attributionRunner({
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
}
{
	// D. A scoped listing that fails. Not a partial attribution: the module we
	// could not read might be exactly the one that made a name ambiguous.
	const { runner } = attributionRunner({
		modules: ["espeak-ng", "openjtalk"],
		lists: { "espeak-ng": ESPEAK_LIST, openjtalk: { code: 1 } },
		bare: ESPEAK_LIST,
	});
	const voices = await new SpeechDispatcherEngine(runner).listVoices();
	check("D: a non-zero -o listing leaves everything unknown", voices.length === 3 && voices.every((v) => v.local === "unknown"), JSON.stringify(voices.map((v) => v.local)));
}
{
	// D2. Same, but run() rejects rather than exiting non-zero.
	const { runner } = attributionRunner({
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
}
{
	// D3. An unparseable scoped listing. Zero rows must not be treated as a
	// module that "differs" from the others: that would falsely prove scoping.
	const { runner } = attributionRunner({
		modules: ["espeak-ng", "openjtalk"],
		lists: { "espeak-ng": ESPEAK_LIST, openjtalk: "some unrelated output\n" },
		bare: ESPEAK_LIST,
	});
	const voices = await new SpeechDispatcherEngine(runner).listVoices();
	check("D3: an unparseable -o listing leaves everything unknown", voices.length === 3 && voices.every((v) => v.local === "unknown"), JSON.stringify(voices.map((v) => v.local)));
}
{
	// E. One module only: nothing to compare, so no differential is possible.
	const { runner, scopedCalls } = attributionRunner({
		modules: ["espeak-ng"],
		lists: { "espeak-ng": ESPEAK_LIST },
		bare: ESPEAK_LIST,
	});
	const voices = await new SpeechDispatcherEngine(runner).listVoices();
	check("E: a single output module leaves everything unknown", voices.length === 3 && voices.every((v) => v.local === "unknown"), JSON.stringify(voices.map((v) => v.local)));
	check("E: and no scoped listing is even attempted", scopedCalls.length === 0, JSON.stringify(scopedCalls));
}
{
	// E2. -O itself fails, and -O without its header.
	const failing = attributionRunner({ modules: { code: 1, stdout: "" }, bare: ESPEAK_LIST });
	const v1 = await new SpeechDispatcherEngine(failing.runner).listVoices();
	check("E2: a failed -O leaves everything unknown", v1.length === 3 && v1.every((v) => v.local === "unknown"), JSON.stringify(v1.map((v) => v.local)));
	const headerless = attributionRunner({ modules: { code: 0, stdout: "espeak-ng\nopenjtalk\n" }, bare: ESPEAK_LIST });
	const v2 = await new SpeechDispatcherEngine(headerless.runner).listVoices();
	check("E2: -O with no OUTPUT MODULES header leaves everything unknown", v2.every((v) => v.local === "unknown"), JSON.stringify(v2.map((v) => v.local)));
}
{
	// F. Ambiguity. A NAME served by both an allowlisted and a non-allowlisted
	// module cannot be called local: we do not know which one would speak it.
	const { runner } = attributionRunner({
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
}
{
	// G. The probe costs a full listing per module (0.387s for espeak-ng on
	// this machine), and listVoices() runs on every settings-tab render, so it
	// must be paid once per engine instance.
	const { runner, scopedCalls } = attributionRunner({
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
	// srs.md:661 forbids. The same truncation makes two otherwise identical
	// listings differ, so it can also carry the differential gate on a build
	// that ignores `-o` altogether.
	const { runner } = attributionRunner({
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
}
{
	// In -e mode spd-say runs any line starting "!-!" as a raw SSIP command
	// instead of speaking it: the sentence vanishes with exit 0, and note
	// text gets to drive the daemon. A leading space defuses it.
	const bang = "!-!Third one\n!-!SET SELF RATE -100";
	const calls: { stdin?: string }[] = [];
	const runner: ProcessRunner = {
		async run(_cmd, args, stdin) {
			if (args[0] === "-L") return { code: 0, stderr: "", stdout: Buffer.from(SPD_LIST) };
			calls.push({ stdin });
			// spd-say -e echoes what it read, byte for byte.
			return { code: 0, stderr: "", stdout: Buffer.from(stdin ?? "") };
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
			if (args[0] === "-L") return { code: 0, stderr: "", stdout: Buffer.from(SPD_LIST) };
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
			return { code: 0, stderr: "", stdout: Buffer.from("") };
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
			if (args[0] === "-O") return { code: 0, stderr: "", stdout: Buffer.from("OUTPUT MODULES\n") };
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
				return { code: 0, stderr: "", stdout: Buffer.from("OUTPUT MODULES\nespeak-ng\nopenjtalk\n") };
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
			if (args[0] === "-O") return { code: 1, stderr: "", stdout: Buffer.from("") };
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
{
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
if (failures > 0) {
	console.log(`${failures} FAILURE(S)`);
	process.exit(1);
}
console.log("all engine tests passed");
