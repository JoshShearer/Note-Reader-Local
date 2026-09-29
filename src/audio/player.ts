import { Emitter } from "./emitter";
import { WAV_MIME } from "./wav";
import { wordAt } from "./words";
import type { SpeechEngine, SpeechChunk, SynthResult, WordTiming } from "./types";

/**
 * Playback of a chunk queue, independent of how any engine makes sound.
 *
 * Three engine behaviours have to look like one to the rest of the plugin:
 *   - `buffer`  engine produced audio; we drive an <audio> element and can
 *               place words precisely because we know the real duration
 *   - `live`    engine drives playback and reports words as it goes
 *   - `streamed` engine made sound straight to the sound card; all we can do
 *               is wait for it and move on
 *
 * Highlighting is therefore driven by polling `audio.currentTime` against a
 * precomputed word timeline, rather than by playback events. That is the whole
 * reason this works the same on every platform.
 */

export type PlayerState = "idle" | "preparing" | "playing" | "paused" | "finished";

export interface PlayerEvents extends Record<string, unknown> {
	state: PlayerState;
	/** Active word, or null when nothing is highlighted. */
	word: { chunkIndex: number; wordIndex: number; timing: WordTiming } | null;
	progress: { chunkIndex: number; total: number };
	finished: void;
	error: Error;
}

export interface PlayerOptions {
	/** How many upcoming chunks to synthesise ahead of playback. */
	bufferAhead?: number;
}

export class Player {
	private readonly emitter = new Emitter<PlayerEvents>();
	private readonly audio: HTMLAudioElement;
	private readonly bufferAhead: number;

	private chunks: SpeechChunk[] = [];
	private engine: SpeechEngine | null = null;
	private rate = 1;

	private index = 0;
	private state: PlayerState = "idle";
	private controller: AbortController | null = null;
	private runToken = 0;

	/** Synthesised results, keyed by chunk index. */
	private pending = new Map<number, Promise<SynthResult>>();
	/** Object URLs to revoke once their chunk is done with. */
	private objectUrls = new Map<number, string>();

	private wordTimings: WordTiming[] = [];
	private wordOffsets: number[] = [];
	private wordDurations: number[] = [];
	private currentWord = -1;
	private frame: number | null = null;

	constructor(options: PlayerOptions = {}) {
		this.bufferAhead = options.bufferAhead ?? 2;
		this.audio = new Audio();
		this.audio.preload = "auto";
	}

	on<K extends keyof PlayerEvents>(event: K, fn: (payload: PlayerEvents[K]) => void): () => void {
		return this.emitter.on(event, fn);
	}

	getState(): PlayerState {
		return this.state;
	}

	getIndex(): number {
		return this.index;
	}

	/**
	 * Begin reading `chunks`. Replaces any current playback.
	 *
	 * `startAt` is a source offset, so a caller can resume mid-document.
	 */
	async play(
		engine: SpeechEngine,
		chunks: SpeechChunk[],
		rate: number,
		startAtSource = -1,
	): Promise<void> {
		this.stop();

		let start = 0;
		if (startAtSource >= 0) {
			// Land on the first chunk that has not already been passed.
			const found = chunks.findIndex((c) => c.sourceEnd > startAtSource);
			start = found === -1 ? 0 : found;
		}
		if (chunks.length === 0) {
			this.setState("finished");
			return;
		}

		this.engine = engine;
		this.chunks = chunks;
		this.rate = rate || 1;
		this.index = start;
		this.audio.playbackRate = this.rate;
		this.currentWord = -1;

		this.controller = new AbortController();
		const token = ++this.runToken;

		this.setState("preparing");
		this.emitter.emit("progress", { chunkIndex: this.index, total: this.chunks.length });

		try {
			await this.run(token);
		} catch (err) {
			if (token !== this.runToken) return; // superseded by a newer play()
			if (err instanceof DOMException && err.name === "AbortError") return;
			this.setState("idle");
			this.emitter.emit("error", err instanceof Error ? err : new Error(String(err)));
		}
	}

	private async run(token: number): Promise<void> {
		const engine = this.engine;
		const signal = this.controller?.signal;
		if (!engine || !signal) return;

		while (this.index < this.chunks.length && token === this.runToken) {
			if (signal.aborted) return;

			const index = this.index;
			const chunk = this.chunks[index]!;
			this.primeBuffer(index);

			const result = await this.synthesize(index, signal);
			if (token !== this.runToken || signal.aborted) return;

			this.setState("playing");
			this.emitter.emit("progress", { chunkIndex: index, total: this.chunks.length });

			switch (result.kind) {
				case "buffer":
					await this.playBuffer(index, result.audio, result.words, result.durationMs, signal);
					break;
				case "live":
					// Words arrive via onWord; onEnd is fired by the engine.
					break;
				case "streamed":
					break;
			}

			this.clearWordState();
			this.revokeUrl(index);
			if (token !== this.runToken) return;
			this.index = index + 1;
		}

		if (token === this.runToken) {
			this.setState("finished");
			this.emitter.emit("finished", undefined as never);
		}
	}

	/** Synthesise a chunk, caching the promise so prefetch and playback share it. */
	private synthesize(index: number, signal: AbortSignal): Promise<SynthResult> {
		const existing = this.pending.get(index);
		if (existing) return existing;

		const engine = this.engine;
		const chunk = this.chunks[index];
		if (!engine || !chunk) throw new Error("Player has nothing to play");

		// Only an engine that makes the sound itself needs the rate. For
		// everything else the player applies it at playback, which keeps a
		// speed change instant and leaves already-synthesised audio valid.
		const promise = engine.synthesize(
			{
				chunk,
				rate: engine.capabilities.ownsPlayback ? this.rate : 1,
				pitch: 0,
				onWord: this.onEngineWord,
			},
			signal,
		);
		this.pending.set(index, promise);

		// A failed prefetch should not poison the queue: drop it so the
		// playback path can retry and report the real error.
		promise.catch(() => {
			if (this.pending.get(index) === promise) this.pending.delete(index);
		});

		return promise;
	}

	/** Kick off synthesis for the next few chunks. */
	private primeBuffer(from: number): void {
		// On an engine that owns playback, synthesize() is the act of speaking
		// (spd-say, speechSynthesis). A prefetch there starts a second voice
		// talking over the first, or on speechd queues extra clients in
		// whatever order they reach the daemon. run() awaits one chunk at a
		// time, which is the only pacing these engines need.
		if (this.engine?.capabilities.ownsPlayback) return;
		for (let i = from; i < Math.min(from + this.bufferAhead + 1, this.chunks.length); i++) {
			if (this.pending.has(i)) continue;
			void this.synthesize(i, this.controller?.signal ?? new AbortController().signal).catch(
				() => undefined,
			);
		}
	}

	private async playBuffer(
		index: number,
		audio: ArrayBuffer,
		words: WordTiming[],
		durationMs: number,
		signal: AbortSignal,
	): Promise<void> {
		const url = URL.createObjectURL(new Blob([audio], { type: WAV_MIME }));
		this.objectUrls.set(index, url);

		void durationMs;
		this.prepareWordTimeline(words);

		this.audio.src = url;
		this.audio.playbackRate = this.rate;

		await new Promise<void>((resolve, reject) => {
			const cleanup = (): void => {
				this.audio.removeEventListener("ended", onEnded);
				this.audio.removeEventListener("error", onError);
				signal.removeEventListener("abort", onAbort);
				if (this.frame !== null) cancelAnimationFrame(this.frame);
				this.frame = null;
			};
			const onEnded = (): void => {
				cleanup();
				resolve();
			};
			const onError = (): void => {
				cleanup();
				reject(new Error("Audio playback failed"));
			};
			const onAbort = (): void => {
				cleanup();
				this.audio.pause();
				reject(new DOMException("Aborted", "AbortError"));
			};

			this.audio.addEventListener("ended", onEnded, { once: true });
			this.audio.addEventListener("error", onError, { once: true });
			signal.addEventListener("abort", onAbort, { once: true });

			this.audio.play().catch((err: unknown) => {
				cleanup();
				reject(
					err instanceof Error
						? new Error(`Could not start audio playback: ${err.message}`)
						: new Error("Could not start audio playback"),
				);
			});

			this.tick();
		});

		// Guard against engines that return no words at all.
		if (this.wordTimings.length === 0 && this.state === "playing") {
			// Nothing to highlight for this chunk; that is expected on some engines.
		}
	}

	/**
	 * Take the word list the engine produced. Engines that report native
	 * boundary events fill `offsetMs` from the event clock; engines that hand
	 * back a buffer apportion it by syllable weight. Either way the shape is
	 * the same, so the player does not care which it got.
	 */
	private prepareWordTimeline(words: WordTiming[]): void {
		this.wordTimings = words;
		this.currentWord = -1;
	}

	/** rAF loop: map currentTime to a word and emit on change. */
	private tick = (): void => {
		if (this.state !== "playing") return;

		if (this.wordTimings.length > 0) {
			const active = wordAt(this.wordTimings, this.audio.currentTime * 1000);
			if (active !== this.currentWord) {
				this.currentWord = active;
				this.emitter.emit(
					"word",
					active === -1
						? null
						: {
								chunkIndex: this.index,
								wordIndex: active,
								timing: this.wordTimings[active]!,
							},
				);
			}
		}

		this.frame = requestAnimationFrame(this.tick);
	};

	private clearWordState(): void {
		this.wordTimings = [];
		this.currentWord = -1;
		if (this.frame !== null) {
			cancelAnimationFrame(this.frame);
			this.frame = null;
		}
	}

	private revokeUrl(index: number): void {
		const url = this.objectUrls.get(index);
		if (url) {
			URL.revokeObjectURL(url);
			this.objectUrls.delete(index);
		}
	}

	/**
	 * Word reported by an engine that owns playback.
	 *
	 * Only engines returning `kind: "live"` call this, and their timings are
	 * real measurements, so they are emitted straight through rather than being
	 * reconciled with the rAF timeline.
	 */
	private onEngineWord = (timing: WordTiming): void => {
		this.emitter.emit("word", { chunkIndex: this.index, wordIndex: -1, timing });
	};

	pause(): void {
		if (this.state !== "playing") return;
		this.audio.pause();
		this.setState("paused");
	}

	resume(): void {
		if (this.state !== "paused") return;
		void this.audio.play().then(() => {
			this.setState("playing");
			this.tick();
		});
	}

	toggle(): void {
		if (this.state === "playing") this.pause();
		else if (this.state === "paused") this.resume();
	}

	/**
	 * Change the playback rate immediately, mid-chunk if necessary.
	 *
	 * `HTMLAudioElement.playbackRate` applies live, so a running chunk speeds
	 * up or slows down right away rather than waiting for the next one. The
	 * word-highlight timeline needs no adjustment: it is driven by
	 * `audio.currentTime`, which already accounts for the new rate.
	 */
	setRate(rate: number): void {
		this.rate = rate;
		this.audio.playbackRate = rate;
	}

	getRate(): number {
		return this.rate;
	}

	/** Restart the current chunk from the beginning. */
	async replayCurrent(): Promise<void> {
		if (this.state === "idle" || this.state === "finished") return;
		this.index = Math.max(0, this.index);
		const engine = this.engine;
		const chunks = this.chunks;
		if (!engine) return;
		const startSource = chunks[this.index]?.sourceStart ?? -1;
		const trimmed = chunks.slice(this.index);
		await this.play(engine, trimmed, this.rate, startSource < 0 ? -1 : 0);
	}

	stop(): void {
		this.runToken += 1;
		this.controller?.abort();
		this.controller = null;
		this.audio.pause();
		this.audio.removeAttribute("src");
		this.pending.clear();
		// Aborting our own promises does not reach an engine that keeps its own
		// work queue. Without this, restarting playback lands behind every
		// sentence the user already walked away from.
		this.engine?.cancelPending?.();
		for (const url of this.objectUrls.values()) URL.revokeObjectURL(url);
		this.objectUrls.clear();
		this.clearWordState();
		this.setState("idle");
	}

	private setState(state: PlayerState): void {
		if (this.state === state) return;
		this.state = state;
		this.emitter.emit("state", state);
	}

	dispose(): void {
		this.stop();
		this.emitter.clear();
	}
}
