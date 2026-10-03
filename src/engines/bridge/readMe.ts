import { parseWav } from "../../audio/wav";
import {
	EngineUnavailableError,
	type EngineAvailability,
	type EngineCapabilities,
	type SpeechEngine,
	type SynthRequest,
	type SynthResult,
	type VoiceInfo,
} from "../../audio/types";

/**
 * The Read Me Offline bridge engine (NRL-130, docs/adr/0036).
 *
 * Obsidian's Android WebView gives a plugin no route to the phone's speech
 * engine (NRL-35), and Kokoro cannot keep up there (or cannot start at all,
 * on a WebView without WASM SIMD). Read Me Offline is a separate Android app
 * that serves the phone's own `TextToSpeech` over a loopback HTTP bridge; this
 * engine is the plugin side of that contract. The contract itself is owned by
 * the Read Me repo (its srs.md, "Bridge contract (v1)").
 *
 * No obsidian import, so the bare-Node suite can drive the real class against
 * a fake transport. main.ts supplies the configuration and the transport.
 */

/**
 * The only host this engine ever talks to.
 *
 * A constant rather than a setting, deliberately: the bridge binds the IPv4
 * loopback explicitly, and a configurable host would turn a loopback engine
 * into a way to send note text anywhere (non-negotiable 4). Only the port is
 * the user's to change. Not `localhost`, which Java resolves to `127.0.0.1`
 * but which is one more resolution step for no benefit, and not `[::1]`,
 * which the bridge does not listen on (NRL-130 critique, 2026-10-01).
 */
export const BRIDGE_HOST = "127.0.0.1";
export const DEFAULT_BRIDGE_PORT = 8787;

/** The contract version this engine speaks. `/health` must report exactly this. */
export const BRIDGE_CONTRACT_VERSION = 1;

/**
 * How long availability waits for `/health`.
 *
 * Automatic selection probes every engine before a read starts, so this bounds
 * how long a missing bridge can delay the first sound. A loopback round trip
 * that has not answered in this long is not going to.
 */
export const HEALTH_TIMEOUT_MS = 1500;

/**
 * How long one synthesis may take before it is given up on.
 *
 * Generous on purpose: the bridge's own limit is 120 s (its ADR 0008), and a
 * chunk is at most 220 characters, which synthesizes in well under a second on
 * the measured engines. This exists so a wedged bridge fails the read rather
 * than leaving it in `preparing` forever.
 */
export const SYNTH_TIMEOUT_MS = 30_000;

/** Where to send someone who does not have the companion app. Text only; never fetched. */
export const READ_ME_URL = "https://github.com/JoshShearer/Read-Me";

export interface BridgeConfig {
	port: number;
	/** The pairing token from Read Me's Settings, or "" when none is set. */
	token: string;
}

export interface BridgeResponse {
	status: number;
	header(name: string): string | null;
	body: ArrayBuffer;
}

export interface BridgeRequest {
	method: "GET" | "POST";
	url: string;
	headers: Record<string, string>;
	body?: string;
	timeoutMs: number;
	signal?: AbortSignal;
}

/**
 * The HTTP hop, injectable so the suite needs no socket.
 *
 * Rejects only when no response arrived at all (refused, timed out, aborted).
 * Any HTTP status, error statuses included, resolves.
 */
export type BridgeTransport = (req: BridgeRequest) => Promise<BridgeResponse>;

/** What `/health` reported, kept for the settings UI and the size check. */
export interface BridgeHealth {
	ok: boolean;
	version: number;
	ttsReady: boolean;
	engine: string;
	voice: string;
	busy: boolean;
	maxChars: number | null;
}

/**
 * The default transport: `fetch` with an abort-driven timeout.
 *
 * `fetch` rather than `CapacitorHttp`: Read Me answers the CORS preflight and
 * puts `Access-Control-Allow-Origin: http://localhost` on every response,
 * errors included (its R-M12), so a WebView `fetch` can read status and
 * headers. That is a claim about the other app, which is why NRL-130 requires
 * it measured on a device rather than assumed.
 */
export const fetchTransport: BridgeTransport = async (req) => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), req.timeoutMs);
	const onAbort = (): void => controller.abort();
	req.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const res = await fetch(req.url, {
			method: req.method,
			headers: req.headers,
			body: req.body,
			signal: controller.signal,
			// No cookies, no cache: nothing about a loopback call should
			// persist anywhere, and a cached /health would lie.
			credentials: "omit",
			cache: "no-store",
		});
		const body = await res.arrayBuffer();
		return { status: res.status, header: (name) => res.headers.get(name), body };
	} finally {
		clearTimeout(timer);
		req.signal?.removeEventListener("abort", onAbort);
	}
};

function validPort(port: number): boolean {
	return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function decodeJson(body: ArrayBuffer): unknown {
	try {
		return JSON.parse(new TextDecoder().decode(body)) as unknown;
	} catch {
		return null;
	}
}

/** A string field of a bridge JSON error body, or "" when there is none. */
function errorField(body: ArrayBuffer, field: "error" | "reason"): string {
	const parsed = decodeJson(body);
	if (typeof parsed === "object" && parsed !== null && field in parsed) {
		const value = (parsed as Record<string, unknown>)[field];
		return typeof value === "string" ? value : "";
	}
	return "";
}

export function parseHealth(body: ArrayBuffer): BridgeHealth | null {
	const raw = decodeJson(body);
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.ok !== "boolean" || typeof r.version !== "number") return null;
	return {
		ok: r.ok,
		version: r.version,
		ttsReady: r.ttsReady === true,
		engine: typeof r.engine === "string" ? r.engine : "",
		voice: typeof r.voice === "string" ? r.voice : "",
		busy: r.busy === true,
		maxChars: typeof r.maxChars === "number" && r.maxChars > 0 ? r.maxChars : null,
	};
}

/**
 * Read Me Offline is reading aloud itself, so its bridge answered `503 busy`
 * (its ADR 0004: two speech jobs on one engine serialize). Ends the read
 * rather than falling back: the user pauses Read Me and reads again
 * (`stopsFallback` in src/audio/fallback.ts).
 */
export class BridgeBusyError extends EngineUnavailableError {
	readonly noFallback = true;
	constructor() {
		super("readme", "Read Me Offline is reading aloud itself. Pause it there, then read the note again.");
		this.name = "BridgeBusyError";
	}
}

const NOT_RUNNING =
	`Read Me Offline's Obsidian bridge is not running. Install Read Me Offline (${READ_ME_URL}) ` +
	"and turn on its Obsidian bridge in its Settings.";

export class ReadMeBridgeEngine implements SpeechEngine {
	readonly id = "readme" as const;
	readonly label = "Read Me Offline (Android voices)";
	readonly capabilities: EngineCapabilities = {
		// The voice is chosen in Read Me (its R-S01), not per request.
		voices: false,
		// The bridge promises no word timings; the sentence layer and the
		// NRL-72 scroll still work (highlight.ts disables the word row only).
		timing: "none",
		// Honoured by the PLAYER, not the bridge: this is a buffer engine, so
		// it renders at 1.0 and the player applies the speed (non-negotiable 9).
		rate: true,
		pitch: false,
		desktopOnly: false,
		// Buffer engine: pause and resume are the player's audio element.
		pause: true,
		resume: true,
		sentenceBoundary: false,
		offlineStatus: false,
		// Returns a WAV. `ownsPlayback: true` with a buffer is the combination
		// that shipped 2.25x once.
		ownsPlayback: false,
	};

	private health: BridgeHealth | null = null;

	/**
	 * Settles when the previous request to /synthesize has settled.
	 *
	 * The bridge synthesizes one request at a time and admits only a short
	 * queue behind it, answering the rest `503 {"error":"busy","reason":"queue"}`.
	 * The player prefetches `bufferAhead` chunks in parallel, so without this a
	 * read on the MatePad sent 8 requests at once and 5 were refused (measured
	 * 2026-10-03 in Read Me's own request log). Serializing here costs nothing,
	 * since the bridge would serialize them anyway.
	 */
	private queue: Promise<void> = Promise.resolve();

	constructor(
		private readonly config: () => BridgeConfig,
		private readonly transport: BridgeTransport = fetchTransport,
	) {}

	private baseUrl(): string | null {
		const { port } = this.config();
		return validPort(port) ? `http://${BRIDGE_HOST}:${port}` : null;
	}

	/** The last `/health` answer, for the settings UI. Null until one succeeds. */
	lastHealth(): BridgeHealth | null {
		return this.health;
	}

	/**
	 * Ask `/health`, bounded by HEALTH_TIMEOUT_MS. Never throws.
	 *
	 * Re-asked on every call rather than cached: whether the bridge runs is
	 * the user's switch in another app and can change at any moment, and the
	 * probe costs one loopback round trip.
	 */
	async isAvailable(): Promise<EngineAvailability> {
		const base = this.baseUrl();
		if (!base) return { available: false, reason: "The Read Me bridge port is not a valid port number." };
		let res: BridgeResponse;
		try {
			res = await this.transport({
				method: "GET",
				url: `${base}/health`,
				headers: {},
				timeoutMs: HEALTH_TIMEOUT_MS,
			});
		} catch {
			this.health = null;
			return { available: false, reason: NOT_RUNNING };
		}
		const health = res.status === 200 ? parseHealth(res.body) : null;
		this.health = health;
		if (!health) {
			return {
				available: false,
				reason: `Something answered on port ${this.config().port}, but it is not Read Me Offline's bridge.`,
			};
		}
		if (health.version !== BRIDGE_CONTRACT_VERSION) {
			return {
				available: false,
				reason: `Read Me Offline speaks bridge version ${health.version}; this plugin needs version ${BRIDGE_CONTRACT_VERSION}. Update whichever is older.`,
			};
		}
		if (!health.ok || !health.ttsReady) {
			return { available: false, reason: "Read Me Offline is running, but its speech engine is not ready yet." };
		}
		// Checked last, so a missing token is only reported once the bridge is
		// known to be there: "turn the bridge on" is the more useful first step.
		if (this.config().token.trim() === "") {
			return {
				available: false,
				reason: "Paste the pairing token from Read Me Offline's Settings into this plugin's settings.",
			};
		}
		return { available: true };
	}

	async listVoices(): Promise<VoiceInfo[]> {
		const voice = this.health?.voice;
		if (!voice) return [];
		return [
			{
				id: `readme:${voice}`,
				name: voice,
				lang: "",
				gender: "neutral",
				engineId: "readme",
				// Read Me filters network voices (its R-M06); this plugin only
				// displays what /health reports and does not vouch for it, so
				// neither field is coerced (R-S01).
				local: "unknown",
				requiresNetwork: "unknown",
			},
		];
	}

	/** The voice is Read Me's setting; there is nothing to select from here. */
	async selectVoice(): Promise<void> {}

	async synthesize(req: SynthRequest, signal: AbortSignal): Promise<SynthResult> {
		const previous = this.queue;
		let release!: () => void;
		this.queue = new Promise<void>((resolve) => (release = resolve));
		try {
			await previous;
			if (signal.aborted) throw new DOMException("Aborted", "AbortError");
			return await this.synthesizeOne(req, signal);
		} finally {
			release();
		}
	}

	private async synthesizeOne(req: SynthRequest, signal: AbortSignal): Promise<SynthResult> {
		const base = this.baseUrl();
		if (!base) throw new EngineUnavailableError("readme", "The Read Me bridge port is not a valid port number.");
		const { token } = this.config();
		if (token.trim() === "") {
			throw new EngineUnavailableError(
				"readme",
				"Paste the pairing token from Read Me Offline's Settings into this plugin's settings.",
			);
		}

		// `rate=1.0` always, whatever `req.rate` says: the player applies the
		// user's speed to the returned buffer, and asking the bridge for it too
		// would multiply the two (Read Me's bridge contract; non-negotiable 9).
		// The text goes in the body and never the URL, where it would land in
		// logs the way argv lands in `ps` (non-negotiable 2's reasoning).
		let res: BridgeResponse;
		try {
			res = await this.transport({
				method: "POST",
				url: `${base}/synthesize?rate=1.0`,
				headers: {
					Authorization: `Bearer ${token.trim()}`,
					"Content-Type": "text/plain; charset=utf-8",
				},
				body: req.chunk.text,
				timeoutMs: SYNTH_TIMEOUT_MS,
				signal,
			});
		} catch {
			if (signal.aborted) throw new DOMException("Aborted", "AbortError");
			throw new EngineUnavailableError("readme", NOT_RUNNING);
		}

		if (res.status === 200) {
			const info = parseWav(res.body);
			return {
				kind: "buffer",
				audio: res.body,
				sampleRate: info.sampleRate,
				durationMs: info.durationMs,
				words: [],
			};
		}
		throw this.failure(res);
	}

	/**
	 * An error a user can act on, for each status the contract defines.
	 *
	 * Never carries the request text or the token (non-negotiable 1), only the
	 * status and the bridge's own error code.
	 */
	private failure(res: BridgeResponse): Error {
		const code = errorField(res.body, "error");
		const reason = errorField(res.body, "reason");
		if (res.status === 401) {
			return new EngineUnavailableError(
				"readme",
				"Read Me Offline rejected the pairing token. Copy it again from Read Me Offline's Settings.",
			);
		}
		// Only "busy because Read Me is playing" ends the read. A full queue is
		// transient and an ordinary failure; serialization above should make
		// it unreachable from this engine alone.
		if (res.status === 503 && code === "busy" && reason === "playback") return new BridgeBusyError();
		if (res.status === 503 && code === "busy") {
			return new Error("Read Me Offline's bridge is handling too many requests (503 queue).");
		}
		if (res.status === 503) {
			return new EngineUnavailableError("readme", "Read Me Offline's speech engine is not ready yet.");
		}
		if (res.status === 413) {
			return new Error("Read Me Offline refused a sentence as too long (413).");
		}
		return new Error(`Read Me Offline's bridge answered ${res.status}${code ? ` (${code})` : ""}.`);
	}

	async dispose(): Promise<void> {
		this.health = null;
	}
}
