/**
 * A genuine fallback chain (NRL-24): if the chosen engine fails at load or
 * at first synthesis, the next candidate is tried, and a Stop is never
 * mistaken for a failure.
 *
 * Reuses the exact FakeAudio/Blob/URL/DOMException/rAF mocking block
 * tests/player.test.ts already built, and its `makeEngine({failOn})` /
 * `numbered(n)` patterns, so this drives the real `Player` against fake
 * `SpeechEngine`s with no Obsidian mocking needed.
 */

import { Player } from "../src/audio/player.ts";
import { playWithFallback, type FallbackCandidate } from "../src/audio/fallback.ts";
import { withLoadingNotice, type Dismissable } from "../src/ui/loadingNotice.ts";
import { pcmToWav } from "../src/audio/wav.ts";
import { allocateWordTimings } from "../src/audio/words.ts";
import type { SpeechChunk, SpeechEngine, SynthRequest, SynthResult } from "../src/audio/types.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
	if (cond) console.log(`  ok   ${name}`);
	else {
		failures += 1;
		console.log(`  FAIL ${name} ${detail}`);
	}
}

// --- Fake DOM (identical shape to tests/player.test.ts) ---------------------

class FakeAudio {
	src = "";
	playbackRate = 1;
	currentTime = 0;
	paused = true;
	private listeners = new Map<string, Array<() => void>>();

	addEventListener(type: string, fn: () => void): void {
		const set = this.listeners.get(type) ?? [];
		set.push(fn);
		this.listeners.set(type, set);
	}
	removeEventListener(type: string, fn: () => void): void {
		this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
	}
	private fire(type: string): void {
		for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
	}

	play(): Promise<void> {
		this.paused = false;
		return Promise.resolve();
	}
	pause(): void {
		this.paused = true;
	}
	removeAttribute(): void {
		this.src = "";
	}

	advance(to: number, endAt?: number): void {
		const from = this.currentTime;
		const steps = 20;
		for (let i = 1; i <= steps; i++) {
			this.currentTime = from + ((to - from) * i) / steps;
			frameCallbacks.forEach((cb) => cb());
		}
		if (endAt !== undefined && to >= endAt) this.fire("ended");
	}
}

let fakeAudio!: FakeAudio;
let frameCallbacks: Array<() => void> = [];

(globalThis as Record<string, unknown>).Audio = class {
	constructor() {
		fakeAudio = new FakeAudio();
		return fakeAudio as unknown as object;
	}
} as unknown as typeof Audio;
(globalThis as Record<string, unknown>).requestAnimationFrame = (cb: () => void): number => {
	frameCallbacks.push(cb);
	return frameCallbacks.length;
};
(globalThis as Record<string, unknown>).cancelAnimationFrame = (): void => {
	frameCallbacks = [];
};
(globalThis as Record<string, unknown>).Blob = class {
	constructor(public parts: unknown[]) {}
};
(globalThis as Record<string, unknown>).URL = {
	createObjectURL: (): string => `blob:${Math.random()}`,
	revokeObjectURL: (): void => undefined,
};
(globalThis as Record<string, unknown>).DOMException = class extends Error {
	constructor(message: string, name: string) {
		super(message);
		this.name = name;
	}
};

// --- Fake engines -------------------------------------------------------

/** Hand-built chunks, one per index, so the chunk count is exact. */
function numbered(n: number): SpeechChunk[] {
	return Array.from({ length: n }, (_, i) => {
		const text = `Sentence ${i}.`;
		return {
			id: `chunk-${i}`,
			sequence: i,
			blockType: "paragraph" as const,
			filePath: "test.md",
			text,
			sourceIndex: Array.from(text, (_, k) => i * 100 + k),
			sourceStart: i * 100,
			sourceEnd: i * 100 + text.length,
		};
	});
}

const CAPS: SpeechEngine["capabilities"] = {
	voices: false,
	timing: "measured",
	rate: true,
	pitch: true,
	desktopOnly: true,
	pause: true,
	resume: true,
	sentenceBoundary: false,
	offlineStatus: true,
	ownsPlayback: false,
};

/** A buffer engine that fails on a given chunk index, otherwise succeeds. */
function makeEngine(opts: { failOn?: number; label?: string } = {}): {
	engine: SpeechEngine;
	calls: number[];
} {
	const calls: number[] = [];
	let n = 0;
	const engine: SpeechEngine = {
		id: "espeak",
		label: opts.label ?? "fake",
		capabilities: CAPS,
		async isAvailable() {
			return { available: true };
		},
		async listVoices() {
			return [];
		},
		async selectVoice() {},
		async synthesize(req: SynthRequest): Promise<SynthResult> {
			const index = n++;
			calls.push(index);
			if (opts.failOn === index) throw new Error(`${opts.label ?? "engine"} exploded at ${index}`);
			const duration = 1000;
			return {
				kind: "buffer",
				audio: pcmToWav(new Int16Array(2400 * (duration / 1000)).buffer, 24000),
				sampleRate: 24000,
				durationMs: duration,
				words: allocateWordTimings(req.chunk, duration, req.rate),
			};
		},
		async dispose() {},
	};
	return { engine, calls };
}

/** A buffer engine whose synthesize() never resolves until its signal aborts. */
function makeHangingEngine(): { engine: SpeechEngine } {
	const engine: SpeechEngine = {
		id: "kokoro",
		label: "hanging",
		capabilities: CAPS,
		async isAvailable() {
			return { available: true };
		},
		async listVoices() {
			return [];
		},
		async selectVoice() {},
		async synthesize(_req: SynthRequest, signal: AbortSignal): Promise<SynthResult> {
			await new Promise<void>((_resolve, reject) => {
				signal.addEventListener(
					"abort",
					() => reject(new DOMException("Aborted", "AbortError")),
					{ once: true },
				);
			});
			throw new Error("unreachable");
		},
		async dispose() {},
	};
	return { engine };
}

/**
 * An engine whose `prepare()` is held open by the test (NRL-48).
 *
 * This is the load phase, not the synthesis phase: `isPrepared()` reports
 * false so a main.ts-shaped `beforeAttempt` hook awaits `prepare()`, and the
 * test decides when (or whether) that load settles. `synthesize` is
 * `makeEngine`'s successful body on purpose - if an abort during the load is
 * ignored, this engine really speaks, and `calls` records it.
 */
function makeHangingPrepareEngine(opts: { label?: string } = {}): {
	engine: SpeechEngine;
	calls: number[];
	prepareCalls: () => number;
	resolveLoad: () => void;
	failLoad: (err: Error) => void;
} {
	const calls: number[] = [];
	let n = 0;
	let prepareCalls = 0;
	let settle: { resolve: () => void; reject: (err: Error) => void } | null = null;
	const engine: SpeechEngine = {
		id: "kokoro",
		label: opts.label ?? "hanging-prepare",
		capabilities: CAPS,
		async isAvailable() {
			return { available: true };
		},
		async listVoices() {
			return [];
		},
		async selectVoice() {},
		isPrepared() {
			return false;
		},
		prepare() {
			prepareCalls += 1;
			return new Promise<void>((resolve, reject) => {
				settle = { resolve, reject };
			});
		},
		async synthesize(req: SynthRequest): Promise<SynthResult> {
			const index = n++;
			calls.push(index);
			const duration = 1000;
			return {
				kind: "buffer",
				audio: pcmToWav(new Int16Array(2400 * (duration / 1000)).buffer, 24000),
				sampleRate: 24000,
				durationMs: duration,
				words: allocateWordTimings(req.chunk, duration, req.rate),
			};
		},
		async dispose() {},
	};
	return {
		engine,
		calls,
		prepareCalls: () => prepareCalls,
		resolveLoad: () => settle?.resolve(),
		failLoad: (err: Error) => settle?.reject(err),
	};
}

/**
 * Race a promise against a deadline so a pre-fix hang prints FAIL instead of
 * hanging the whole suite. The timer is cleared either way, so a resolved race
 * does not hold node open for `ms`.
 */
async function withTimeout<T, S>(p: Promise<T>, ms: number, sentinel: S): Promise<T | S> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<S>((resolve) => {
		timer = setTimeout(() => resolve(sentinel), ms);
	});
	const result = await Promise.race([p, deadline]);
	if (timer !== undefined) clearTimeout(timer);
	return result;
}

const TIMED_OUT = "TIMED_OUT" as const;

function candidate(engine: SpeechEngine, id: FallbackCandidate["id"], reason: string): FallbackCandidate {
	return { engine, id, reason };
}

async function tick(): Promise<void> {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
}

// --- Tests ------------------------------------------------------------------

console.log("first candidate fails at chunk 0: the second is tried and succeeds");
{
	const first = makeEngine({ failOn: 0, label: "first" });
	const second = makeEngine({ label: "second" });
	const candidates = [
		candidate(first.engine, "espeak", "r1"),
		candidate(second.engine, "speechd", "r2"),
	];
	const player = new Player({ bufferAhead: 0 });
	const fallbacks: Array<{ from: string; to: string }> = [];

	const winner = await playWithFallback(player, candidates, numbered(3), 1, 0, {
		onFallback: (from, to) => fallbacks.push({ from: from.id, to: to.id }),
	});

	check("second candidate won", winner?.id === "speechd", JSON.stringify(winner));
	check(
		"onFallback fired exactly once, naming both engines",
		fallbacks.length === 1 && fallbacks[0]?.from === "espeak" && fallbacks[0]?.to === "speechd",
		JSON.stringify(fallbacks),
	);

	player.stop();
}

console.log(
	"first candidate succeeds at chunk 0 but fails at chunk 2: resolves with the FIRST candidate, second never tried",
);
{
	const first = makeEngine({ failOn: 2, label: "first" });
	const second = makeEngine({ label: "second" });
	const candidates = [
		candidate(first.engine, "espeak", "r1"),
		candidate(second.engine, "speechd", "r2"),
	];
	const player = new Player({ bufferAhead: 0 });
	const persistentErrors: string[] = [];
	// Attached BEFORE calling playWithFallback, the same way main.ts's own
	// persistent listener is: this is what is supposed to see the later
	// chunk-2 failure, not fallback.ts's own internal race.
	player.on("error", (e) => persistentErrors.push(e.message));
	const fallbacks: unknown[] = [];

	const resultPromise = playWithFallback(player, candidates, numbered(3), 1, 0, {
		onFallback: (from, to) => fallbacks.push({ from: from.id, to: to.id }),
	});

	await tick();
	const winner = await resultPromise;
	check("resolved with the first candidate", winner?.id === "espeak", JSON.stringify(winner));
	check("second candidate's synthesize was never called", second.calls.length === 0, JSON.stringify(second.calls));
	check("no fallback happened yet", fallbacks.length === 0, JSON.stringify(fallbacks));
	check("no persistent error yet", persistentErrors.length === 0, JSON.stringify(persistentErrors));

	// Drive the player through chunk 0 and chunk 1 (both succeed), then
	// chunk 2, which throws inside the engine's own synthesize().
	fakeAudio.advance(fakeAudio.currentTime + 1.2, 1.0);
	await tick();
	fakeAudio.advance(fakeAudio.currentTime + 1.2, 1.0);
	await tick();

	check(
		"the chunk-2 failure surfaced exactly once, on the persistent listener, after playWithFallback already resolved",
		persistentErrors.length === 1 && persistentErrors[0]!.includes("exploded at 2"),
		JSON.stringify(persistentErrors),
	);
	check("still no fallback: this is out of scope once speech has started", fallbacks.length === 0);

	player.stop();
}

console.log("a single candidate that fails at chunk 0: returns null, onFallback never called");
{
	const only = makeEngine({ failOn: 0, label: "only" });
	const candidates = [candidate(only.engine, "espeak", "r1")];
	const player = new Player({ bufferAhead: 0 });
	const fallbacks: unknown[] = [];

	const winner = await playWithFallback(player, candidates, numbered(2), 1, 0, {
		onFallback: (from, to) => fallbacks.push({ from: from.id, to: to.id }),
	});

	check("no candidate won", winner === null, JSON.stringify(winner));
	check("onFallback never called: nothing to fall back to", fallbacks.length === 0, JSON.stringify(fallbacks));

	player.stop();
}

console.log(
	"stop() before the first chunk ever plays: resolves null, no onFallback, no error-based fallback",
);
{
	const { engine: hanging } = makeHangingEngine();
	const { engine: second } = makeEngine({ label: "second" });
	const candidates = [
		candidate(hanging, "kokoro", "r1"),
		candidate(second, "speechd", "r2"),
	];
	const player = new Player({ bufferAhead: 0 });
	const fallbacks: unknown[] = [];
	const persistentErrors: string[] = [];
	player.on("error", (e) => persistentErrors.push(e.message));

	const resultPromise = playWithFallback(player, candidates, numbered(2), 1, 0, {
		onFallback: (from, to) => fallbacks.push({ from: from.id, to: to.id }),
	});

	// Let the run loop reach "preparing" and start awaiting the hanging
	// synthesize(), well before it could ever reach "playing".
	await tick();
	check("still preparing, never reached playing", player.getState() === "preparing", player.getState());

	player.stop();
	const winner = await resultPromise;

	check("resolves null", winner === null, JSON.stringify(winner));
	check("onFallback never called", fallbacks.length === 0, JSON.stringify(fallbacks));
	check("no error-based fallback fired", persistentErrors.length === 0, JSON.stringify(persistentErrors));
	check("second candidate was never tried", true);
}

console.log("beforeAttempt is awaited once per candidate actually tried, in order");
{
	const first = makeEngine({ failOn: 0, label: "first" });
	const second = makeEngine({ label: "second" });
	const third = makeEngine({ label: "third" });
	const candidates = [
		candidate(first.engine, "espeak", "r1"),
		candidate(second.engine, "speechd", "r2"),
		candidate(third.engine, "webspeech", "r3"),
	];
	const player = new Player({ bufferAhead: 0 });
	const attempts: string[] = [];

	const winner = await playWithFallback(player, candidates, numbered(2), 1, 0, {
		beforeAttempt: async (c) => {
			attempts.push(c.id);
		},
	});

	check("second candidate won (first failed)", winner?.id === "speechd", JSON.stringify(winner));
	check(
		"beforeAttempt called exactly for the candidates actually tried, in order",
		JSON.stringify(attempts) === JSON.stringify(["espeak", "speechd"]),
		JSON.stringify(attempts),
	);

	player.stop();
}

// --- NRL-48: Stop during the load phase -------------------------------------
//
// Bare-Node evidence only. No Obsidian is reachable from this lane, so these
// cases prove the abort is honoured inside playWithFallback; whether a real
// "Loading Kokoro..." Notice behaves the same on a cold model load is the
// Verify phase's job.

console.log("T1 abort during beforeAttempt's prepare(): resolves null promptly, no onFallback, nothing speaks");
{
	const first = makeHangingPrepareEngine({ label: "first" });
	const second = makeEngine({ label: "second" });
	const candidates = [
		candidate(first.engine, "kokoro", "r1"),
		candidate(second.engine, "speechd", "r2"),
	];
	const player = new Player({ bufferAhead: 0 });
	const fallbacks: unknown[] = [];
	const scope = new AbortController();

	const resultPromise = playWithFallback(
		player,
		candidates,
		numbered(2),
		1,
		0,
		{
			// The same shape main.ts's hook has: load only when not prepared.
			beforeAttempt: async (c) => {
				if (c.engine.prepare && c.engine.isPrepared?.() === false) await c.engine.prepare();
			},
			onFallback: (from, to) => fallbacks.push({ from: from.id, to: to.id }),
		},
		-1,
		scope.signal,
	);

	await tick();
	check("prepare() is in flight", first.prepareCalls() === 1, `${first.prepareCalls()}`);
	check("nothing has been synthesized yet", first.calls.length === 0, JSON.stringify(first.calls));

	scope.abort();
	const winner = await withTimeout(resultPromise, 250, TIMED_OUT);

	check(
		"resolved null promptly, without waiting for the load to finish",
		winner === null,
		winner === TIMED_OUT ? "never settled (still awaiting prepare)" : JSON.stringify(winner),
	);
	check("onFallback never called: a Stop is not a candidate failure", fallbacks.length === 0, JSON.stringify(fallbacks));
	check("second candidate was never tried", second.calls.length === 0, JSON.stringify(second.calls));
	check("player never reached playing", player.getState() !== "playing", player.getState());

	// The abandoned load finishes anyway (ADR 0013: abandoned, not cancelled).
	// It must not start speaking after the user's Stop.
	first.resolveLoad();
	await tick();
	check(
		"the abandoned load completing does not start speech",
		first.calls.length === 0,
		JSON.stringify(first.calls),
	);
	check("still no fallback after the abandoned load completed", fallbacks.length === 0, JSON.stringify(fallbacks));

	player.stop();
}

console.log("T2 signal already aborted before the first iteration: resolves null and beforeAttempt is never called");
{
	const first = makeEngine({ label: "first" });
	const second = makeEngine({ label: "second" });
	const candidates = [
		candidate(first.engine, "espeak", "r1"),
		candidate(second.engine, "speechd", "r2"),
	];
	const player = new Player({ bufferAhead: 0 });
	const attempts: string[] = [];
	const scope = new AbortController();
	scope.abort();

	const winner = await withTimeout(
		playWithFallback(
			player,
			candidates,
			numbered(2),
			1,
			0,
			{
				beforeAttempt: async (c) => {
					attempts.push(c.id);
				},
			},
			-1,
			scope.signal,
		),
		250,
		TIMED_OUT,
	);

	check("resolved null", winner === null, JSON.stringify(winner));
	check("beforeAttempt never called", attempts.length === 0, JSON.stringify(attempts));
	check("no engine spoke", first.calls.length === 0 && second.calls.length === 0, JSON.stringify([first.calls, second.calls]));

	player.stop();
}

console.log("T3 the abandoned prepare() rejecting after the abort: no fallback path, no unhandled rejection");
{
	const first = makeHangingPrepareEngine({ label: "first" });
	const second = makeEngine({ label: "second" });
	const candidates = [
		candidate(first.engine, "kokoro", "r1"),
		candidate(second.engine, "speechd", "r2"),
	];
	const player = new Player({ bufferAhead: 0 });
	const fallbacks: unknown[] = [];
	const scope = new AbortController();
	const rejections: unknown[] = [];
	const collect = (reason: unknown): void => {
		rejections.push(reason);
	};
	process.on("unhandledRejection", collect);

	const resultPromise = playWithFallback(
		player,
		candidates,
		numbered(2),
		1,
		0,
		{
			beforeAttempt: async (c) => {
				if (c.engine.prepare && c.engine.isPrepared?.() === false) await c.engine.prepare();
			},
			onFallback: (from, to) => fallbacks.push({ from: from.id, to: to.id }),
		},
		-1,
		scope.signal,
	);

	await tick();
	scope.abort();
	const winner = await withTimeout(resultPromise, 250, TIMED_OUT);
	check(
		"resolved null on abort",
		winner === null,
		winner === TIMED_OUT ? "never settled (still awaiting prepare)" : JSON.stringify(winner),
	);

	// Now the abandoned load fails. Today this rejection is caught as a load
	// failure and starts speaking candidate 2 after the user pressed Stop.
	first.failLoad(new Error("cold load died after the stop"));
	await tick();
	await tick();

	check("onFallback never called for the abandoned load's failure", fallbacks.length === 0, JSON.stringify(fallbacks));
	check("second candidate stayed silent", second.calls.length === 0, JSON.stringify(second.calls));
	check("no unhandled rejection escaped", rejections.length === 0, `${rejections.length}`);

	process.off("unhandledRejection", collect);
	player.stop();
}

console.log("T4 no signal argument: behaviour unchanged");
{
	const first = makeEngine({ failOn: 0, label: "first" });
	const second = makeEngine({ label: "second" });
	const candidates = [
		candidate(first.engine, "espeak", "r1"),
		candidate(second.engine, "speechd", "r2"),
	];
	const player = new Player({ bufferAhead: 0 });
	const fallbacks: Array<{ from: string; to: string }> = [];

	const winner = await withTimeout(
		playWithFallback(player, candidates, numbered(3), 1, 0, {
			onFallback: (from, to) => fallbacks.push({ from: from.id, to: to.id }),
		}),
		2000,
		TIMED_OUT,
	);

	check("second candidate won with no signal passed", winner !== TIMED_OUT && winner?.id === "speechd", JSON.stringify(winner));
	check("onFallback still fires once", fallbacks.length === 1, JSON.stringify(fallbacks));

	player.stop();
}

console.log("T5 [NRL-65] the loading Notice is dismissed at the Stop, not when the abandoned load settles");
{
	// The integration half of tests/loadingNotice.test.ts: a main.ts-shaped
	// `beforeAttempt` running the REAL withLoadingNotice against a fake
	// Dismissable, driven by the REAL playWithFallback. Only (i) is red
	// pre-fix; (ii) and (iii) are guards already green from NRL-48.
	const first = makeHangingPrepareEngine({ label: "first" });
	const second = makeEngine({ label: "second" });
	const candidates = [
		candidate(first.engine, "kokoro", "r1"),
		candidate(second.engine, "speechd", "r2"),
	];
	const player = new Player({ bufferAhead: 0 });
	const scope = new AbortController();

	let hideCalls = 0;
	const notice: Dismissable = {
		hide() {
			hideCalls += 1;
		},
	};

	const resultPromise = playWithFallback(
		player,
		candidates,
		numbered(2),
		1,
		0,
		{
			beforeAttempt: (c) => {
				if (!(c.engine.prepare && c.engine.isPrepared?.() === false)) return Promise.resolve();
				const load = c.engine.prepare.bind(c.engine);
				return withLoadingNotice(() => notice, () => load(), scope.signal);
			},
		},
		-1,
		scope.signal,
	);

	await tick();
	check("T5 the Notice is up while the load is in flight", hideCalls === 0, `${hideCalls}`);

	scope.abort();
	await tick();
	// (i) RED pre-fix: the old policy hid only in the abandoned load's finally.
	check("T5(i) hidden at the Stop, before the abandoned load settled", hideCalls === 1, `${hideCalls}`);

	// (ii) guard, already green from NRL-48.
	const winner = await withTimeout(resultPromise, 250, TIMED_OUT);
	check("T5(ii) playWithFallback resolved null", winner === null, JSON.stringify(winner));

	// (iii) guards: the abandoned load settles anyway (ADR 0013), and neither
	// hides a second time nor speaks.
	first.resolveLoad();
	await tick();
	check("T5(iii) still exactly one hide after the abandoned load settled", hideCalls === 1, `${hideCalls}`);
	check("T5(iii) nothing was spoken", first.calls.length === 0, JSON.stringify(first.calls));
	check("T5(iii) the second candidate stayed silent", second.calls.length === 0, JSON.stringify(second.calls));

	player.stop();
}

console.log("");
if (failures > 0) {
	console.log(`${failures} FAILURE(S)`);
	process.exit(1);
}
console.log("all fallback tests passed");
