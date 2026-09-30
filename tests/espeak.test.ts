/**
 * espeak.ts has no coverage before this ticket - confirmed by `ls tests/*.test.ts`
 * before this file existed. AGENTS.md records espeak-ng as NOT installed on
 * this machine, so every case here uses a fake ProcessRunner rather than the
 * real binary (mirroring tests/engine.test.ts's own fake-runner pattern).
 *
 * Also locks in NRL-25's fix to the one raw-stderr-dump call site this ticket
 * found: a synthesis failure must never surface the subprocess's stderr text
 * verbatim (AGENTS.md non-negotiable 1's spirit - not note text here, but the
 * same "no unaudited process output reaches the user" discipline speechd.ts
 * already follows).
 */

import { EspeakEngine } from "../src/engines/system/espeak.ts";
import type { ProcessRunner, RunResult } from "../src/engines/system/spawn.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
	if (cond) console.log(`  ok   ${name}`);
	else {
		failures += 1;
		console.log(`  FAIL ${name} ${detail}`);
	}
}

function runner(overrides: Partial<ProcessRunner>): ProcessRunner {
	return {
		async run(): Promise<RunResult> {
			throw new Error("run() not stubbed for this case");
		},
		async spawn() {
			throw new Error("not used");
		},
		async which() {
			return null;
		},
		...overrides,
	};
}

const TEXT = "Testing one two three.";
const CHUNK = {
	id: "espeak-test-chunk",
	sequence: 0,
	blockType: "paragraph" as const,
	filePath: "test.md",
	text: TEXT,
	sourceIndex: [],
	sourceStart: 0,
	sourceEnd: TEXT.length,
};

console.log("espeak: isAvailable() distinguishes its failure modes (NRL-25)");
{
	// which() finds nothing: the binary is not installed.
	const r = runner({ async which() { return null; } });
	const engine = new EspeakEngine(r);
	const result = await engine.isAvailable();
	check("binary missing: not available", result.available === false);
	check(
		"binary missing: reason names espeak-ng and install",
		!result.available &&
			result.reason.toLowerCase().includes("espeak-ng") &&
			result.reason.toLowerCase().includes("install"),
		!result.available ? result.reason : "available:true",
	);
}
{
	// which() finds a path, but the binary does not answer --version sanely.
	const r = runner({
		async which() {
			return "/usr/bin/espeak-ng";
		},
		async run(_cmd, args): Promise<RunResult> {
			if (args[0] === "--version") return { code: 1, signal: null, stderr: "", stdout: Buffer.from("") };
			throw new Error(`unexpected call: ${args.join(" ")}`);
		},
	});
	const engine = new EspeakEngine(r);
	const result = await engine.isAvailable();
	check("found but broken: not available", result.available === false);
	check(
		"found but broken: a DIFFERENT reason than binary-missing (does not say 'not installed')",
		!result.available &&
			!result.reason.toLowerCase().includes("not installed") &&
			result.reason.length > 0,
		!result.available ? result.reason : "available:true",
	);
}
{
	// which() finds it, --version answers cleanly: available.
	const r = runner({
		async which() {
			return "/usr/bin/espeak-ng";
		},
		async run(_cmd, args): Promise<RunResult> {
			if (args[0] === "--version") {
				return { code: 0, signal: null, stderr: "", stdout: Buffer.from("eSpeak NG text-to-speech: 1.51\n") };
			}
			throw new Error(`unexpected call: ${args.join(" ")}`);
		},
	});
	const engine = new EspeakEngine(r);
	const result = await engine.isAvailable();
	check("found and responding: available", result.available === true, JSON.stringify(result));
}
{
	// run() throws after which() succeeds: caught, not propagated.
	const r = runner({
		async which() {
			return "/usr/bin/espeak-ng";
		},
		async run() {
			throw new Error("EACCES spawning espeak-ng");
		},
	});
	const engine = new EspeakEngine(r);
	const result = await engine.isAvailable();
	check("probe throws: not available, does not propagate", result.available === false);
	check(
		"probe throws: reason carries the thrown message",
		!result.available && result.reason.includes("EACCES spawning espeak-ng"),
		!result.available ? result.reason : "available:true",
	);
}

console.log("espeak: a synthesis failure never dumps raw stderr (NRL-25 #6)");
{
	const diagnostic = "some diagnostic espeak-ng printed to stderr";
	const r = runner({
		async which() {
			return "/usr/bin/espeak-ng";
		},
		async run(): Promise<RunResult> {
			return { code: 1, signal: null, stderr: diagnostic, stdout: Buffer.from("") };
		},
	});
	const engine = new EspeakEngine(r);
	let err: Error | null = null;
	try {
		await engine.synthesize({ chunk: CHUNK, rate: 1, pitch: 0 }, new AbortController().signal);
	} catch (e) {
		err = e as Error;
	}
	check("non-zero exit throws", err !== null);
	check(
		"thrown message does not contain the raw stderr text",
		!!err && !err.message.includes(diagnostic),
		err?.message,
	);
}

console.log("NRL-26: every voice reports local: true, requiresNetwork: false");
{
	// Genuinely true for every voice: espeak.ts has no fetch/http/
	// XMLHttpRequest/axios/WebSocket call anywhere (grep-confirmed), it only
	// spawns the local espeak-ng binary via ProcessRunner.

	// Real --voices parse path (format per the comment in listVoices()).
	const listing = [
		"Pty Language Age/Gender VoiceName          File          Other Languages",
		"1  en          en-us  english (usa)",
		"5  en          en-gb  english (gb)",
	].join("\n");
	const r = runner({
		async which() {
			return "/usr/bin/espeak-ng";
		},
		async run(_cmd, args): Promise<RunResult> {
			if (args[0] === "--voices") return { code: 0, signal: null, stderr: "", stdout: Buffer.from(listing) };
			throw new Error(`unexpected call: ${args.join(" ")}`);
		},
	});
	const engine = new EspeakEngine(r);
	const voices = await engine.listVoices();
	check("real --voices parse: has voices", voices.length > 0, `got ${voices.length}`);
	check("real --voices parse: every voice local: true", voices.every((v) => v.local === true), JSON.stringify(voices.map((v) => v.local)));
	check("real --voices parse: every voice requiresNetwork: false", voices.every((v) => v.requiresNetwork === false), JSON.stringify(voices.map((v) => v.requiresNetwork)));

	// BUILTIN_LANGUAGES fallback path: --voices fails, falls through.
	const rFallback = runner({
		async which() {
			return "/usr/bin/espeak-ng";
		},
		async run(_cmd, args): Promise<RunResult> {
			if (args[0] === "--voices") return { code: 1, signal: null, stderr: "", stdout: Buffer.from("") };
			throw new Error(`unexpected call: ${args.join(" ")}`);
		},
	});
	const engineFallback = new EspeakEngine(rFallback);
	const fallbackVoices = await engineFallback.listVoices();
	check("builtin fallback: has voices", fallbackVoices.length > 0, `got ${fallbackVoices.length}`);
	check("builtin fallback: every voice local: true", fallbackVoices.every((v) => v.local === true), JSON.stringify(fallbackVoices.map((v) => v.local)));
	check("builtin fallback: every voice requiresNetwork: false", fallbackVoices.every((v) => v.requiresNetwork === false), JSON.stringify(fallbackVoices.map((v) => v.requiresNetwork)));
}

console.log("");
if (failures > 0) {
	console.log(`${failures} FAILURE(S)`);
	process.exit(1);
}
console.log("all espeak tests passed");
