/**
 * Core contracts for speech synthesis.
 *
 * The central idea: a `SpeechEngine` turns a chunk of text into audio plus
 * word-level timings. Timings are what make highlighting possible, and how
 * trustworthy they are varies wildly by engine, so every engine declares its
 * precision up front via `EngineCapabilities.timing`.
 */

export type EngineId = "kokoro" | "espeak" | "speechd" | "webspeech";

/**
 * The result of `SpeechEngine.isAvailable()`.
 *
 * A discriminated union rather than a bare boolean, so a reason can never be
 * read without first narrowing `available` to `false`, and never disagree
 * with the boolean it accompanies (NRL-25's clarification).
 */
export type EngineAvailability = { available: true } | { available: false; reason: string };

/**
 * Joins an `EngineAvailability` reason with a generic next step for the
 * user, guaranteeing exactly one sentence break between them.
 *
 * Most reasons are fixed strings that already end in a period, but the
 * catch-all branch in every engine's `isAvailable()` interpolates a caught
 * error's `.message`, which usually does not. Concatenating that directly
 * against a following sentence reads as a run-on ("...vault adapter Pick
 * another engine in settings."), which undercuts the whole point of this
 * ticket: the message has to be genuinely readable, not just non-generic.
 *
 * Pure and exported so it can be unit tested: `main.ts`, the only caller,
 * imports `obsidian` at module scope and cannot be bundled in bare Node,
 * the same structural blocker documented for `registry.ts`.
 */
export function describeUnavailable(reason: string, nextStep: string): string {
	const trimmed = reason.trim();
	const punctuated = /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
	return `${punctuated} ${nextStep}`;
}

export type TimingPrecision =
	/** Engine reports exact word ranges (e.g. Android onRangeStart). */
	| "native"
	/** We synthesised to a file and know its real duration. */
	| "measured"
	/** Duration is divided across words by weight. Approximate. */
	| "estimated"
	/** No timing available at all; highlighting must be disabled. */
	| "none";

export interface EngineCapabilities {
	/** Engine can enumerate its voices at runtime. */
	voices: boolean;
	/** How word timings are derived. */
	timing: TimingPrecision;
	/** Honours a playback rate multiplier. */
	rate: boolean;
	/** Honours a pitch adjustment. */
	pitch: boolean;
	/** Requires a local binary or daemon, so unavailable on mobile. */
	desktopOnly: boolean;
	/**
	 * The player can stop this engine's sound and come back to it, by whatever
	 * route suits the engine.
	 *
	 * Deliberately not derived from `ownsPlayback`. The two were exact
	 * opposites until NRL-23 and are not any more: speechd and webspeech both
	 * own playback and both are now pausable. What differs between engines is
	 * the *granularity* a resume comes back at, not whether the sound stops:
	 * a buffer engine and webspeech resume mid-utterance, while speechd stops
	 * the sentence and re-reads it from the start (srs.md:250). Anything that
	 * needs to know which, asks the player, not this field.
	 */
	pause: boolean;
	/** Can come back from a pause. Nothing should offer one without the other. */
	resume: boolean;
	/** Engine reports where each sentence starts, not just each word. */
	sentenceBoundary: boolean;
	/** Engine can say whether a given voice needs the network to speak. */
	offlineStatus: boolean;
	/**
	 * The engine makes the sound itself, rather than handing back audio.
	 *
	 * This decides who applies the speed setting. An engine that owns playback
	 * has to be told the rate, because nothing downstream can change it after
	 * the fact. An engine that returns a buffer must render at natural speed
	 * and leave the rate to the player, or the two multiply: asking espeak for
	 * 1.5x words-per-minute and then playing that audio back at 1.5x is 2.25x,
	 * which is what used to happen.
	 */
	ownsPlayback: boolean;
}

export interface VoiceInfo {
	/** Stable within its engine. */
	id: string;
	name: string;
	/** BCP-47 tag, best effort. */
	lang: string;
	gender: "male" | "female" | "neutral";
	engineId: EngineId;
	/**
	 * A modified form of a base voice, e.g. one of speech-dispatcher's
	 * espeak-ng variants. Used to prefer the plain voice when choosing a
	 * default, since the variants are thousands of novelty timbres.
	 */
	isVariant?: boolean;
	/**
	 * Whether this specific voice runs on-device. Independent of
	 * `requiresNetwork`, not derived from it - a backend can in principle know
	 * one without the other, so both are reported separately (srs.md's
	 * TTSVoice shape). `"unknown"` when the backend cannot determine this;
	 * per R-S01 that must never be coerced to `true` or `false`.
	 */
	local: boolean | "unknown";
	/**
	 * Whether speaking this voice needs the network. See `local` above for
	 * why this is a separate, required field rather than `!local`.
	 */
	requiresNetwork: boolean | "unknown";
}

/**
 * One word, located in both the spoken text and the original markdown, and
 * placed in time.
 *
 * `start`/`end` index into the chunk's `text`. `sourceStart`/`sourceEnd` index
 * into the raw note, so highlighting survives markdown stripping.
 * `offsetMs` is measured from the start of the chunk's audio.
 */
export interface WordTiming {
	start: number;
	end: number;
	sourceStart: number;
	sourceEnd: number;
	offsetMs: number;
	/** Zero means "until the next word begins". */
	durationMs: number;
}

/**
 * One word located in a chunk's spoken text.
 *
 * `start`/`end` are UTF-16 code-unit indices into `SpeechChunk.text`, the same
 * units as `SpeechChunk.sourceIndex`, so `allocateWordTimings` can read a raw
 * offset straight out of that array (non-negotiable 8).
 *
 * It lives here rather than in words.ts because `SpeechChunk` carries it, and a
 * chunk must not have to import the timing code to describe itself.
 */
export interface WordSpan {
	word: string;
	start: number;
	end: number;
}

export type BlockType = "heading" | "paragraph" | "list" | "quote" | "other";

/** A unit of text handed to an engine as a single utterance. */
export interface SpeechChunk {
	/** Stable unique identifier for this segment. */
	id: string;
	/** Ordinal position in the document's sequence. */
	sequence: number;
	/** Block type from the source markdown. */
	blockType: BlockType;
	/** Vault-relative path to the note this chunk came from. */
	filePath: string;
	/** Speakable text, already stripped of markdown. */
	text: string;
	/**
	 * Per-character map back into the raw note. `sourceIndex[i]` is the offset
	 * in the note that produced `text[i]`. Stripping inline syntax shifts
	 * positions, so this cannot be reconstructed from a single start offset.
	 */
	sourceIndex: number[];
	/** Offset of `text` within the note's raw markdown. */
	sourceStart: number;
	/** End offset (exclusive) within the note's raw markdown. */
	sourceEnd: number;
	/**
	 * Word spans already computed with a segmenter. Absent means the regex in
	 * `findWords` is the whole rule for this chunk, which is the case for every
	 * chunk holding no Han, Kana or Hangul and for every chunk at all when the
	 * platform has no `Intl.Segmenter` (ADR 0014).
	 *
	 * Anything that re-slices `text` must re-slice this too or drop it, or the
	 * spans index into text that no longer exists - see `clipWordSpans`.
	 */
	wordSpans?: WordSpan[];
}

export interface SynthRequest {
	chunk: SpeechChunk;
	/** Playback rate multiplier, 1 = natural. */
	rate: number;
	/** Pitch offset in the engine's own units. */
	pitch: number;
	/**
	 * Called as words are spoken. Only used by engines that own playback and
	 * get real boundary events; buffer engines report words in their result.
	 */
	onWord?: (timing: WordTiming) => void;
	/** Called once the utterance is fully finished. */
	onEnd?: () => void;
}

export type SynthResult =
	| {
			kind: "buffer";
			audio: ArrayBuffer;
			sampleRate: number;
			durationMs: number;
			/** Per-word offsets, relative to `chunk.text`. */
			words: WordTiming[];
	  }
	| {
			/**
			 * Engine streamed straight to the audio device and gave us nothing
			 * back. `estimatedMs` is only used to pace the sentence queue.
			 */
			kind: "streamed";
			estimatedMs: number;
			words: null;
	  }
	| {
			/**
			 * Engine owns playback and reports words through `onWord` as they
			 * are spoken. The returned promise settles when it is finished.
			 */
			kind: "live";
			words: null;
	  };

export interface SpeechEngine {
	readonly id: EngineId;
	readonly label: string;
	readonly capabilities: EngineCapabilities;

	/** Cheap probe: is the backing binary, daemon or model present? */
	isAvailable(): Promise<EngineAvailability>;
	listVoices(): Promise<VoiceInfo[]>;
	selectVoice(voice: VoiceInfo): Promise<void>;
	synthesize(req: SynthRequest, signal: AbortSignal): Promise<SynthResult>;
	dispose(): Promise<void>;

	/**
	 * Load whatever is expensive to load, ahead of being asked to speak.
	 *
	 * Optional because most engines have nothing to prepare: a subprocess or
	 * the system voice list is ready the moment it is needed. Kokoro is the
	 * exception, and the difference between loading it on the first click and
	 * loading it in the background is the difference between a plugin that
	 * looks broken and one that does not. Safe to call repeatedly.
	 */
	prepare?(): Promise<void>;
	/** True once `prepare()` has finished, so callers can skip the wait UI. */
	isPrepared?(): boolean;
	/**
	 * Abandon work that was queued but is no longer wanted.
	 *
	 * Aborting the caller's promise is not enough for engines with a work
	 * queue of their own: the queue keeps grinding through dead requests and
	 * delays whatever the user asked for instead.
	 */
	cancelPending?(): void;
	/**
	 * Hold the current utterance without discarding it, and let it go on.
	 *
	 * Only meaningful for an engine that owns playback, and the player enforces
	 * that rather than trusting it: `pauseRoute` tests `ownsPlayback` first, so a
	 * buffer engine that declares either of these still takes the element route,
	 * the declaration is reported as a programming error, and neither method is
	 * ever called. A buffer engine's sound lives in the player's own `<audio>`
	 * element, where `engine.pause()` could not reach it anyway.
	 *
	 * On an engine that owns playback they are A PAIR. Implementing one without
	 * the other is a programming error, not an engine with half a pause: the
	 * player refuses the pair outright, reports it, and falls back to stopping
	 * the utterance. A pause there is no way back from is the defect this exists
	 * to remove. An engine that owns playback and implements neither is not
	 * thereby unpausable: it gets the player's stop-and-retain fallback
	 * (srs.md:277), which is exactly what speechd relies on.
	 *
	 * Synchronous, idempotent, and must not throw.
	 */
	pause?(): void;
	resume?(): void;
	/**
	 * Map a stored voice id that no longer matches exactly onto the voice it
	 * meant, when the engine changed its id format. Returns undefined when the
	 * voice is genuinely gone; the caller decides what to substitute.
	 */
	resolveVoiceId?(storedId: string, voices: VoiceInfo[]): VoiceInfo | undefined;
	/** What the engine actually ended up running on, for the settings UI. */
	runtimeInfo?(): string | null;
}

/** Thrown when an engine is asked to speak before it is ready. */
export class EngineUnavailableError extends Error {
	constructor(
		public readonly engineId: EngineId,
		reason: string,
	) {
		super(reason);
		this.name = "EngineUnavailableError";
	}
}
