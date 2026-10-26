import {
	EngineUnavailableError,
	type SpeechChunk,
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

/**
 * How often a read in progress asks Read Me where it is.
 *
 * The answer moves the highlight, so this is how far the highlight can lag
 * a sentence change. A loopback GET; while Obsidian is in the background its
 * timers are throttled and the reading does not depend on them.
 */
export const STATUS_POLL_MS = 250;

/** A single control or status call: loopback, so anything slower is a dead bridge. */
export const CONTROL_TIMEOUT_MS = 3000;

/**
 * What one `/play` may carry (Read Me's contract: 1 MiB, 10,000 chunks). A
 * longer note is sent in parts: when the reading reaches the end of a part,
 * the next `synthesize` starts the next one.
 */
export const PLAY_MAX_BYTES = 1024 * 1024;
export const PLAY_MAX_CHUNKS = 10_000;

/** U+001E, record separator: Read Me splits the `/play` body on it. */
const SEPARATOR = "\u001e";

/** Where to send someone who does not have the companion app. Text only; never fetched. */
export const READ_ME_URL = "https://github.com/JoshShearer/Read-Me";

/** The F-Droid listing, shown as a plain link in Settings. Never fetched; the user's click opens it. */
export const READ_ME_FDROID_URL = "https://f-droid.org/en/packages/io.loopstring.readme/";

/** What to do, in Read Me and then in this plugin, to pair, in order. */
export const READ_ME_SETUP_STEPS: readonly string[] = [
	'Turn on "Use the bridge".',
	"Allow the notification.",
	"Copy the token here.",
	"Leave this plugin's Speech engine on Automatic.",
];

/**
 * Whether Settings shows the get-the-app link and steps. `null` is a check
 * still in flight: until one reports the bridge available, the person has not
 * been told they are connected, so the help stays up.
 */
export function shouldShowBridgeSetup(availability: EngineAvailability | null): boolean {
	return !availability?.available;
}

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
	/** Read Me reads the chunks itself (`/play`, its ADR 0014). Required since Read Me 1.1.0. */
	play: boolean;
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
	const timer = window.setTimeout(() => controller.abort(), req.timeoutMs);
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
		window.clearTimeout(timer);
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
		play: r.play === true,
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

/** Read Me's `/status`: which session, in what state, at which of its chunks. */
interface PlayStatus {
	session: number;
	state: "none" | "starting" | "playing" | "paused" | "ended" | "stopped";
	index: number;
}

function parseStatus(body: ArrayBuffer): PlayStatus | null {
	const raw = decodeJson(body);
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.session !== "number" || typeof r.state !== "string" || typeof r.index !== "number") return null;
	return { session: r.session, state: r.state as PlayStatus["state"], index: r.index };
}

/**
 * Read Me stopped reading the note on its own side: the user stopped it from
 * the lock screen or the notification, or started reading an article in Read
 * Me. Ends the read without falling back to another engine.
 */
export class BridgeStoppedError extends EngineUnavailableError {
	readonly noFallback = true;
	constructor() {
		super("readme", "Read Me Offline stopped reading this note.");
		this.name = "BridgeStoppedError";
	}
}

/** The chunks one `/play` sent, by chunk id, and the rate it was read at. */
interface Session {
	id: number;
	chunkIds: string[];
	rate: number;
}

export class ReadMeBridgeEngine implements SpeechEngine {
	readonly id = "readme" as const;
	readonly label = "Read Me Offline (Android voices)";
	readonly capabilities: EngineCapabilities = {
		// The voice is chosen in Read Me (its R-S01), not per request.
		voices: false,
		// The bridge promises no word timings; the sentence layer and the
		// NRL-72 scroll still work (highlight.ts disables the word row only).
		timing: "none",
		// Read Me applies it, once, at synthesis: this engine owns playback, so
		// the player passes the user's rate and never touches an element
		// (non-negotiable 9).
		rate: true,
		pitch: false,
		desktopOnly: false,
		// A pair, on Read Me's own session (`/control`).
		pause: true,
		resume: true,
		sentenceBoundary: false,
		offlineStatus: false,
		// Read Me reads the note in its own foreground service (its ADR 0014).
		// Obsidian playing the audio itself was muted by Android about 5 s after
		// Obsidian left the screen (Read Me REA-39, measured 2026-10-08).
		ownsPlayback: true,
	};

	private health: BridgeHealth | null = null;
	private session: Session | null = null;
	/** The session position that continues it: the one after the last chunk finished. */
	private next = 0;

	constructor(
		private readonly config: () => BridgeConfig,
		private readonly transport: BridgeTransport = fetchTransport,
		private readonly sleep: (ms: number) => Promise<void> = (ms) =>
			new Promise((resolve) => window.setTimeout(resolve, ms)),
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
		if (!health.play) {
			return {
				available: false,
				reason: "This Read Me Offline is too old for this plugin: update it to 1.1.0 or later, which reads notes itself.",
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

	/**
	 * Speak `req.chunk`: resolves once Read Me has read past it.
	 *
	 * The first call of a read sends the chunk and everything after it in one
	 * `/play`, and Read Me reads them all in its own service, whatever Obsidian
	 * does meanwhile. Each later call finds its chunk in that session and only
	 * waits for Read Me's `/status` to move past it, which is what moves the
	 * player's highlight. A chunk outside the session, a new rate, or a
	 * session Read Me no longer has, starts a new one from this chunk.
	 */
	async synthesize(req: SynthRequest, signal: AbortSignal): Promise<SynthResult> {
		// A chunk with nothing to say: Read Me refuses blank chunks, and the
		// session stopped short of this one (see `buildPlay`).
		if (req.chunk.text.trim() === "") return { kind: "streamed", estimatedMs: 0, words: null };
		const { base, auth } = this.target();
		let position = this.positionInSession(req);
		// Only the chunk after the one last finished continues the session.
		// Anything else is the player jumping (a replay, Previous, Next), and
		// Read Me must jump with it. The next chunk in order may already be
		// read: Read Me went on while Obsidian was in the background, and the
		// player catches up one resolved chunk at a time.
		if (position >= 0 && position !== this.next) position = -1;
		if (position >= 0) {
			const status = await this.status(base, auth, signal);
			const live = status.session === this.session!.id && status.state !== "stopped" && status.state !== "none";
			if (!live) position = -1;
		}
		if (position < 0) {
			await this.play(base, auth, req, signal);
			position = 0;
		}
		await this.waitPast(base, auth, position, signal);
		this.next = position + 1;
		return { kind: "streamed", estimatedMs: 0, words: null };
	}

	pause(): void {
		this.control("pause");
	}

	resume(): void {
		this.control("resume");
	}

	/** Base URL and Authorization header, or the error a user can act on. */
	private target(): { base: string; auth: string } {
		const base = this.baseUrl();
		if (!base) throw new EngineUnavailableError("readme", "The Read Me bridge port is not a valid port number.");
		const { token } = this.config();
		if (token.trim() === "") {
			throw new EngineUnavailableError(
				"readme",
				"Paste the pairing token from Read Me Offline's Settings into this plugin's settings.",
			);
		}
		return { base, auth: `Bearer ${token.trim()}` };
	}

	/** Where `req.chunk` sits in the current session at its rate, or -1. */
	private positionInSession(req: SynthRequest): number {
		const s = this.session;
		if (!s || s.rate !== req.rate) return -1;
		return s.chunkIds.indexOf(req.chunk.id);
	}

	/**
	 * `req.chunk` and what follows it, up to Read Me's limits and the first
	 * blank chunk (Read Me refuses blank ones; that chunk is skipped here and
	 * the next one starts a new session).
	 */
	private buildPlay(req: SynthRequest): { chunks: SpeechChunk[]; body: string } {
		const chunks: SpeechChunk[] = [];
		const parts: string[] = [];
		let bytes = 0;
		const encoder = new TextEncoder();
		for (const c of [req.chunk, ...(req.following?.() ?? [])]) {
			if (c.text.trim() === "" || chunks.length >= PLAY_MAX_CHUNKS) break;
			// The separator cannot be part of a chunk: it would split it in two
			// and every index after it would be off by one.
			const text = c.text.split(SEPARATOR).join(" ");
			const size = encoder.encode(text).length + (parts.length > 0 ? 1 : 0);
			if (chunks.length > 0 && bytes + size > PLAY_MAX_BYTES) break;
			bytes += size;
			chunks.push(c);
			parts.push(text);
		}
		return { chunks, body: parts.join(SEPARATOR) };
	}

	private async play(base: string, auth: string, req: SynthRequest, signal: AbortSignal): Promise<void> {
		const { chunks, body } = this.buildPlay(req);
		// The rate goes to Read Me, which applies it once at synthesis; the
		// player applies none to an engine that owns playback (non-negotiable
		// 9). The text goes in the body and never the URL.
		const res = await this.call(
			{
				method: "POST",
				url: `${base}/play?rate=${req.rate.toFixed(2)}`,
				headers: { Authorization: auth, "Content-Type": "text/plain; charset=utf-8" },
				body,
				timeoutMs: SYNTH_TIMEOUT_MS,
				signal,
			},
			signal,
		);
		if (res.status !== 200) throw this.failure(res);
		const parsed = decodeJson(res.body) as { session?: unknown } | null;
		if (typeof parsed?.session !== "number") throw new Error("Read Me Offline's bridge answered /play without a session.");
		this.session = { id: parsed.session, chunkIds: chunks.map((c) => c.id), rate: req.rate };
		this.next = 0;
	}

	/** Polls `/status` until Read Me is past `position`, has ended, or stopped. */
	private async waitPast(base: string, auth: string, position: number, signal: AbortSignal): Promise<void> {
		const id = this.session!.id;
		const onAbort = (): void => {
			// The player stopped, or moved to another chunk (which will start a
			// new session): either way Read Me must stop reading this one.
			if (this.session?.id === id) {
				this.control("stop");
				this.session = null;
			}
		};
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			for (;;) {
				if (signal.aborted) throw new DOMException("Aborted", "AbortError");
				const status = await this.status(base, auth, signal);
				if (status.session !== id || status.state === "stopped" || status.state === "none") {
					if (this.session?.id === id) this.session = null;
					throw new BridgeStoppedError();
				}
				if (status.state === "ended" || status.index > position) return;
				await this.sleep(STATUS_POLL_MS);
			}
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

	private async status(base: string, auth: string, signal: AbortSignal): Promise<PlayStatus> {
		const res = await this.call(
			{ method: "GET", url: `${base}/status`, headers: { Authorization: auth }, timeoutMs: CONTROL_TIMEOUT_MS, signal },
			signal,
		);
		if (res.status !== 200) throw this.failure(res);
		const status = parseStatus(res.body);
		if (!status) throw new Error("Read Me Offline's bridge answered /status with something else.");
		return status;
	}

	/** One request; a transport failure is "the bridge is not running", an abort stays an abort. */
	private async call(req: BridgeRequest, signal: AbortSignal): Promise<BridgeResponse> {
		try {
			return await this.transport(req);
		} catch {
			if (signal.aborted) throw new DOMException("Aborted", "AbortError");
			throw new EngineUnavailableError("readme", NOT_RUNNING);
		}
	}

	/**
	 * Pause, resume or stop the current session, fire and forget: the player
	 * calls these synchronously and they must not throw. A stale session is
	 * Read Me's to refuse (409), which changes nothing.
	 */
	private control(action: "pause" | "resume" | "stop"): void {
		const s = this.session;
		if (!s) return;
		let target: { base: string; auth: string };
		try {
			target = this.target();
		} catch {
			return;
		}
		void this.transport({
			method: "POST",
			url: `${target.base}/control?action=${action}&session=${s.id}`,
			headers: { Authorization: target.auth },
			body: "",
			timeoutMs: CONTROL_TIMEOUT_MS,
		}).catch(() => undefined);
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
		this.control("stop");
		this.session = null;
		this.health = null;
	}
}
