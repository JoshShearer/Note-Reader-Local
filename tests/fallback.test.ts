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

	const winner = await playWithFallback(player, candidates, numbered(3), 1, {
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

	const resultPromise = playWithFallback(player, candidates, numbered(3), 1, {
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

	const winner = await playWithFallback(player, candidates, numbered(2), 1, {
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

	const resultPromise = playWithFallback(player, candidates, numbered(2), 1, {
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

	const winner = await playWithFallback(player, candidates, numbered(2), 1, {
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

console.log("");
if (failures > 0) {
	console.log(`${failures} FAILURE(S)`);
	process.exit(1);
}
console.log("all fallback tests passed");
