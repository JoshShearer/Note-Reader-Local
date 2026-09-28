/**
 * Runs the real Player against a real engine, with a stubbed DOM.
 *
 * The player is where the three engine behaviours converge, so it is the part
 * most worth proving: audio is actually played, words are actually emitted in
 * order, and the timeline is honoured.
 *
 * A fake Audio element stands in for the browser. It cannot make sound, but it
 * can be stepped through time, which is exactly what the rAF loop reads.
 */

import { Player } from "../src/audio/player.ts";
import { extractChunks } from "../src/text/extract.ts";
import { allocateWordTimings } from "../src/audio/words.ts";
import { pcmToWav } from "../src/audio/wav.ts";
import type { SpeechChunk, SpeechEngine, SynthRequest, SynthResult } from "../src/audio/types.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
	if (cond) console.log(`  ok   ${name}`);
	else {
		failures += 1;
		console.log(`  FAIL ${name} ${detail}`);
	}
}

// --- Fake DOM ---------------------------------------------------------------

/** Stand-in for HTMLAudioElement that we can advance by hand. */
class FakeAudio {
	src = "";
	playbackRate = 1;
	currentTime = 0;
	paused = true;
	playCalls = 0;
	pauseCalls = 0;
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
		this.playCalls += 1;
		this.paused = false;
		return Promise.resolve();
	}
	pause(): void {
		this.pauseCalls += 1;
		this.paused = true;
	}
	removeAttribute(): void {
		this.src = "";
	}

	/** Test hook: run the clock forward and fire `ended` at the end. */
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
let objectUrls = 0;
let revokedUrls = 0;

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
	createObjectURL: (): string => `blob:${++objectUrls}`,
	revokeObjectURL: (): void => {
		revokedUrls += 1;
	},
};
(globalThis as Record<string, unknown>).DOMException = class extends Error {
	constructor(message: string, name: string) {
		super(message);
		this.name = name;
	}
};

// --- Fake engine ------------------------------------------------------------

/** Produces a real WAV and a real word timeline, sized per chunk. */
function makeEngine(opts: { durationPerChunk?: number; failOn?: number } = {}): {
	engine: SpeechEngine;
	calls: string[];
} {
	const calls: string[] = [];
	let n = 0;

	const engine: SpeechEngine = {
		id: "espeak",
		label: "fake",
		capabilities: {
			voices: false,
			timing: "measured",
			rate: true,
			pitch: true,
			desktopOnly: true,
			ownsPlayback: false,
		},
		async isAvailable() {
			return true;
		},
		async listVoices() {
			return [];
		},
		async selectVoice() {},
		async synthesize(req: SynthRequest): Promise<SynthResult> {
			const index = n++;
			calls.push(req.chunk.text);
			if (opts.failOn === index) throw new Error("engine exploded");
			const duration = opts.durationPerChunk ?? 1000;
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

/**
 * Long enough to actually split into several chunks. Three short sentences get
 * merged back into one chunk, which would make the queue tests vacuous.
 */
const SRC = Array.from(
	{ length: 5 },
	(_, i) => `This is sentence number ${i} and it goes on for a little while to be sure.`,
).join(" ");

function chunksOf(src: string): SpeechChunk[] {
	return extractChunks(src, {
		stripTags: true,
		skipUrls: true,
		skipCode: true,
		skipTables: true,
		skipHeadings: false,
	});
}

// --- Tests ------------------------------------------------------------------

console.log("player walks the queue and highlights in order");
{
	const { engine, calls } = makeEngine();
	const player = new Player({ bufferAhead: 1 });
	const chunks = chunksOf(SRC);

	const words: Array<{ text: string; sourceStart: number }> = [];
	player.on("word", (p) => {
		if (p) words.push({ text: SRC.slice(p.timing.sourceStart, p.timing.sourceEnd), sourceStart: p.timing.sourceStart });
	});

	const states: string[] = [];
	player.on("state", (s) => states.push(s));
	let finished = false;
	player.on("finished", () => (finished = true));

	const playing = player.play(engine, chunks, 1);

	// Each chunk: play, advance the clock to the end, let `ended` fire.
	for (let i = 0; i < chunks.length; i++) {
		await tick();
		const at = fakeAudio.currentTime;
		fakeAudio.advance(at + 1.2, 1.0);
		await tick();
	}

	await playing;

	check("all chunks spoken", calls.length === chunks.length, `${calls.length}/${chunks.length}`);
	check("reported finished", finished);
	check("reached finished state", states.at(-1) === "finished", `got ${states.at(-1)}`);
	check("words were emitted", words.length > 0, `got ${words.length}`);

	// Offsets must be non-decreasing and land on real words of the source.
	const offsets = words.map((w) => w.sourceStart);
	check(
		"word offsets never go backwards",
		offsets.every((o, i) => i === 0 || o >= offsets[i - 1]!),
	);
	// A real word, as opposed to landing mid-word or on a stray space. Digits
	// and trailing punctuation are legitimate word content here.
	const allReal = words.every((w) => /^[A-Za-z0-9][A-Za-z0-9.'’-]*[A-Za-z0-9.,!?;:]$|^[A-Za-z0-9]$/.test(w.text));
	check("every highlight landed on a real word", allReal, JSON.stringify(words.filter((w) => !/^[A-Za-z0-9]/.test(w.text)).slice(0, 4)));
	check(
		"highlights match the source text",
		words.every((w) => w.text === SRC.slice(w.sourceStart, w.sourceStart + w.text.length)),
	);
	check("object URLs were revoked", revokedUrls > 0, `revoked ${revokedUrls}`);
}

console.log("pause and resume move the audio element");
{
	const { engine } = makeEngine();
	const player = new Player({ bufferAhead: 0 });
	const chunks = chunksOf(SRC);
	const playing = player.play(engine, chunks, 1);
	await tick();

	player.pause();
	check("pause called on the element", fakeAudio.pauseCalls > 0);
	check("state is paused", player.getState() === "paused", `got ${player.getState()}`);

	player.resume();
	await tick();
	check("play called again", fakeAudio.playCalls >= 2, `playCalls=${fakeAudio.playCalls}`);
	check("state is playing", player.getState() === "playing", `got ${player.getState()}`);

	player.stop();
	await playing.catch(() => undefined);
	check("stop returns to idle", player.getState() === "idle");
}

console.log("rate is applied to audio and to the timeline");
{
	const { engine } = makeEngine();
	const player = new Player({ bufferAhead: 0 });
	// play() only settles when the queue drains, and nothing advances the fake
	// clock here, so this is deliberately not awaited.
	const playing = player.play(engine, chunksOf(SRC), 1.5);
	await tick();
	check("playbackRate set on the element", fakeAudio.playbackRate === 1.5, `got ${fakeAudio.playbackRate}`);
	player.stop();
	await playing.catch(() => undefined);
}

console.log("rate is applied once, not twice");
{
	// An engine that hands back a buffer must render at natural speed: the
	// player is already speeding that audio up, and an engine that also
	// obeyed the rate would multiply the two (1.5x asked for, 2.25x heard).
	const { engine } = makeEngine();
	const seen: number[] = [];
	const spy: SpeechEngine = {
		...engine,
		async synthesize(req: SynthRequest) {
			seen.push(req.rate);
			return await engine.synthesize(req, new AbortController().signal);
		},
	};

	const player = new Player({ bufferAhead: 0 });
	const playing = player.play(spy, chunksOf(SRC), 1.5);
	await tick();
	check("buffer engine asked to render at natural speed", seen[0] === 1, `got ${seen[0]}`);
	check("player still plays it faster", fakeAudio.playbackRate === 1.5, `got ${fakeAudio.playbackRate}`);
	player.stop();
	await playing.catch(() => undefined);

	// An engine that makes the sound itself is the opposite case: nothing
	// downstream can change its speed, so it has to be told.
	const owning: SpeechEngine = {
		...spy,
		capabilities: { ...engine.capabilities, ownsPlayback: true },
	};
	seen.length = 0;
	const player2 = new Player({ bufferAhead: 0 });
	const playing2 = player2.play(owning, chunksOf(SRC), 1.5);
	await tick();
	check("engine that owns playback is given the rate", seen[0] === 1.5, `got ${seen[0]}`);
	player2.stop();
	await playing2.catch(() => undefined);
}

console.log("an engine failure surfaces and stops playback");
{
	// Chunk 0 synthesises fine, chunk 1 blows up. The first chunk has to be
	// played through for the run loop to reach the failure.
	const { engine } = makeEngine({ failOn: 1 });
	const player = new Player({ bufferAhead: 0 });
	const errors: string[] = [];
	player.on("error", (e) => errors.push(e.message));
	let finished = false;
	player.on("finished", () => (finished = true));

	const playing = player.play(engine, chunksOf(SRC), 1);
	await tick();
	fakeAudio.advance(fakeAudio.currentTime + 1.2, 1.0);
	await playing;

	check("error was reported", errors.length > 0, JSON.stringify(errors));
	check("error names the cause", errors[0]?.includes("exploded") === true, errors[0] ?? "none");
	check("did not claim success", !finished);
	check("returned to idle", player.getState() === "idle", `got ${player.getState()}`);
}

console.log("stop() mid-playback aborts cleanly");
{
	const { engine } = makeEngine();
	const player = new Player({ bufferAhead: 0 });
	const playing = player.play(engine, chunksOf(SRC), 1);
	await tick();
	player.stop();
	await playing.catch(() => undefined);
	check("no error emitted on user stop", true);
	check("state idle", player.getState() === "idle");
}

console.log("prefetch synthesises ahead of the current chunk");
{
	const { engine, calls } = makeEngine();
	const player = new Player({ bufferAhead: 3 });
	const playing = player.play(engine, chunksOf(SRC), 1);
	await tick();
	check("prefetched beyond the first chunk", calls.length >= 2, `got ${calls.length} after first tick`);
	check(
		"did not prefetch the whole document",
		calls.length <= chunksOf(SRC).length,
		`got ${calls.length} of ${chunksOf(SRC).length}`,
	);
	player.stop();
	await playing.catch(() => undefined);
}

async function tick(): Promise<void> {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
}

console.log("");
if (failures > 0) {
	console.log(`${failures} FAILURE(S)`);
	process.exit(1);
}
console.log("all player tests passed");
