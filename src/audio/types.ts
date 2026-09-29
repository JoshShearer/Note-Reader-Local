/**
 * Core contracts for speech synthesis.
 *
 * The central idea: a `SpeechEngine` turns a chunk of text into audio plus
 * word-level timings. Timings are what make highlighting possible, and how
 * trustworthy they are varies wildly by engine, so every engine declares its
 * precision up front via `EngineCapabilities.timing`.
 */

export type EngineId = "kokoro" | "espeak" | "speechd" | "webspeech";

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
	 * A pause that actually stops the sound.
	 *
	 * Deliberately not derived from `ownsPlayback`, even though the two are
	 * exact opposites today. The player pauses its own `<audio>` element, which
	 * only ever holds a `kind: "buffer"` result, so an engine that streams or
	 * speaks live is unpausable *as currently driven* - not necessarily
	 * unpausable in principle. speechSynthesis has pause()/resume(); the plugin
	 * simply never calls them. Keeping this its own field means making that
	 * work flips one boolean and does not touch rate routing.
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

/** A unit of text handed to an engine as a single utterance. */
export interface SpeechChunk {
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
	isAvailable(): Promise<boolean>;
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
