import { Emitter } from "./emitter";
import { WAV_MIME } from "./wav";
import { wordAt } from "./words";
import { startsParagraph } from "./paragraphs";
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

/**
 * How a pause is going to be carried out, decided by who is making the sound.
 *
 * `element`  the player holds the audio, so pausing the element is the pause.
 * `engine`   the engine can hold its own utterance in place (speechSynthesis).
 * `restart`  nothing can hold the utterance, so it is stopped and the index
 *            retained; resume re-reads the sentence
 *            (srs.md, R-M07 Playback Controls, the pause-by-stopping sentence).
 */
type PauseRoute = "element" | "engine" | "restart";

export interface PlayerEvents extends Record<string, unknown> {
	state: PlayerState;
	/** Active word, or null when nothing is highlighted. */
	word: { chunkIndex: number; wordIndex: number; timing: WordTiming; rev?: number } | null;
	/** Active chunk (sentence) for sentence-level highlighting. */
	chunk: SpeechChunk | null;
	progress: { chunkIndex: number; total: number };
	/**
	 * Whether the player is waiting for audio that is not ready yet, with
	 * nothing audible: at the start of a read, or when synthesis has fallen
	 * behind playback. Emitted only on change.
	 */
	generating: boolean;
	/**
	 * Playback rate, emitted only when it changes. The control bar and the
	 * settings slider both observe this rather than each other (srs.md
	 * R-M16), and emitting only on change is what stops a slider that writes
	 * the value back from looping.
	 */
	rate: number;
	/**
	 * Pitch control, emitted only when it changes. Like rate, both the control
	 * bar and the settings slider observe this to avoid feedback loops.
	 */
	pitch: number;
	/** Timer countdown in milliseconds remaining, emitted on each tick while running. */
	timer: number;
	/** Timer expired event, emitted when the timer reaches zero. */
	timerExpired: void;
	finished: void;
	error: Error;
}

export interface PlayerOptions {
	/** How many upcoming chunks to synthesise ahead of playback. */
	bufferAhead?: number;
	/**
	 * Longest text, in characters, submitted to an engine as one utterance.
	 *
	 * The queue holds sentences, which is what the reader counts, previews and
	 * skips through. Speaking each one as its own utterance pauses after every
	 * sentence, so consecutive sentences of one paragraph are joined into a
	 * single utterance up to this length and the sentence cursor follows the
	 * words as they are spoken. 0 (the default) turns joining off.
	 */
	groupChars?: number;
}

/** An utterance: sentences `first`..`last` of the queue, joined. */
interface Unit {
	first: number;
	last: number;
	chunk: SpeechChunk;
}

/**
 * The first utterance of a run is kept short so speech starts quickly: a
 * whole paragraph from a slow engine is many seconds before any sound.
 */
const FIRST_UNIT_CHARS = 240;

/** How long audio may be missing before the wait is announced; shorter waits are not worth a flicker. */
const GENERATING_SHOW_MS = 150;

const BUFFER_AHEAD_MIN = 0;
const BUFFER_AHEAD_MAX = 8;
const BUFFER_AHEAD_DEFAULT = 2;

/**
 * An integer look-ahead in range, or the default.
 *
 * Deliberately the same rule `normaliseSettings` applies to the stored value,
 * and deliberately not imported from there: the player knows nothing about
 * settings, and a dependency that way round would drag plugin data into the
 * audio layer. If the range moves, it moves in both places.
 */
function normaliseBufferAhead(value: unknown): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) return BUFFER_AHEAD_DEFAULT;
	return Math.round(Math.max(BUFFER_AHEAD_MIN, Math.min(BUFFER_AHEAD_MAX, n)));
}

export class Player {
	private readonly emitter = new Emitter<PlayerEvents>();
	private readonly audio: HTMLAudioElement;
	/** Not readonly: the Look ahead slider changes this mid-session (setBufferAhead). */
	private bufferAhead: number;

	private chunks: SpeechChunk[] = [];
	private engine: SpeechEngine | null = null;
	private rate = 1;
	private pitch = 0;
	private timerMs: number = 0;
	private timerInterval: number | null = null;
	private timerStartedAt: number = 0;

	private index = 0;
	/** Sentences joined for synthesis, keyed by the sentence they start at. */
	private units = new Map<number, Unit>();
	/** Where the utterance being prepared or spoken starts; -1 when none. */
	private unitStart = -1;
	private readonly groupChars: number;
	/**
	 * A fresh extraction of the note that takes over at the next utterance
	 * boundary, set by `queueReplacement`. Only one is kept; a newer one wins.
	 */
	private replacement: { chunks: SpeechChunk[]; resume: (last: SpeechChunk) => number } | null = null;
	/** The utterance playback is waiting on, once the wait is long enough to show. */
	private awaitingAudio: number | null = null;
	/** Audio is sounding from the element right now (false in the gaps between utterances). */
	private audioActive = false;
	/**
	 * The user paused while no audio was sounding (before the first sentence, or
	 * while synthesis was behind). The next utterance is made ready but not
	 * started until resume().
	 */
	private holdStart = false;
	/** Held audio is ready and waiting for resume(). */
	private heldForResume = false;
	private state: PlayerState = "idle";
	/**
	 * Session scope: aborted only by stop(). Buffer-engine synthesis and
	 * prefetches hang off this, so a replay does not throw away audio that is
	 * still valid.
	 */
	private controller: AbortController | null = null;
	/**
	 * Scope of the chunk currently being played, linked to the session. A
	 * replay aborts only this: it stops the <audio> element, and on an engine
	 * that owns playback it stops the utterance itself.
	 */
	private chunkScope: LinkedScope | null = null;
	private runToken = 0;
	/**
	 * The route the current pause was taken by, so resume() undoes what pause()
	 * did rather than deciding again. Null whenever nothing is paused.
	 */
	private pausedVia: PauseRoute | null = null;

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
		this.bufferAhead = normaliseBufferAhead(options.bufferAhead);
		this.groupChars = Math.max(0, Math.floor(options.groupChars ?? 0));
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
	 * The note this player is reading, or "" before the first play().
	 *
	 * Every chunk of one extraction carries the same path, so the first is
	 * enough. This exists so a caller can ask the player which file it is on
	 * instead of reaching into a private field, and, more to the point, so it
	 * can ask the player rather than the workspace: a read that outlives the
	 * note being in front would otherwise record its progress against whichever
	 * note happens to be active now.
	 *
	 * Deliberately not cleared by stop(): the queue is where this player's file
	 * identity lives, and it stays readable until the next play() replaces it.
	 * main.ts reads a position's file and its chunk identity as a pair out of
	 * this one queue, so the two accessors are a unit.
	 *
	 * The queue outliving stop() is load-bearing since NRL-51, which is what this
	 * comment used to get wrong. It claimed the trailing-save hazard did not
	 * exist because every save was driven by a progress event and stop() emits
	 * none. That is true of the old leading-edge gate, which recorded nothing
	 * inside its window and so had nothing to lose - but it is a reason that
	 * gate lost the last position of every read, not a reason the hazard is
	 * absent. The gate is now a throttle with a trailing flush, and the flush
	 * runs on the state change that stop() causes, so the queue has to still be
	 * there when it does.
	 */
	getFilePath(): string {
		return this.chunks[0]?.filePath ?? "";
	}

	/**
	 * One chunk of the queue by index, or undefined if there is none.
	 *
	 * A single chunk rather than the array, so `chunks` stays private the way
	 * getIndex() already implies. Read-only by construction: a caller that
	 * could hand back the array could also reorder it underneath run().
	 */
	getChunk(index: number): SpeechChunk | undefined {
		return this.chunks[index];
	}

	/** How many chunks the queue holds; 0 before the first play(). */
	getChunkCount(): number {
		return this.chunks.length;
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
		pitch: number,
		startAtSource = -1,
	): Promise<void> {
		this.stop();

		let start = 0;
		if (startAtSource >= 0) {
			// Land on the first chunk that has not already been passed.
			//
			// `sourceEnd >` rather than a containment test is the point: an offset
			// inside a span nothing was spoken from (a skipped code block, a
			// skipped table) belongs to the chunk after it, which is the nearest
			// valid position. A caller that pre-resolves the offset against
			// `sourceStart <= off < sourceEnd` cannot do this and silently sends
			// such an offset to -1, which reads here as "the top of the note";
			// that is why startAtSource is passed through as stored.
			const found = chunks.findIndex((c) => c.sourceEnd > startAtSource);
			// Past the end is the LAST chunk, not the first. A stored offset from a
			// longer version of the note, or from one that has since been
			// truncated, must resume at the end rather than restart from the top
			// (srs.md, R-M12 Reading Position: restore the nearest valid source position).
			start = found === -1 ? chunks.length - 1 : found;
		}
		// ORDERING IS LOAD BEARING, and this is the only thing making the line
		// above safe. For an empty queue `chunks.length - 1` is -1, which is
		// harmless only because this returns before `this.index = start` below.
		// Hoisted above the computation, or applied to this.index directly, it
		// would leave a player holding nothing reporting getIndex() === -1, which
		// reaches main.ts's progress handler and is swallowed there by its
		// `chunkIndex < 0` guard: silent degradation, not a crash.
		// tests/player.test.ts pins this case.
		if (chunks.length === 0) {
			this.setState("finished");
			return;
		}

		this.engine = engine;
		this.chunks = chunks;
		this.units.clear();
		this.unitStart = -1;
		this.replacement = null;
		this.setRate(rate || 1);
		this.setPitch(pitch);
		this.index = start;
		this.currentWord = -1;

		this.controller = new AbortController();
		const token = ++this.runToken;

		this.setState("preparing");
		this.emitter.emit("progress", { chunkIndex: this.index, total: this.chunks.length });

		await this.startRun(token);
	}

	/** Run the queue from `this.index`, turning failures into an error event. */
	private async startRun(token: number): Promise<void> {
		try {
			await this.run(token);
		} catch (err) {
			if (token !== this.runToken) return; // superseded by a newer play() or replay
			if (err instanceof DOMException && err.name === "AbortError") return;
			this.setState("idle");
			this.emitter.emit("error", err instanceof Error ? err : new Error(String(err)));
		}
	}

	private async run(token: number): Promise<void> {
		const engine = this.engine;
		const session = this.controller?.signal;
		if (!engine || !session) return;

		let firstOfRun = true;
		while (this.index < this.chunks.length && token === this.runToken) {
			if (session.aborted) return;

			const index = this.index;
			const unit = this.unitAt(index, firstOfRun ? FIRST_UNIT_CHARS : this.groupChars);
			firstOfRun = false;
			this.unitStart = index;
			this.primeBuffer(index);

			const scope = linkedScope(session);
			this.chunkScope = scope;
			const signal = scope.signal;
			const owns = engine.capabilities.ownsPlayback;
			try {
				// On an engine that owns playback, synthesize() IS the act of
				// speaking, so it is already too late to announce "playing"
				// once it resolves. Doing so left the first sentence of every
				// note spoken in state "preparing", where pause() early-returns
				// and the control bar puts a spinner over a button it forces
				// disabled - i.e. that sentence could not be paused at all.
				// The cost is a second progress event for the first chunk,
				// carrying the same index play() already emitted.
				if (owns) this.announcePlaying(index);

				// A buffer engine's synthesis is shared with prefetch and stays
				// valid across a replay, so it only answers to the session. On an
				// engine that owns playback the synthesis IS the utterance, and a
				// replay has to be able to cut it off.
				const result = await this.awaitSynthesis(index, owns ? signal : session, owns);
				if (token !== this.runToken || signal.aborted) return;

				if (!owns) this.announcePlaying(index);

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
			} finally {
				scope.release();
				if (this.chunkScope === scope) this.chunkScope = null;
			}

			this.clearWordState();
			this.revokeUrl(index);
			if (token !== this.runToken) return;
			const replacement = this.replacement;
			if (replacement) {
				// The note was edited while this utterance was spoken, and a fresh
				// extraction is waiting. This boundary is the one place the queue
				// can change without cutting speech off: continue from the
				// sentence after the one just finished, in the new queue.
				this.replacement = null;
				const last = this.chunks[unit.last];
				const at = last ? replacement.resume(last) : 0;
				this.chunks = replacement.chunks;
				this.units.clear();
				this.pending.clear();
				this.unitStart = -1;
				this.index = Math.max(0, Math.min(at, this.chunks.length));
				if (this.index < this.chunks.length) {
					this.emitter.emit("progress", { chunkIndex: this.index, total: this.chunks.length });
				}
			} else {
				// The whole utterance is done, whichever sentence the cursor had
				// reached inside it.
				this.index = unit.last + 1;
			}
		}

		if (token === this.runToken) {
			this.setState("finished");
			this.emitter.emit("finished", undefined);
		}
	}

	private announcePlaying(index: number): void {
		// Not when the user paused before this audio existed: it stays paused.
		if (!this.holdStart) this.setState("playing");
		this.emitter.emit("progress", { chunkIndex: index, total: this.chunks.length });
		const chunk = this.chunks[index] || null;
		this.emitter.emit("chunk", chunk);
	}

	/**
	 * The utterance that starts at sentence `start`.
	 *
	 * Built once per start and kept, so prefetch and playback agree on how far
	 * it reaches. Joining stops at a different block type, at a gap in the
	 * source wider than a space or one line break (a blank line, a list
	 * marker, a quote prefix), at `maxChars`, and for a chunk carrying
	 * segmenter word spans, whose offsets would have to be rebased. An engine
	 * that reports no timing is never joined: nothing would tell the cursor
	 * which sentence of the utterance is being spoken.
	 */
	private unitAt(start: number, maxChars: number): Unit {
		const existing = this.units.get(start);
		if (existing) return existing;

		const first = this.chunks[start];
		if (!first) throw new Error("Player has nothing to play");
		let last = start;
		let length = first.text.length;
		const joinable =
			this.groupChars > 0 &&
			(this.engine?.capabilities.timing ?? "none") !== "none" &&
			first.blockType !== "heading" &&
			first.wordSpans === undefined;
		if (joinable) {
			for (;;) {
				const next = this.chunks[last + 1];
				if (!next) break;
				if (next.wordSpans !== undefined || startsParagraph(this.chunks, last + 1)) break;
				if (length + 1 + next.text.length > Math.max(maxChars, first.text.length)) break;
				length += 1 + next.text.length;
				last += 1;
			}
		}

		const unit: Unit = {
			first: start,
			last,
			chunk: last === start ? first : joinChunks(this.chunks.slice(start, last + 1)),
		};
		this.units.set(start, unit);
		return unit;
	}

	/**
	 * Wait for an utterance's audio, telling listeners if the wait is long.
	 *
	 * A prefetched utterance is usually ready at once, so "waiting" is only
	 * announced after a short delay; without it the status would flicker on
	 * every sentence. An engine that owns playback is excluded: its synthesis is
	 * the speaking itself, so there is no silent wait to report.
	 */
	private async awaitSynthesis(index: number, signal: AbortSignal, owns: boolean): Promise<SynthResult> {
		const pending = this.synthesize(index, signal);
		if (owns) return await pending;
		const timer = window.setTimeout(() => {
			this.awaitingAudio = index;
			this.emitGenerating();
		}, GENERATING_SHOW_MS);
		try {
			return await pending;
		} finally {
			window.clearTimeout(timer);
			this.clearGenerating();
		}
	}

	private emitGenerating(): void {
		this.emitter.emit("generating", this.awaitingAudio !== null);
	}

	/** Stop reporting a wait, if one was being reported. */
	private clearGenerating(): void {
		if (this.awaitingAudio === null) return;
		this.awaitingAudio = null;
		this.emitGenerating();
	}

	/** Synthesise the utterance starting at `index`, caching the promise so prefetch and playback share it. */
	private synthesize(index: number, signal: AbortSignal): Promise<SynthResult> {
		const existing = this.pending.get(index);
		if (existing) return existing;

		const engine = this.engine;
		if (!engine || !this.chunks[index]) throw new Error("Player has nothing to play");
		const unit = this.unitAt(index, this.groupChars);

		// Only an engine that makes the sound itself needs the rate. For
		// everything else the player applies it at playback, which keeps a
		// speed change instant and leaves already-synthesised audio valid.
		const promise = engine.synthesize(
			{
				chunk: unit.chunk,
				rate: engine.capabilities.ownsPlayback ? this.rate : 1,
				pitch: this.pitch,
				onWord: this.onEngineWord,
				following: engine.capabilities.ownsPlayback ? () => this.chunks.slice(unit.last + 1) : undefined,
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

	/** Kick off synthesis for the next few utterances, starting at the one beginning at `from`. */
	private primeBuffer(from: number): void {
		// On an engine that owns playback, synthesize() is the act of speaking
		// (spd-say, speechSynthesis). A prefetch there starts a second voice
		// talking over the first, or on speechd queues extra clients in
		// whatever order they reach the daemon. run() awaits one chunk at a
		// time, which is the only pacing these engines need.
		if (this.engine?.capabilities.ownsPlayback) return;
		// A replacement is waiting: audio for the old queue would be thrown away.
		if (this.replacement) return;
		let start = from;
		for (let n = 0; n <= this.bufferAhead && start < this.chunks.length; n++) {
			if (!this.pending.has(start)) {
				void this.synthesize(start, this.controller?.signal ?? new AbortController().signal).catch(
					() => undefined,
				);
			}
			start = this.unitAt(start, this.groupChars).last + 1;
		}
	}

	/** Where the utterance in flight starts, or the cursor when nothing is. */
	private currentUnitStart(): number {
		return this.unitStart >= 0 ? this.unitStart : this.index;
	}

	/**
	 * Move the sentence cursor to the sentence the spoken word is in.
	 *
	 * An utterance spans several sentences, so playback no longer tells us which
	 * one is being read; the words do. Each carries the note offset it came
	 * from, and the sentence is the last one starting at or before it. Only
	 * moves forward and only inside the current utterance. Engines reporting no
	 * timing never produce words, and are never joined (see `unitAt`).
	 */
	private followWord(sourceStart: number): void {
		const unit = this.units.get(this.unitStart);
		if (!unit || unit.last === unit.first) return;
		let at = Math.max(this.index, unit.first);
		while (at < unit.last && this.chunks[at + 1]!.sourceStart <= sourceStart) at += 1;
		if (at === this.index) return;
		this.index = at;
		this.emitter.emit("progress", { chunkIndex: at, total: this.chunks.length });
		this.emitter.emit("chunk", this.chunks[at] ?? null);
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
		console.debug(
			`[Local TTS Reader] playing chunk ${index + 1}: ${audio.byteLength} bytes, ~${Math.round(durationMs)} ms, rate ${this.rate}`,
		);

		await new Promise<void>((resolve, reject) => {
			const cleanup = (): void => {
				this.audioActive = false;
				this.audio.removeEventListener("ended", onEnded);
				this.audio.removeEventListener("error", onError);
				signal.removeEventListener("abort", onAbort);
				if (this.frame !== null) cancelAnimationFrame(this.frame);
				this.frame = null;
			};
			const onEnded = (): void => {
				console.debug(`[Local TTS Reader] chunk ${index + 1} ended`);
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

			if (this.holdStart) {
				// Paused before this audio was ready: it waits for resume().
				this.heldForResume = true;
			} else {
				this.audioActive = true;
				this.audio.play().catch((err: unknown) => {
					cleanup();
					reject(
						err instanceof Error
							? new Error(`Could not start audio playback: ${err.message}`)
							: new Error("Could not start audio playback"),
					);
				});
			}

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
				if (active !== -1) this.followWord(this.wordTimings[active]!.sourceStart);
				this.emitter.emit(
					"word",
					active === -1
						? null
						: {
								chunkIndex: this.index,
								wordIndex: active,
								timing: this.wordTimings[active]!,
								rev: this.units.get(this.unitStart)?.chunk.rev,
							},
				);
			}
		}

		this.frame = window.requestAnimationFrame(this.tick);
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
		this.followWord(timing.sourceStart);
		this.emitter.emit("word", {
			chunkIndex: this.index,
			wordIndex: -1,
			timing,
			rev: this.units.get(this.unitStart)?.chunk.rev,
		});
	};

	/**
	 * Who is going to carry out a pause, and how.
	 *
	 * Deliberately not decided from `result.kind`: on an engine that owns
	 * playback the result does not exist until the utterance is over, which is
	 * precisely when pause is pressed. `ownsPlayback` is the only thing known
	 * at that moment, and using it here is not a non-negotiable-9 problem -
	 * run() already branches on it four times for this same "who holds the
	 * sound" question. What rule 9 protects is rate routing, and what
	 * affordances.ts protects is that the *UI* must not infer pause-ability
	 * from it. The player is the layer that legitimately knows.
	 */
	private pauseRoute(): PauseRoute {
		const engine = this.engine;
		if (!engine) return "element";

		const canPause = typeof engine.pause === "function";
		const canResume = typeof engine.resume === "function";

		// Tested BEFORE the pair, and the order is the whole fix (NRL-49). A
		// buffer engine's sound lives in the player's own <audio> element, so
		// engine.pause() cannot stop it: taking the engine route on a declaration
		// alone left the player reporting "paused" over sound that kept playing,
		// and returned out of resume() before the element route's primeBuffer(),
		// so a Look ahead raise stored while paused was never spent. types.ts
		// promises these are never called on a buffer engine; this is what makes
		// that true rather than merely likely.
		if (!engine.capabilities.ownsPlayback) {
			if (canPause || canResume) {
				// Declaring either half is the programming error, whichever half it
				// is: neither method can ever be called here. Reported rather than
				// silently ignored, because silence is how it went unnoticed in the
				// first place. Fires once per pause press, not once per engine, and
				// main.ts's "error" handler clears the highlight and raises a Notice;
				// that is loud for a pause which in fact succeeded, and is the known
				// cost of reporting it through the same channel as the half-pair
				// notice rather than a second one. Log-safe by construction (non-negotiable
				// 1): this reaches trace() via reportError, and it interpolates
				// only engine.id, never note text. Keep it that way.
				this.emitter.emit(
					"error",
					new Error(
						`Engine "${engine.id}" declares pause()/resume() but does not own playback; ` +
							"the player holds the sound in its own <audio> element and never calls them. " +
							"Pausing the element instead.",
					),
				);
			}
			return "element";
		}

		if (canPause && canResume) return "engine";
		if (canPause !== canResume) {
			// Half a pair is a programming error, and silently taking the half
			// that exists is how a reading ends up paused with nothing able to
			// resume it. Refuse the engine route, say so, and fall through to a
			// route that does have a way back. Only reachable on an engine that
			// owns playback now, which is what makes the message's last sentence
			// true: stopping the sentence is exactly what "restart" does.
			this.emitter.emit(
				"error",
				new Error(
					`Engine "${engine.id}" implements ${canPause ? "pause" : "resume"}() without ` +
						`${canPause ? "resume" : "pause"}(); they must come as a pair. ` +
						"Pausing by stopping the sentence instead.",
				),
			);
		}

		// A literal, not `ownsPlayback ? "restart" : "element"`, so the invariant
		// the guard above enforces is visible here: everything still falling
		// through owns its playback. That is only true while that guard returns
		// for every buffer engine, so the edit to refuse is weakening, narrowing
		// or moving the guard itself - not inserting a return between it and this
		// line, which no buffer engine could reach anyway. A buffer engine that
		// did reach "restart" would have its chunk torn down and re-read instead
		// of paused. tests/player.test.ts covers this: deleting the guard's
		// `return "element"` fails the element-pause delta assertions, because
		// tearDownCurrentChunk() pauses the element twice where the element route
		// pauses it once.
		return "restart";
	}

	/**
	 * Whether pausing is possible before any audio is sounding. It is for engines
	 * that hand back audio (the next utterance is held back); an engine that owns
	 * playback has nothing to hold, so its pause starts only once it is speaking.
	 */
	canPauseWhilePreparing(): boolean {
		return !(this.engine?.capabilities.ownsPlayback ?? false);
	}

	pause(): void {
		const owns = this.engine?.capabilities.ownsPlayback ?? false;
		// Nothing is sounding yet (the first sentence is still being made, or
		// synthesis has fallen behind): pausing holds the next audio back rather
		// than stopping anything.
		if (!owns && !this.audioActive && (this.state === "preparing" || this.state === "playing")) {
			this.holdStart = true;
			this.pausedVia = "element";
			this.setState("paused");
			return;
		}
		if (this.state !== "playing") return;
		const route = this.pauseRoute();

		if (route === "restart") {
			// Nothing in flight to stop, so there is nothing to come back to
			// either. Half a teardown would be worse than not pausing.
			if (!this.chunkScope) return;
			this.tearDownCurrentChunk();
		} else if (route === "engine") {
			this.engine?.pause?.();
		} else {
			this.audio.pause();
		}

		this.pausedVia = route;
		this.setState("paused");
	}

	async resume(): Promise<void> {
		if (this.state !== "paused") return;
		const route = this.pausedVia;
		// Paused without a recorded route means we did not pause it, so there
		// is nothing here to undo.
		if (!route) return;
		this.pausedVia = null;

		if (this.holdStart) {
			this.holdStart = false;
			// Resumed before the audio was ready: back to waiting for it.
			if (!this.heldForResume) {
				this.setState("preparing");
				return;
			}
			// The audio was ready and held: start it below, like any element resume.
			this.heldForResume = false;
			this.audioActive = true;
		}

		if (route === "restart") {
			// No priming step on this route, and that is not an omission. It is
			// only ever chosen for an engine that owns playback (pauseRoute),
			// which primeBuffer refuses outright, and restartCurrent re-enters
			// run(), whose loop primes every iteration. A Look ahead raise
			// stored while paused is therefore already accounted for twice
			// over; calling primeBuffer here would be dead code.
			await this.restartCurrent();
			return;
		}
		if (route === "engine") {
			this.engine?.resume?.();
			this.setState("playing");
			// Deliberately no tick(): a live result leaves `wordTimings` empty,
			// so the rAF loop would spin doing nothing. Words come from the
			// engine's own boundary events.
			//
			// No priming either, for the same reason as above plus one more:
			// pauseRoute only hands this route to an engine that owns playback
			// (an invariant it now enforces, not an observation about which
			// engines happen to be in the tree), and the run loop is still
			// parked inside the utterance it is holding, so it will prime for
			// itself when it advances.
			return;
		}

		// A real HTMLAudioElement resolves play() asynchronously, so a stop()
		// or a fresh play() can land before either callback runs. Everything
		// below belongs to the run that was paused: reviving its state is
		// wrong, and priming its buffer is worse, because stop() has already
		// cleared `pending`, called cancelPending() and nulled the controller,
		// so the work would be un-abortable and nobody would ever await it.
		const token = this.runToken;
		void this.audio
			.play()
			.then(() => {
				if (token !== this.runToken) return;
				this.setState("playing");
				// A Look ahead change made while paused was stored but not acted
				// on, because a paused player should not start work it may never
				// need. This is that moment.
				this.primeBuffer(this.currentUnitStart());
				this.tick();
			})
			.catch((err: unknown) => {
				// The same guard as the success path, for a sharper reason. A
				// rejection that arrives after this run was superseded belongs
				// to nobody: the error would be a notice about a reading the
				// user already walked away from, and stop() would tear down the
				// NEWER playback that replaced it - clearing its `pending`,
				// revoking its URLs and calling cancelPending() on its engine.
				// Staying silent loses nothing, because whoever started the
				// replacement owns its failures and nothing is awaiting this.
				if (token !== this.runToken) return;
				// Without this the player sat in "paused" forever with an
				// unhandled rejection and no way back. Emitted before stop() so
				// the notice is not racing the clear-on-idle. Giving the
				// position up rather than retrying is what every other playback
				// failure in this file does.
				this.emitter.emit(
					"error",
					err instanceof Error
						? new Error(`Could not resume audio playback: ${err.message}`)
						: new Error("Could not resume audio playback"),
				);
				this.stop();
			});
	}

	toggle(): void {
		if (this.state === "playing" || this.state === "preparing") this.pause();
		else if (this.state === "paused") void this.resume();
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
		this.audio.playbackRate = rate;
		if (rate === this.rate) return;
		this.rate = rate;
		this.emitter.emit("rate", rate);
	}

	getRate(): number {
		return this.rate;
	}

	/**
	 * Change the pitch immediately. Unlike rate, pitch only affects future
	 * synthesis, not audio that has already been produced.
	 */
	setPitch(pitch: number): void {
		if (pitch === this.pitch) return;
		this.pitch = pitch;
		this.emitter.emit("pitch", pitch);
	}

	getPitch(): number {
		return this.pitch;
	}

	/**
	 * Set a sleep timer that stops playback after the specified duration.
	 *
	 * When ms > 0, starts a countdown interval. When it reaches 0, calls expireTimer().
	 * When ms === 0, cancels any running timer.
	 */
	setTimer(ms: number): void {
		// Cancel existing timer
		if (this.timerInterval !== null) {
			window.clearInterval(this.timerInterval);
			this.timerInterval = null;
		}

		if (ms <= 0) {
			this.timerMs = 0;
			this.emitter.emit("timer", 0);
			return;
		}

		this.timerMs = ms;
		this.timerStartedAt = Date.now();
		this.emitter.emit("timer", ms);

		// Update countdown every 100ms
		this.timerInterval = window.setInterval(() => {
			const remaining = Math.max(0, this.timerStartedAt + this.timerMs - Date.now());
			this.emitter.emit("timer", remaining);

			if (remaining <= 0) {
				this.expireTimer();
			}
		}, 100);
	}

	getTimer(): number {
		if (this.timerMs <= 0) return 0;
		const remaining = Math.max(0, this.timerStartedAt + this.timerMs - Date.now());
		return remaining;
	}

	private expireTimer(): void {
		if (this.timerInterval !== null) {
			window.clearInterval(this.timerInterval);
			this.timerInterval = null;
		}
		this.timerMs = 0;
		this.emitter.emit("timer", 0);
		this.emitter.emit("timerExpired", undefined);
		// Stop playback at current chunk boundary
		if (this.state === "playing") {
			this.stop();
		}
	}

	/**
	 * Change how many chunks are synthesised ahead of the one playing.
	 *
	 * The Look ahead slider used to write only `settings.bufferAhead`, so the
	 * running player kept the value it read in its constructor and the control
	 * did nothing until the plugin was reloaded.
	 *
	 * Raising it fills the wider window at once while preparing or playing;
	 * while paused the value is stored and resume() fills it; while idle or
	 * finished the next play() picks it up through run()'s own priming.
	 *
	 * Lowering it is deliberately passive. `primeBuffer` only ever adds, and
	 * skips anything already in `pending`, so a smaller window stops further
	 * excess prefetch without aborting synthesis the session already shares, or
	 * disturbing the caches, the index or the rate.
	 *
	 * The value is validated here rather than trusted: this is the runtime
	 * authority and callers reach it from the settings tab, from plugin load,
	 * and from anywhere a future control is added.
	 */
	setBufferAhead(count: number): void {
		this.bufferAhead = normaliseBufferAhead(count);
		// Only a state where a queue is live can fill immediately. Anything
		// else has its own priming moment: resume(), or the next play().
		if (this.state === "preparing" || this.state === "playing") this.primeBuffer(this.currentUnitStart());
	}

	getBufferAhead(): number {
		return this.bufferAhead;
	}

	/**
	 * Hand the player a fresh extraction of the note being read, to take over
	 * when the utterance now playing ends.
	 *
	 * The note was edited, so the queue's text and offsets are stale and new
	 * sentences are missing. Swapping the queue mid-utterance would cut speech
	 * off or leave the sentence cursor pointing into the wrong array, so the
	 * swap waits for the boundary. `resume` is asked, with the last sentence of
	 * the utterance that just finished, which index of `chunks` to continue
	 * from. Returns false when nothing is being read, so there is nothing to
	 * replace.
	 */
	queueReplacement(chunks: SpeechChunk[], resume: (last: SpeechChunk) => number): boolean {
		if (this.state === "idle" || this.state === "finished") return false;
		this.replacement = { chunks, resume };
		return true;
	}

	/**
	 * Restart the current chunk from the beginning.
	 *
	 * The queue and the index are left alone, so the position readout does not
	 * move and earlier chunks stay reachable. Only the current chunk's scope is
	 * aborted: prefetched audio for later chunks is still valid, and on a
	 * buffer engine the current chunk's own audio is reused rather than
	 * synthesised again.
	 */
	async replayCurrent(): Promise<void> {
		if (this.state === "idle" || this.state === "finished") return;
		if (!this.engine || !this.controller) return;
		if (this.index < 0 || this.index >= this.chunks.length) return;
		await this.restartCurrent();
	}

	async next(): Promise<void> {
		if (this.state === "idle" || this.state === "finished") return;
		if (!this.engine || !this.controller) return;
		if (this.index >= this.chunks.length - 1) return; // At or past last chunk
		this.index += 1;
		await this.restartCurrent();
	}

	/** Jump to the chunk at `index` and speak it from its start. */
	async jumpTo(index: number): Promise<void> {
		if (this.state === "idle" || this.state === "finished") return;
		if (!this.engine || !this.controller) return;
		if (index < 0 || index >= this.chunks.length || index === this.index) return;
		this.index = index;
		await this.restartCurrent();
	}

	async previous(): Promise<void> {
		if (this.state === "idle" || this.state === "finished") return;
		if (!this.engine || !this.controller) return;
		if (this.index <= 0) return; // At or before first chunk
		this.index -= 1;
		await this.restartCurrent();
	}

	/**
	 * Cut the current chunk off and speak it again from its start.
	 *
	 * One body for two callers: replayCurrent(), and resume() on the
	 * stop-and-retain route, where the pause already did the teardown half and
	 * this does the rest. They must not drift: a replay and a resume-after-
	 * pause are the same act on an engine that cannot hold an utterance.
	 */
	private async restartCurrent(): Promise<void> {
		if (!this.engine || !this.controller) return;
		const index = this.index;

		this.tearDownCurrentChunk();

		this.setState("preparing");
		this.emitter.emit("progress", { chunkIndex: index, total: this.chunks.length });

		await this.startRun(this.runToken);
	}

	/**
	 * Abandon the utterance in flight while keeping the queue and the index.
	 *
	 * Bumping the token is load bearing, not bookkeeping. Without it the
	 * superseded run() iteration comes back from its await and runs
	 * `this.index = index + 1`, so a pause silently eats a sentence.
	 *
	 * The session controller is deliberately untouched. run() reads
	 * `this.controller?.signal` once on entry and returns if it is missing, so
	 * nulling it here would kill the run loop and leave a resume nothing to
	 * restart. Only stop() may do that. `engine.cancelPending()` is likewise
	 * not called: stop() discards queued work, a pause wants it kept.
	 */
	private tearDownCurrentChunk(): void {
		this.runToken += 1;
		this.holdStart = false;
		this.heldForResume = false;
		// Whatever was paused is gone now. pause() re-records the route after
		// calling this; a replay straight out of a pause must not leave the old
		// one behind for the next resume to act on.
		this.pausedVia = null;
		// NRL-41: on speechd this abort is what reaches the daemon with `-S`.
		// It cannot reach the one chunk already queued behind the spoken one,
		// so roughly 830 ms of audio plays on past a pause there (NRL-43).
		this.chunkScope?.abort();
		this.chunkScope = null;

		// On an engine that owns playback the cached promise is the utterance
		// that was just cut off, so it cannot be replayed; speak it again.
		if (this.engine?.capabilities.ownsPlayback) this.pending.delete(this.currentUnitStart());
		// The superseded run bailed out before revoking, and playBuffer is
		// about to register a fresh URL for this utterance.
		this.revokeUrl(this.currentUnitStart());
		this.clearWordState();
		this.emitter.emit("word", null);
		this.audio.pause();
	}

	stop(): void {
		this.runToken += 1;
		this.pausedVia = null;
		this.chunkScope?.abort();
		this.chunkScope = null;
		this.controller?.abort();
		this.controller = null;
		this.audio.pause();
		this.audio.removeAttribute("src");
		this.pending.clear();
		this.units.clear();
		this.unitStart = -1;
		this.replacement = null;
		this.holdStart = false;
		this.heldForResume = false;
		this.audioActive = false;
		this.clearGenerating();
		// Aborting our own promises does not reach an engine that keeps its own
		// work queue. Without this, restarting playback lands behind every
		// sentence the user already walked away from.
		this.engine?.cancelPending?.();
		for (const url of this.objectUrls.values()) URL.revokeObjectURL(url);
		this.objectUrls.clear();
		this.clearWordState();
		// Clear timer
		if (this.timerInterval !== null) {
			window.clearInterval(this.timerInterval);
			this.timerInterval = null;
		}
		this.timerMs = 0;
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

interface LinkedScope {
	readonly signal: AbortSignal;
	abort(): void;
	/** Detach from the parent once the scope is finished with. */
	release(): void;
}

/**
 * An abort scope that also aborts when `parent` does.
 *
 * Not AbortSignal.any: that is missing from the older mobile WebViews this
 * plugin still runs in. The parent is the session signal, which outlives
 * hundreds of chunks, so each scope removes its listener when released rather
 * than piling them up.
 */
function linkedScope(parent: AbortSignal): LinkedScope {
	const controller = new AbortController();
	const onParentAbort = (): void => controller.abort();
	if (parent.aborted) controller.abort();
	else parent.addEventListener("abort", onParentAbort, { once: true });
	const release = (): void => parent.removeEventListener("abort", onParentAbort);
	return {
		signal: controller.signal,
		abort: () => {
			release();
			controller.abort();
		},
		release,
	};
}

/**
 * Join consecutive sentences into one chunk to submit as a single utterance.
 *
 * The offset map gets an entry for the joining space too, or every position
 * after the join would shift by one and word highlights would land mid-word
 * (the same rule `mergeShort` follows in extract.ts).
 */
function joinChunks(parts: SpeechChunk[]): SpeechChunk {
	const first = parts[0]!;
	const last = parts[parts.length - 1]!;
	let text = first.text;
	const sourceIndex = [...first.sourceIndex];
	for (let i = 1; i < parts.length; i++) {
		const prev = parts[i - 1]!;
		const part = parts[i]!;
		const firstOfPart = part.sourceIndex[0] ?? part.sourceStart;
		sourceIndex.push(firstOfPart > 0 ? firstOfPart - 1 : prev.sourceEnd);
		sourceIndex.push(...part.sourceIndex);
		text = `${text} ${part.text}`;
	}
	return { ...first, text, sourceIndex, sourceStart: first.sourceStart, sourceEnd: last.sourceEnd };
}
