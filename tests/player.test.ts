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

	/** Test hook: make the next play() reject, the way a real element does. */
	failNextPlay = false;

	play(): Promise<void> {
		this.playCalls += 1;
		if (this.failNextPlay) {
			this.failNextPlay = false;
			return Promise.reject(new Error("no supported source"));
		}
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
			// espeak-shaped: a buffer engine, so the player can pause it.
			pause: true,
			resume: true,
			sentenceBoundary: false,
			offlineStatus: true,
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
		speakUrls: false,
		skipCodeBlocks: true,
		skipInlineCode: true,
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

console.log("buffer engine prefetches exactly bufferAhead + 1 chunks");
{
	// Pins the look-ahead that the ownsPlayback gate must leave alone.
	const { engine, calls } = makeEngine();
	const chunks = chunksOf(SRC);
	check("fixture has enough chunks", chunks.length >= 5, `got ${chunks.length}`);
	const player = new Player({ bufferAhead: 2 });
	const playing = player.play(engine, chunks, 1);
	await tick();
	check("current chunk plus two ahead", calls.length === 3, `got ${calls.length}`);
	player.stop();
	await playing.catch(() => undefined);
}

console.log("an engine that owns playback is never prefetched");
{
	// On speechd and webspeech synthesize() is the act of speaking, so a
	// prefetch is a second voice talking over the first (or, on speechd, a
	// client queued in race order). One in flight at a time, in order.
	const { engine } = makeEngine();
	let inFlight = 0;
	let peak = 0;
	const order: number[] = [];
	const chunks: SpeechChunk[] = Array.from({ length: 10 }, (_, i) => {
		const text = `Sentence ${i}.`;
		return {
			text,
			sourceIndex: Array.from(text, (_, k) => i * 100 + k),
			sourceStart: i * 100,
			sourceEnd: i * 100 + text.length,
		};
	});
	const owning: SpeechEngine = {
		...engine,
		capabilities: { ...engine.capabilities, ownsPlayback: true },
		async synthesize(req: SynthRequest): Promise<SynthResult> {
			order.push(req.chunk.sourceStart / 100);
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await new Promise((r) => setTimeout(r, 20));
			inFlight -= 1;
			return { kind: "streamed", estimatedMs: 0, words: null };
		},
	};

	const player = new Player({ bufferAhead: 2 });
	let finished = false;
	player.on("finished", () => (finished = true));
	await player.play(owning, chunks, 1);

	check("finished the queue", finished);
	check("at most one synthesize in flight", peak === 1, `peak ${peak}`);
	check("every chunk spoken exactly once", order.length === 10, `got ${order.length}`);
	check("spoken in chunk order", order.every((n, i) => n === i), order.join(","));
}

/** Hand-built chunks, one per index, so the chunk count is exact. */
function numbered(n: number): SpeechChunk[] {
	return Array.from({ length: n }, (_, i) => {
		const text = `Sentence ${i}.`;
		return {
			text,
			sourceIndex: Array.from(text, (_, k) => i * 100 + k),
			sourceStart: i * 100,
			sourceEnd: i * 100 + text.length,
		};
	});
}

/** Buffer engine that counts synthesize() calls per chunk index. */
function makeCountingEngine(): {
	engine: SpeechEngine;
	perIndex: Map<number, number>;
	cancelPendingCalls: () => number;
} {
	const { engine } = makeEngine({ durationPerChunk: 100 });
	const perIndex = new Map<number, number>();
	let cancels = 0;
	const counting: SpeechEngine = {
		...engine,
		async synthesize(req: SynthRequest, signal: AbortSignal): Promise<SynthResult> {
			const i = req.chunk.sourceStart / 100;
			perIndex.set(i, (perIndex.get(i) ?? 0) + 1);
			return await engine.synthesize(req, signal);
		},
		cancelPending() {
			cancels += 1;
		},
	};
	return { engine: counting, perIndex, cancelPendingCalls: () => cancels };
}

/** Play `chunks`, finishing each buffer chunk until progress reaches `target`. */
async function playUntil(
	player: Player,
	engine: SpeechEngine,
	chunks: SpeechChunk[],
	target: number,
	progress: Array<{ chunkIndex: number; total: number }>,
): Promise<{ playing: Promise<void> }> {
	const playing = player.play(engine, chunks, 1);
	await tick();
	while ((progress.at(-1)?.chunkIndex ?? -1) < target) {
		fakeAudio.advance(fakeAudio.currentTime + 0.2, fakeAudio.currentTime);
		await tick();
	}
	// Wrapped: returning the promise itself would make this await the whole queue.
	return { playing };
}

console.log("replayCurrent keeps the queue and the position");
{
	// Replaying sentence 42 of 186 used to replace the queue with the 145
	// chunks from there on and reset the index, so the readout jumped to
	// 1 / 145 and nothing before sentence 42 could be reached again.
	const { engine, perIndex, cancelPendingCalls } = makeCountingEngine();
	const chunks = numbered(186);
	const player = new Player({ bufferAhead: 2 });
	const progress: Array<{ chunkIndex: number; total: number }> = [];
	player.on("progress", (p) => progress.push(p));

	const { playing } = await playUntil(player, engine, chunks, 41, progress);
	check("reached chunk 41 before replay", player.getIndex() === 41, `got ${player.getIndex()}`);
	check("queue is 186 before replay", progress.at(-1)?.total === 186, JSON.stringify(progress.at(-1)));

	const mark = progress.length;
	void player.replayCurrent();
	await tick();
	const after = progress.slice(mark);
	check(
		"progress after replay is still 41 / 186",
		after.length > 0 && after.every((p) => p.chunkIndex === 41 && p.total === 186),
		JSON.stringify(after),
	);
	check("index unchanged by replay", player.getIndex() === 41, `got ${player.getIndex()}`);
	check("replay plays again", player.getState() === "playing", `got ${player.getState()}`);
	check("current chunk reuses its buffer", perIndex.get(41) === 1, `synthesised ${perIndex.get(41)} times`);
	check(
		"prefetched chunks are kept",
		perIndex.get(42) === 1 && perIndex.get(43) === 1,
		`42: ${perIndex.get(42)}, 43: ${perIndex.get(43)}`,
	);
	check("engine queue not cancelled by replay", cancelPendingCalls() === 0, `${cancelPendingCalls()} calls`);

	// The chunk after the replayed one is 42, not 1.
	fakeAudio.advance(fakeAudio.currentTime + 0.2, fakeAudio.currentTime);
	await tick();
	check(
		"playback continues at 42 / 186",
		progress.at(-1)?.chunkIndex === 42 && progress.at(-1)?.total === 186,
		JSON.stringify(progress.at(-1)),
	);

	player.stop();
	await playing.catch(() => undefined);
}

console.log("ten replays leave the same state as one");
{
	const run = async (
		replays: number,
	): Promise<{ index: number; last: string; state: string; synth41: number | undefined }> => {
		const { engine, perIndex } = makeCountingEngine();
		const player = new Player({ bufferAhead: 2 });
		const progress: Array<{ chunkIndex: number; total: number }> = [];
		player.on("progress", (p) => progress.push(p));
		const { playing } = await playUntil(player, engine, numbered(186), 41, progress);
		for (let i = 0; i < replays; i++) {
			void player.replayCurrent();
			await tick();
		}
		const out = {
			index: player.getIndex(),
			last: JSON.stringify(progress.at(-1)),
			state: player.getState(),
			synth41: perIndex.get(41),
		};
		player.stop();
		await playing.catch(() => undefined);
		return out;
	};
	const one = await run(1);
	const ten = await run(10);
	check("one replay leaves index 41 at 41 / 186", one.index === 41 && one.last === '{"chunkIndex":41,"total":186}', JSON.stringify(one));
	check("ten replays match one", JSON.stringify(ten) === JSON.stringify(one), `one ${JSON.stringify(one)} ten ${JSON.stringify(ten)}`);
}

console.log("replay on an engine that owns playback stops the utterance first");
{
	// synthesize() is the speaking on these engines, so the old utterance has
	// to be aborted before the same chunk is spoken again, or two voices talk.
	const { engine } = makeEngine();
	const events: string[] = [];
	const signals: AbortSignal[] = [];
	let inFlight = 0;
	let peak = 0;
	const owning: SpeechEngine = {
		...engine,
		capabilities: { ...engine.capabilities, ownsPlayback: true },
		async synthesize(req: SynthRequest, signal: AbortSignal): Promise<SynthResult> {
			const i = req.chunk.sourceStart / 100;
			const n = signals.push(signal) - 1;
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			events.push(`start ${i}#${n}`);
			await new Promise<void>((resolve, reject) => {
				let done = false;
				const t = setTimeout(() => {
					if (done) return;
					done = true;
					inFlight -= 1;
					resolve();
				}, 60);
				signal.addEventListener(
					"abort",
					() => {
						if (done) return;
						done = true;
						clearTimeout(t);
						inFlight -= 1;
						events.push(`abort ${i}#${n}`);
						reject(new DOMException("Aborted", "AbortError"));
					},
					{ once: true },
				);
			});
			return { kind: "streamed", estimatedMs: 0, words: null };
		},
	};

	const player = new Player({ bufferAhead: 2 });
	const progress: Array<{ chunkIndex: number; total: number }> = [];
	player.on("progress", (p) => progress.push(p));
	const errors: string[] = [];
	player.on("error", (e) => errors.push(e.message));
	const playing = player.play(owning, numbered(5), 1);
	await new Promise((r) => setTimeout(r, 90)); // chunk 0 done, chunk 1 speaking
	check("speaking chunk 1 before replay", player.getIndex() === 1, `got ${player.getIndex()}`);

	void player.replayCurrent();
	await tick();
	const firstAbort = events.indexOf("abort 1#1");
	const restart = events.indexOf("start 1#2");
	check(
		"old utterance aborted before chunk 1 is spoken again",
		firstAbort !== -1 && restart !== -1 && firstAbort < restart,
		events.join(" | "),
	);
	check("never two utterances at once", peak === 1, `peak ${peak}`);
	check("index unchanged by replay", player.getIndex() === 1, `got ${player.getIndex()}`);
	check(
		"progress still 1 / 5",
		progress.at(-1)?.chunkIndex === 1 && progress.at(-1)?.total === 5,
		JSON.stringify(progress.at(-1)),
	);
	check("abort of the old utterance is not an error", errors.length === 0, JSON.stringify(errors));

	player.stop();
	await playing.catch(() => undefined);
	await tick();
	// Chunk 0 finished on its own; what matters is the one speaking at stop().
	check("stop aborts the utterance in flight", signals.at(-1)?.aborted === true && inFlight === 0, `${signals.map((s) => s.aborted).join(",")} inFlight ${inFlight}`);
}

console.log("both abort paths reach the signal an ownsPlayback engine was handed");
{
	// The channel speechd uses to cancel the daemon is the AbortSignal the
	// player already passes to synthesize(), so there is no new interface
	// member to call. That only works if BOTH abort paths abort that signal.
	const { engine } = makeEngine();
	let cancels = 0;
	const owning: SpeechEngine = {
		...engine,
		capabilities: { ...engine.capabilities, ownsPlayback: true },
		async synthesize(_req: SynthRequest, signal: AbortSignal): Promise<SynthResult> {
			await new Promise<void>((resolve) => {
				if (signal.aborted) {
					resolve();
					return;
				}
				const t = setTimeout(resolve, 5000);
				signal.addEventListener(
					"abort",
					() => {
						cancels += 1;
						clearTimeout(t);
						resolve();
					},
					{ once: true },
				);
			});
			return { kind: "streamed", estimatedMs: 0, words: null };
		},
	};

	const player = new Player({ bufferAhead: 2 });
	const playing = player.play(owning, numbered(3), 1);
	await tick();
	void player.replayCurrent();
	await tick();
	check("replay aborts the utterance's own signal exactly once", cancels === 1, `${cancels}`);
	player.stop();
	await playing.catch(() => undefined);
	await tick();
	check("stop aborts the utterance's own signal too", cancels === 2, `${cancels}`);
}

console.log("stop after a replay still aborts prefetches");
{
	const { engine } = makeEngine();
	const signals: AbortSignal[] = [];
	const slow: SpeechEngine = {
		...engine,
		async synthesize(req: SynthRequest, signal: AbortSignal): Promise<SynthResult> {
			signals.push(signal);
			await new Promise((r) => setTimeout(r, 200));
			return await engine.synthesize(req, signal);
		},
	};
	const player = new Player({ bufferAhead: 2 });
	const playing = player.play(slow, numbered(6), 1);
	await tick();
	void player.replayCurrent();
	await tick();
	player.stop();
	await playing.catch(() => undefined);
	check("prefetches were issued", signals.length >= 3, `got ${signals.length}`);
	check("every synthesis signal aborted by stop", signals.every((s) => s.aborted), signals.map((s) => s.aborted).join(","));
	check("state idle after stop", player.getState() === "idle", `got ${player.getState()}`);
}

console.log("replay restarts from pause and does nothing when idle");
{
	const { engine } = makeEngine({ durationPerChunk: 100 });
	const player = new Player({ bufferAhead: 0 });
	const progress: Array<{ chunkIndex: number; total: number }> = [];
	player.on("progress", (p) => progress.push(p));

	await player.replayCurrent();
	check("replay while idle is a no-op", player.getState() === "idle" && progress.length === 0, `${player.getState()} ${progress.length}`);

	const { playing } = await playUntil(player, engine, numbered(4), 2, progress);
	player.pause();
	check("paused", player.getState() === "paused", `got ${player.getState()}`);
	void player.replayCurrent();
	await tick();
	check("replay from pause plays", player.getState() === "playing", `got ${player.getState()}`);
	check("replay from pause keeps 3 / 4", player.getIndex() === 2 && progress.at(-1)?.total === 4, JSON.stringify(progress.at(-1)));

	player.stop();
	await playing.catch(() => undefined);
}

console.log("setRate emits a rate event, only when the rate changes");
{
	// The control bar and the settings slider both observe this event rather
	// than each other (srs.md R-M16). Emitting only on change is what keeps
	// the two-way sync from looping: a slider that echoes the value back into
	// setRate produces no second event.
	const player = new Player();
	const rates: number[] = [];
	player.on("rate", (r) => rates.push(r));

	player.setRate(1.5);
	check("setRate(1.5) emits 1.5 once", JSON.stringify(rates) === "[1.5]", JSON.stringify(rates));
	player.setRate(1.5);
	check("setRate with the same rate emits nothing", rates.length === 1, JSON.stringify(rates));
	check("audio element follows setRate", fakeAudio.playbackRate === 1.5, String(fakeAudio.playbackRate));
	check("getRate reflects setRate", player.getRate() === 1.5, String(player.getRate()));

	const { engine } = makeEngine();
	const playing = player.play(engine, chunksOf(SRC), 1.25);
	await tick();
	check("play() with a different rate emits it once", JSON.stringify(rates) === "[1.5,1.25]", JSON.stringify(rates));
	player.stop();
	await playing.catch(() => undefined);

	const again = player.play(engine, chunksOf(SRC), 1.25);
	await tick();
	check("play() at the current rate emits nothing", rates.length === 2, JSON.stringify(rates));
	player.stop();
	await again.catch(() => undefined);
}

// --- NRL-23: pause on an engine that owns playback --------------------------

/**
 * An engine that makes the sound itself, as speechd and webspeech do.
 *
 * `synthesize()` is the utterance: it does not settle until the fake is told
 * to finish or its signal aborts. That is the whole reason pause is hard here,
 * so the fake has to behave that way rather than resolving immediately.
 */
function makeOwningEngine(opts: { enginePause?: boolean; halfPair?: boolean } = {}): {
	engine: SpeechEngine;
	calls: Array<{ index: number; rate: number }>;
	aborted: number[];
	stateDuring: string[];
	pauseCalls: () => number;
	resumeCalls: () => number;
	finish: () => void;
	observe: (fn: () => string) => void;
} {
	const calls: Array<{ index: number; rate: number }> = [];
	const aborted: number[] = [];
	const stateDuring: string[] = [];
	let observeState: () => string = () => "?";
	let finishCurrent: (() => void) | null = null;
	let pauses = 0;
	let resumes = 0;

	const engine: SpeechEngine = {
		id: "speechd",
		label: "fake that owns playback",
		capabilities: {
			voices: false,
			timing: "none",
			rate: true,
			pitch: true,
			desktopOnly: true,
			pause: true,
			resume: true,
			sentenceBoundary: false,
			offlineStatus: true,
			ownsPlayback: true,
		},
		async isAvailable() {
			return true;
		},
		async listVoices() {
			return [];
		},
		async selectVoice() {},
		async synthesize(req: SynthRequest, signal: AbortSignal): Promise<SynthResult> {
			const index = req.chunk.sourceStart / 100;
			calls.push({ index, rate: req.rate });
			// A microtask later, so the player has finished whatever it does
			// around the call and the state we read is the one pause() sees.
			await Promise.resolve();
			stateDuring.push(`${index}:${observeState()}`);
			await new Promise<void>((resolve) => {
				finishCurrent = resolve;
				signal.addEventListener(
					"abort",
					() => {
						aborted.push(index);
						resolve();
					},
					{ once: true },
				);
			});
			return { kind: "streamed", estimatedMs: 0, words: null };
		},
		async dispose() {},
	};

	if (opts.enginePause) {
		engine.pause = (): void => {
			pauses += 1;
		};
		engine.resume = (): void => {
			resumes += 1;
		};
	}
	if (opts.halfPair) {
		engine.pause = (): void => {
			pauses += 1;
		};
	}

	return {
		engine,
		calls,
		aborted,
		stateDuring,
		pauseCalls: () => pauses,
		resumeCalls: () => resumes,
		finish: () => finishCurrent?.(),
		observe: (fn) => {
			observeState = fn;
		},
	};
}

console.log("an engine that owns playback reaches state playing while it speaks");
{
	// run() used to announce "playing" only AFTER awaiting synthesize(). On
	// these engines synthesize() IS the utterance, so the first sentence of
	// every note was spoken in state "preparing", where pause() early-returns
	// and the control bar shows a spinner over a button it forces disabled.
	const fake = makeOwningEngine();
	const player = new Player({ bufferAhead: 2 });
	fake.observe(() => player.getState());
	const playing = player.play(fake.engine, numbered(3), 1);

	for (let i = 0; i < 3; i++) {
		await tick();
		fake.finish();
	}
	await playing;

	check(
		"every chunk is spoken in state playing",
		fake.stateDuring.join(" | ") === "0:playing | 1:playing | 2:playing",
		fake.stateDuring.join(" | "),
	);
}

console.log("pause stops the sound on an engine that cannot pause itself");
{
	// srs.md:250: where a backend cannot pause an active utterance, the
	// controller may pause by stopping synthesis and retaining the position.
	// That is speechd, and the stop reaches the daemon through the same abort
	// signal NRL-41 already wired up.
	const fake = makeOwningEngine();
	const player = new Player({ bufferAhead: 2 });
	fake.observe(() => player.getState());
	const states: string[] = [];
	player.on("state", (s) => states.push(s));
	const playing = player.play(fake.engine, numbered(3), 1);
	await tick();

	check("speaking chunk 0 before the pause", player.getIndex() === 0 && player.getState() === "playing", `${player.getIndex()} ${player.getState()}`);

	player.pause();
	await tick();
	check("state is paused", player.getState() === "paused", `got ${player.getState()}`);
	check("the utterance was aborted exactly once", fake.aborted.join(",") === "0", fake.aborted.join(","));
	check("index is retained", player.getIndex() === 0, `got ${player.getIndex()}`);

	// The defect: the run loop used to walk straight on to the next chunk.
	await new Promise((r) => setTimeout(r, 30));
	await tick();
	check("the queue does not advance while paused", player.getState() === "paused" && player.getIndex() === 0, `${player.getState()} ${player.getIndex()}`);
	check("nothing else was spoken while paused", fake.calls.length === 1, JSON.stringify(fake.calls));

	void player.resume();
	await tick();
	check("resume re-speaks the same sentence", fake.calls.length === 2 && fake.calls[1]?.index === 0, JSON.stringify(fake.calls));
	check("resume is playing again", player.getState() === "playing", `got ${player.getState()}`);
	check("resume did not restart the note", player.getIndex() === 0, `got ${player.getIndex()}`);

	fake.finish();
	await tick();
	check("the queue continues to the next chunk", player.getIndex() === 1 && fake.calls.at(-1)?.index === 1, `${player.getIndex()} ${JSON.stringify(fake.calls)}`);

	player.stop();
	await playing.catch(() => undefined);
}

console.log("pause asks a live engine to pause rather than cutting it off");
{
	// webspeech: speechSynthesis has a real pause()/resume(), so the utterance
	// must be left alone and picked up mid-word. Aborting it would throw the
	// rest of the sentence away and re-read it.
	const fake = makeOwningEngine({ enginePause: true });
	const player = new Player({ bufferAhead: 2 });
	fake.observe(() => player.getState());
	const playing = player.play(fake.engine, numbered(2), 1);
	await tick();

	player.pause();
	await tick();
	check("engine.pause() was called once", fake.pauseCalls() === 1, String(fake.pauseCalls()));
	check("the utterance was not aborted", fake.aborted.length === 0, fake.aborted.join(","));
	check("state is paused", player.getState() === "paused", `got ${player.getState()}`);

	await new Promise((r) => setTimeout(r, 30));
	check("still paused, and nothing new was spoken", player.getState() === "paused" && fake.calls.length === 1, `${player.getState()} ${JSON.stringify(fake.calls)}`);

	void player.resume();
	await tick();
	check("engine.resume() was called once", fake.resumeCalls() === 1, String(fake.resumeCalls()));
	check("state is playing", player.getState() === "playing", `got ${player.getState()}`);
	// The loop stayed parked inside the same synthesize() call, which is the
	// only way a mid-utterance resume can work.
	check("the sentence was synthesised exactly once across the pause", fake.calls.filter((c) => c.index === 0).length === 1, JSON.stringify(fake.calls));

	fake.finish();
	await tick();
	fake.finish();
	await tick();
	await playing;
	check("the queue finished", player.getState() === "finished", `got ${player.getState()}`);
}

console.log("an engine that declares pause without resume is refused, not half-used");
{
	// A pause with no way back is the defect this ticket exists to remove, so
	// a half-declared pair must not be taken as engine support. It falls back
	// to the stop-and-retain route and says so rather than failing silently.
	const fake = makeOwningEngine({ halfPair: true });
	const player = new Player({ bufferAhead: 2 });
	fake.observe(() => player.getState());
	const errors: string[] = [];
	player.on("error", (e) => errors.push(e.message));
	const playing = player.play(fake.engine, numbered(2), 1);
	await tick();

	player.pause();
	await tick();
	check("the half-declared pause() was not called", fake.pauseCalls() === 0, String(fake.pauseCalls()));
	check("it fell back to stopping the utterance", fake.aborted.join(",") === "0", fake.aborted.join(","));
	check("state is still paused", player.getState() === "paused", `got ${player.getState()}`);
	check("the contract violation was reported", errors.some((e) => e.includes("pause")) && errors.length === 1, JSON.stringify(errors));

	player.stop();
	await playing.catch(() => undefined);
}

console.log("a rejected resume reports an error instead of hanging in paused");
{
	const { engine } = makeEngine();
	const player = new Player({ bufferAhead: 0 });
	const errors: string[] = [];
	player.on("error", (e) => errors.push(e.message));
	const playing = player.play(engine, chunksOf(SRC), 1);
	await tick();

	player.pause();
	check("paused", player.getState() === "paused", `got ${player.getState()}`);

	fakeAudio.failNextPlay = true;
	void player.resume();
	await tick();

	check("exactly one error was emitted", errors.length === 1, JSON.stringify(errors));
	check("the error names the resume", errors[0]?.includes("Could not resume audio playback") === true, errors[0] ?? "none");
	check("the error carries the cause", errors[0]?.includes("no supported source") === true, errors[0] ?? "none");
	check("not left stuck in paused", player.getState() !== "paused", `got ${player.getState()}`);

	player.stop();
	await playing.catch(() => undefined);
}

console.log("rate is still applied exactly once across a pause and resume");
{
	// AGENTS.md non-negotiable 9, re-checked because this ticket touches the
	// pause and resume paths that re-enter synthesis.
	const { engine } = makeEngine();
	const seen: number[] = [];
	const spy: SpeechEngine = {
		...engine,
		async synthesize(req: SynthRequest, signal: AbortSignal) {
			seen.push(req.rate);
			return await engine.synthesize(req, signal);
		},
	};
	const player = new Player({ bufferAhead: 0 });
	const playing = player.play(spy, chunksOf(SRC), 1.5);
	await tick();
	player.pause();
	void player.resume();
	await tick();
	check("buffer engine still renders at natural speed after a resume", seen.every((r) => r === 1), JSON.stringify(seen));
	check("the element still carries the whole 1.5x", fakeAudio.playbackRate === 1.5, String(fakeAudio.playbackRate));
	player.stop();
	await playing.catch(() => undefined);

	// The stop-and-retain route re-synthesises the sentence. Asking for 1.5x
	// a second time is correct; asking for 2.25x, or letting the element also
	// apply 1.5x to audio it does not hold, is the bug this pins.
	const fake = makeOwningEngine();
	const player2 = new Player({ bufferAhead: 0 });
	fake.observe(() => player2.getState());
	const playing2 = player2.play(fake.engine, numbered(3), 1.5);
	await tick();
	player2.pause();
	await tick();
	void player2.resume();
	await tick();
	check("re-synthesis after a pause asks for 1.5, not 2.25", fake.calls.length === 2 && fake.calls.every((c) => c.rate === 1.5), JSON.stringify(fake.calls));
	player2.stop();
	await playing2.catch(() => undefined);
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
