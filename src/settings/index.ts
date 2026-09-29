import type { EngineSelection } from "../engines/selection";
import { isStorableColour } from "../ui/highlightColour";

export interface Settings {
	/**
	 * Which engine produces audio, or "auto" to let the plugin pick by
	 * confirmed quality (docs/adr/0010). "auto" is resolved to a concrete
	 * EngineId in exactly two places, both in main.ts: `activeEngine()`
	 * (sync, cached) and `rankedCandidates()`/`resolveAutomaticChoice()`
	 * (async, authoritative). Nothing outside main.ts and settingsTab.ts
	 * ever sees `"auto"`.
	 */
	engine: EngineSelection;
	/** Voice id, scoped to the engine (`espeak:en-us`, `kokoro:af_heart`). */
	voiceId: string;
	/** Playback rate multiplier. */
	rate: number;
	/** Pitch offset, -50..50. */
	pitch: number;

	highlight: {
		enabled: boolean;
		/**
		 * Hex colour for the active word, or "" to follow the theme
		 * (--text-highlight-bg). See docs/adr/0005.
		 */
		color: string;
	};

	/*
	 * Content exclusions. The names follow srs.md R-M13, which mixes polarity:
	 * `skipX` for content read by default, `speakX` for content dropped by
	 * default. See docs/adr/0001 for why the mix is kept rather than
	 * normalised.
	 *
	 * All nine content keys are read by `extractChunks` and have their own
	 * toggle as of NRL-21 (docs/adr/0008). `offlinePreferred` is the one key
	 * still reserved: stored and migrated, but not yet read by anything and so
	 * deliberately without a toggle. A toggle appears when its behaviour does,
	 * never before.
	 */
	/** Skip fenced and indented code blocks. */
	skipCodeBlocks: boolean;
	/** Skip `inline code`. Its own toggle since NRL-21. */
	skipInlineCode: boolean;
	/** Read bare URLs aloud. Link labels are read regardless. */
	speakUrls: boolean;
	skipTags: boolean;
	skipTables: boolean;
	skipHeadings: boolean;
	/** Skip the YAML properties block (docs/adr/0002 decides what one is). */
	skipFrontmatter: boolean;
	/** Read an image's alt text. Its destination is never read. */
	speakImageAlt: boolean;
	/** Read an `![[embed]]` as a label for its local reference, not its target file. */
	speakEmbeds: boolean;
	/** Prefer voices that need no download. Reserved for voice metadata. */
	offlinePreferred: boolean;

	/** Sentences synthesised ahead of the one being spoken. */
	bufferAhead: number;
	/** Path to the Kokoro model directory, relative to the vault root. */
	kokoroModelPath: string;
	/**
	 * Which backend Kokoro should ask for.
	 *
	 * `auto` takes the GPU when there is a real adapter behind `navigator.gpu`
	 * and the CPU otherwise. The explicit values exist because "the GPU is
	 * present" and "the GPU is faster here" are different questions, and only
	 * the user can settle the second one on their own hardware.
	 */
	kokoroDevice: "auto" | "wasm" | "webgpu";
	/**
	 * Upper bound on CPU threads for Kokoro.
	 *
	 * Only an upper bound: onnxruntime spawns its thread pool from inside our
	 * worker, and some runtimes refuse to nest workers, in which case the
	 * engine falls back to one thread and says so in the settings tab.
	 */
	kokoroThreads: number;
	/**
	 * Which Kokoro weights build to use.
	 *
	 * `auto` means the fast build on desktop and the small one on mobile,
	 * which is where the trade actually differs: a phone cares about 60MB of
	 * download and a memory ceiling, a desktop cares about keeping up with
	 * playback.
	 */
	kokoroWeights: "auto" | "gpu" | "fast" | "small";
}

export const DEFAULT_SETTINGS: Settings = {
	// A deliberate first-run behaviour change (docs/adr/0010), the same shape
	// as speakImageAlt's default flip in NRL-21/ADR 0008: anyone who has
	// genuinely never touched the engine dropdown now gets Automatic instead
	// of a doomed default of unavailable Kokoro on a fresh install.
	engine: "auto",
	voiceId: "kokoro:af_heart",
	rate: 1,
	pitch: 0,
	highlight: {
		enabled: true,
		// Follow the theme: one fixed hex cannot suit light and dark themes.
		color: "",
	},
	// The first six reproduce what the pre-v1 defaults did, so nobody's reading
	// changes on upgrade. The rest take their srs.md R-M09 defaults. One of
	// those, speakImageAlt, is now read by extraction and so does change what an
	// existing user hears: that is deliberate, and docs/adr/0008 records why.
	skipCodeBlocks: true,
	skipInlineCode: true,
	speakUrls: false,
	skipTags: true,
	skipTables: true,
	skipHeadings: false,
	skipFrontmatter: true,
	speakImageAlt: true,
	speakEmbeds: false,
	offlinePreferred: false,
	bufferAhead: 2,
	// Kept outside the plugin folder so a plugin update does not discard the
	// downloaded weights. Hidden from the file tree so 90MB of blobs does not
	// clutter the vault.
	kokoroModelPath: ".obsidian/local-tts/kokoro",
	kokoroDevice: "auto",
	// Four is a deliberate default rather than "all cores": Kokoro stops
	// scaling well before that, and the rest of the machine still has to feel
	// responsive while a note is being read.
	kokoroThreads: 4,
	kokoroWeights: "auto",
};

const RATE_MIN = 0.5;
const RATE_MAX = 2;

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, n));
}

function bool(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

/**
 * Every value `Settings.engine` is allowed to hold.
 *
 * Kept in sync with `EngineId` by hand rather than derived, the same as the
 * kokoroDevice/kokoroWeights checks below: there is no runtime list of
 * `EngineId`'s members to iterate, since it is a type, not a value.
 */
const VALID_ENGINE_SELECTIONS: EngineSelection[] = ["auto", "kokoro", "espeak", "speechd", "webspeech"];

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merge stored settings over defaults.
 *
 * Obsidian hands back whatever was last written, which may predate a field or
 * come from a hand-edited file, so every known key is validated rather than
 * trusted.
 *
 * Keys this version does not recognise are carried through untouched. The
 * result is what gets saved, so a whitelist rebuild here would erase anything
 * a newer version (or another part of the plugin) stored, on the next rate
 * nudge.
 */
export function normaliseSettings(raw: unknown): Settings {
	const data = (isRecord(raw) ? raw : {}) as Partial<Settings> & Record<string, unknown>;
	const highlight = (isRecord(data.highlight) ? data.highlight : {}) as Partial<
		Settings["highlight"]
	> &
		Record<string, unknown>;

	return {
		...data,
		// Previously an unvalidated cast that let anything through data.json
		// masquerade as an EngineId. Now validated the same way as
		// kokoroDevice/kokoroWeights below - and a manual pin a user actually
		// saved (e.g. "kokoro") is one of these valid values, so it round-trips
		// unchanged rather than being coerced to "auto" (non-negotiable 10).
		engine: VALID_ENGINE_SELECTIONS.includes(data.engine as EngineSelection)
			? (data.engine as EngineSelection)
			: DEFAULT_SETTINGS.engine,
		voiceId: typeof data.voiceId === "string" ? data.voiceId : DEFAULT_SETTINGS.voiceId,
		rate: clampNumber(data.rate, RATE_MIN, RATE_MAX, DEFAULT_SETTINGS.rate),
		pitch: clampNumber(data.pitch, -50, 50, DEFAULT_SETTINGS.pitch),
		highlight: {
			...highlight,
			enabled: bool(highlight.enabled, DEFAULT_SETTINGS.highlight.enabled),
			color: isStorableColour(highlight.color) ? highlight.color : DEFAULT_SETTINGS.highlight.color,
		},
		skipCodeBlocks: bool(data.skipCodeBlocks, DEFAULT_SETTINGS.skipCodeBlocks),
		skipInlineCode: bool(data.skipInlineCode, DEFAULT_SETTINGS.skipInlineCode),
		speakUrls: bool(data.speakUrls, DEFAULT_SETTINGS.speakUrls),
		skipTags: bool(data.skipTags, DEFAULT_SETTINGS.skipTags),
		skipTables: bool(data.skipTables, DEFAULT_SETTINGS.skipTables),
		skipHeadings: bool(data.skipHeadings, DEFAULT_SETTINGS.skipHeadings),
		skipFrontmatter: bool(data.skipFrontmatter, DEFAULT_SETTINGS.skipFrontmatter),
		speakImageAlt: bool(data.speakImageAlt, DEFAULT_SETTINGS.speakImageAlt),
		speakEmbeds: bool(data.speakEmbeds, DEFAULT_SETTINGS.speakEmbeds),
		offlinePreferred: bool(data.offlinePreferred, DEFAULT_SETTINGS.offlinePreferred),
		bufferAhead: Math.round(
			clampNumber(data.bufferAhead, 0, 8, DEFAULT_SETTINGS.bufferAhead),
		),
		kokoroModelPath:
			typeof data.kokoroModelPath === "string" && data.kokoroModelPath.length > 0
				? data.kokoroModelPath
				: DEFAULT_SETTINGS.kokoroModelPath,
		kokoroDevice:
			data.kokoroDevice === "wasm" || data.kokoroDevice === "webgpu"
				? data.kokoroDevice
				: DEFAULT_SETTINGS.kokoroDevice,
		kokoroThreads: Math.round(
			clampNumber(data.kokoroThreads, 1, 16, DEFAULT_SETTINGS.kokoroThreads),
		),
		kokoroWeights:
			data.kokoroWeights === "fast" ||
			data.kokoroWeights === "small" ||
			data.kokoroWeights === "gpu"
				? data.kokoroWeights
				: DEFAULT_SETTINGS.kokoroWeights,
	};
}
