import {
	EngineUnavailableError,
	type EngineAvailability,
	type EngineCapabilities,
	type EngineId,
	type SpeechEngine,
	type SynthRequest,
	type SynthResult,
	type VoiceInfo,
} from "../../audio/types";
import { allocateWordTimings } from "../../audio/words";
import { parseWav } from "../../audio/wav";

/**
 * Piper over a user-run loopback HTTP server (NRL-148, docs/adr/0040).
 *
 * Piper itself is a Python program with a 700 MB resident model, so the
 * plugin does not spawn it per sentence (1.5-1.8 s cold start each time on
 * the owner's machine). The user runs `python -m piper.http_server` bound to
 * 127.0.0.1 (companion/piper/README.md) and this engine POSTs each sentence
 * to it, which keeps note text out of argv entirely (non-negotiable 2's
 * reason) and out of speech-dispatcher's sd_generic shell command.
 *
 * Three promises shape the class:
 *
 * - No I/O unless the user asked for it. `isAvailable()`, `listVoices()` and
 *   `lastAvailability()` only read a cache, because they are called from
 *   onload, layout-ready prewarm and every settings render. The only network
 *   calls are `check()` (Check connection, choosing Piper, starting a read)
 *   and `synthesize()`.
 * - No note text to a port that has not just answered like Piper. Every
 *   synthesis first needs a cached Piper-shaped `/voices` answer for the
 *   configured port, and any failed synthesis drops that answer, so the next
 *   sentence re-probes. Whatever else might be listening there gets a GET.
 * - The player owns the rate. This is a buffer engine: it always renders at
 *   the voice's natural speed and the player sets `playbackRate`, so the rate
 *   is applied exactly once (non-negotiable 9) and prefetch keeps working.
 *
 * No obsidian import, no builtin and no `trace()` here, so bare Node can drive
 * the real class and nothing in it can log note text (non-negotiable 1).
 */

/** Fixed, not a setting: nothing but this machine may receive note text. */
export const PIPER_HOST = "127.0.0.1";
export const DEFAULT_PIPER_PORT = 5011;

// --- Upstream protocol ------------------------------------------------------
//
// piper1-gpl `src/piper/http_server.py` at v1.8.0, as read by a reviewer, not
// run in this pipeline (Piper is not installed where this was written). Every
// assumption about the server lives in this block, so a wrong guess is a
// one-place fix. Older tags differ: v1.3.0 synthesizes on `POST /`.
//
// The server also has a download route and an all-voices route, which reach
// the internet, and an info route that echoes the last text spoken. The
// plugin calls none of them, and `send()` refuses any path not listed here
// (tests/piper.test.ts also rejects their path literals in this directory).

export const PIPER_SYNTH_PATH = "/synthesize";
/** Lists voices from local `.onnx.json` files only; synthesizes nothing. */
export const PIPER_PROBE_PATH = "/voices";
export const ALLOWED_PATHS: readonly string[] = [PIPER_PROBE_PATH, PIPER_SYNTH_PATH];

/**
 * The synthesis body. `length_scale` is deliberately absent: omitting it uses
 * the voice's own default, and sending a scaled one would apply the rate a
 * second time on top of the player's (non-negotiable 9). An unknown voice
 * falls back to the server's default voice; it never triggers a download.
 */
export function buildSynthesizeRequest(text: string, voiceName: string | null): { text: string; voice?: string } {
	return voiceName ? { text, voice: voiceName } : { text };
}

/**
 * `/voices` is an object keyed by voice name, each value that voice's config.
 * Returns null when the answer is not shaped like that at all, which is how a
 * different program on the port is told apart from Piper.
 */
export function parseVoices(body: unknown): VoiceInfo[] | null {
	if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
	const voices: VoiceInfo[] = [];
	for (const [name, config] of Object.entries(body as Record<string, unknown>)) {
		if (name.trim() === "") continue;
		voices.push({
			id: `piper:${name}`,
			name,
			lang: voiceLang(name, config),
			gender: "neutral",
			engineId: "piper",
			// The server synthesizes from model files on this machine, and the
			// plugin only ever talks to 127.0.0.1, so every voice is local.
			local: true,
			requiresNetwork: false,
		});
	}
	return voices.sort((a, b) => a.name.localeCompare(b.name));
}

function voiceLang(name: string, config: unknown): string {
	if (typeof config === "object" && config !== null) {
		const language = (config as Record<string, unknown>).language;
		if (typeof language === "object" && language !== null) {
			const code = (language as Record<string, unknown>).code;
			if (typeof code === "string" && code.trim() !== "") return code.trim().replace(/_/g, "-");
		}
	}
	// Piper voice names start with the locale: `en_US-lessac-medium`.
	const m = /^([a-z]{2,3})_([A-Z]{2})-/.exec(name);
	return m ? `${m[1]}-${m[2]}` : "";
}

// --- Transport --------------------------------------------------------------

export const PROBE_TIMEOUT_MS = 1500;
/** A long note sentence on a slow CPU; the warm server measured 0.28-0.40 s. */
export const SYNTH_TIMEOUT_MS = 30_000;

export interface PiperConfig {
	port: number;
}

export interface PiperRequest {
	method: "GET" | "POST";
	url: string;
	contentType?: string;
	body?: string;
	timeoutMs: number;
	signal?: AbortSignal;
}

export interface PiperResponse {
	status: number;
	body: ArrayBuffer;
}

/**
 * Sends one request. Resolves with any HTTP answer, error statuses included,
 * and rejects only when no answer arrived at all. A seam so the suite can
 * stand in for the server, like the bridge's `BridgeTransport`.
 */
export type PiperTransport = (req: PiperRequest) => Promise<PiperResponse>;

/** The slice of Obsidian's `requestUrl` this engine uses. */
export type RequestUrlLike = (params: {
	url: string;
	method: string;
	contentType?: string;
	body?: string;
	throw: boolean;
}) => Promise<{ status: number; arrayBuffer: ArrayBuffer }>;

/**
 * Adapt Obsidian's `requestUrl` to a `PiperTransport`.
 *
 * `requestUrl` rather than `fetch` because the Piper server probably sends no
 * CORS headers (unverified), and a renderer `fetch` could then not read the
 * answer. `throw: false` makes an error status an answer rather than a
 * rejection, which is the transport contract. `requestUrl` takes no timeout
 * or signal; the engine races every request against `withDeadline` instead.
 *
 * Lives here, taking `requestUrl` as an argument, so the mapping runs in the
 * bare-Node suite; requestUrlTransport.ts only binds the real one.
 */
export function makeRequestUrlTransport(requestUrl: RequestUrlLike): PiperTransport {
	return async (req) => {
		const res = await requestUrl({
			url: req.url,
			method: req.method,
			contentType: req.contentType,
			body: req.body,
			throw: false,
		});
		return { status: res.status, body: res.arrayBuffer };
	};
}

function abortError(): Error {
	return new DOMException("Aborted", "AbortError");
}

function isAbortError(err: unknown): boolean {
	return err instanceof Error && err.name === "AbortError";
}

/**
 * Settle with `promise`, or reject when `ms` passes or `signal` aborts first.
 *
 * Obsidian's `requestUrl` cannot be cancelled, so a timed-out or stopped
 * request is abandoned rather than cancelled: it may keep running on the
 * server, but the engine's queue moves on.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError());
			return;
		}
		const finish = (): void => {
			window.clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		const onAbort = (): void => {
			finish();
			reject(abortError());
		};
		const timer = window.setTimeout(() => {
			finish();
			reject(new Error("Timed out."));
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				finish();
				resolve(value);
			},
			(err: unknown) => {
				finish();
				reject(err instanceof Error ? err : new Error("Request failed."));
			},
		);
	});
}

// --- Engine -----------------------------------------------------------------

const CAPABILITIES: EngineCapabilities = {
	voices: true,
	// A WAV with a real duration; words are apportioned across it.
	timing: "measured",
	rate: true,
	// piper.http_server has no pitch control.
	pitch: false,
	desktopOnly: true,
	// The player's own element plays the WAV, so pausing that works.
	pause: true,
	resume: true,
	sentenceBoundary: false,
	offlineStatus: true,
	// A buffer engine: the player applies the rate. See the class comment.
	ownsPlayback: false,
};

export const NOT_CHECKED_REASON =
	"Not checked yet. Use Check connection under Advanced > Piper server, or start a read.";

function validPort(port: number): boolean {
	return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function invalidPortReason(): string {
	return "The Piper server port is not a valid port number. Set one between 1 and 65535 under Advanced > Piper server.";
}

function notAnsweringReason(port: number): string {
	return (
		`No Piper server answered on ${PIPER_HOST}:${port}. Start it with --host ${PIPER_HOST} --port ${port}; ` +
		"see companion/piper/README.md."
	);
}

function notPiperReason(port: number): string {
	return `Something answered on ${PIPER_HOST}:${port}, but not like a Piper server. Check the port under Advanced > Piper server.`;
}

function noVoicesReason(port: number): string {
	return `The Piper server on ${PIPER_HOST}:${port} has no voices. Put a voice's .onnx and .onnx.json files in its data directory.`;
}

function decodeJson(body: ArrayBuffer): unknown {
	try {
		return JSON.parse(new TextDecoder().decode(body)) as unknown;
	} catch {
		return null;
	}
}

function isWav(body: ArrayBuffer): boolean {
	if (body.byteLength < 44) return false;
	const head = new TextDecoder("ascii").decode(new Uint8Array(body, 0, 12));
	return head.startsWith("RIFF") && head.slice(8, 12) === "WAVE";
}

interface ProbeCache {
	port: number;
	availability: EngineAvailability;
	voices: VoiceInfo[];
}

export class PiperEngine implements SpeechEngine {
	readonly id: EngineId = "piper";
	readonly label = "Piper (local server)";
	readonly capabilities = CAPABILITIES;

	private cache: ProbeCache | null = null;
	private inFlight: { port: number; promise: Promise<EngineAvailability> } | null = null;
	private voiceName: string | null = null;
	/**
	 * One request at a time. The server synthesizes serially anyway, and a
	 * prefetch burst would otherwise put the sentence being waited for behind
	 * later ones in whatever order the server picked them up.
	 */
	private queue: Promise<void> = Promise.resolve();
	/** Bumped by `cancelPending()`; a queued job from an older one never sends. */
	private generation = 0;

	constructor(
		private readonly config: () => PiperConfig,
		private readonly transport: PiperTransport,
	) {}

	/** The cached answer, with no I/O. Safe from onload and settings renders. */
	lastAvailability(): EngineAvailability {
		const port = this.config().port;
		if (!validPort(port)) return { available: false, reason: invalidPortReason() };
		if (!this.cache || this.cache.port !== port) return { available: false, reason: NOT_CHECKED_REASON };
		return this.cache.availability;
	}

	/**
	 * Cache-only on purpose. Every caller of `isAvailable()` (the settings
	 * status list, automatic selection on load, prewarm) would otherwise make
	 * a loopback request nobody asked for. `check()` is the probe.
	 */
	async isAvailable(): Promise<EngineAvailability> {
		return this.lastAvailability();
	}

	/**
	 * Ask the server, once, with concurrent callers sharing the one request.
	 * Called only from user actions and from synthesis.
	 */
	async check(): Promise<EngineAvailability> {
		const port = this.config().port;
		if (!validPort(port)) {
			const availability: EngineAvailability = { available: false, reason: invalidPortReason() };
			this.cache = { port, availability, voices: [] };
			return availability;
		}
		if (this.inFlight && this.inFlight.port === port) return await this.inFlight.promise;
		const promise = this.probe(port);
		this.inFlight = { port, promise };
		try {
			return await promise;
		} finally {
			if (this.inFlight?.promise === promise) this.inFlight = null;
		}
	}

	private async probe(port: number): Promise<EngineAvailability> {
		let res: PiperResponse;
		try {
			res = await this.send(port, PIPER_PROBE_PATH, { method: "GET", timeoutMs: PROBE_TIMEOUT_MS });
		} catch {
			return this.remember(port, { available: false, reason: notAnsweringReason(port) }, []);
		}
		if (res.status !== 200) return this.remember(port, { available: false, reason: notPiperReason(port) }, []);
		const voices = parseVoices(decodeJson(res.body));
		if (voices === null) return this.remember(port, { available: false, reason: notPiperReason(port) }, []);
		if (voices.length === 0) return this.remember(port, { available: false, reason: noVoicesReason(port) }, []);
		return this.remember(port, { available: true }, voices);
	}

	private remember(port: number, availability: EngineAvailability, voices: VoiceInfo[]): EngineAvailability {
		this.cache = { port, availability, voices };
		return availability;
	}

	/**
	 * Drop the "this port is Piper" answer after a failed synthesis, so the
	 * next sentence probes before sending text again. The voices stay listed:
	 * the dropdown should not empty because one request failed.
	 */
	private invalidate(port: number, reason: string): void {
		if (this.cache && this.cache.port === port) {
			this.cache = { port, availability: { available: false, reason }, voices: this.cache.voices };
		}
	}

	/** The only way out to the network: loopback host, allowlisted path. */
	private send(
		port: number,
		path: string,
		req: Omit<PiperRequest, "url">,
	): Promise<PiperResponse> {
		if (!ALLOWED_PATHS.includes(path)) {
			return Promise.reject(new Error("Refused a Piper request to a path the plugin does not use."));
		}
		const url = `http://${PIPER_HOST}:${port}${path}`;
		return withDeadline(this.transport({ ...req, url }), req.timeoutMs, req.signal);
	}

	/** Cache-only, like `isAvailable()`: the settings Voice dropdown calls this on render. */
	async listVoices(): Promise<VoiceInfo[]> {
		const port = this.config().port;
		if (!this.cache || this.cache.port !== port) return [];
		return [...this.cache.voices];
	}

	async selectVoice(voice: VoiceInfo): Promise<void> {
		this.voiceName = voice.engineId === "piper" ? voice.id.replace(/^piper:/, "") : null;
	}

	cancelPending(): void {
		this.generation += 1;
	}

	synthesize(req: SynthRequest, signal: AbortSignal): Promise<SynthResult> {
		// Nothing to say; and an empty POST would only earn a server error.
		if (req.chunk.text.trim() === "") {
			return Promise.resolve({ kind: "streamed", estimatedMs: 0, words: null });
		}
		const generation = this.generation;
		const job = this.queue.then(() => this.runJob(req, signal, generation));
		// The queue only orders jobs; each caller sees its own job's error.
		this.queue = job.then(
			() => undefined,
			() => undefined,
		);
		return job;
	}

	private async runJob(req: SynthRequest, signal: AbortSignal, generation: number): Promise<SynthResult> {
		const stale = (): boolean => signal.aborted || generation !== this.generation;
		if (stale()) throw abortError();

		const port = this.config().port;
		if (!(this.cache?.port === port && this.cache.availability.available)) {
			const availability = await this.check();
			if (stale()) throw abortError();
			if (!availability.available) throw new EngineUnavailableError("piper", availability.reason);
		}

		// `req.rate` is deliberately unused: see buildSynthesizeRequest.
		const body = JSON.stringify(buildSynthesizeRequest(req.chunk.text, this.voiceName));
		let res: PiperResponse;
		try {
			res = await this.send(port, PIPER_SYNTH_PATH, {
				method: "POST",
				contentType: "application/json",
				body,
				timeoutMs: SYNTH_TIMEOUT_MS,
				signal,
			});
		} catch (err) {
			if (isAbortError(err) || stale()) throw abortError();
			const reason = notAnsweringReason(port);
			this.invalidate(port, reason);
			// A fixed string: the caught error is never echoed (non-negotiable 1).
			throw new EngineUnavailableError("piper", reason);
		}
		if (stale()) throw abortError();

		// Fixed strings only from here on. A server error body can echo the
		// request text back, so it is never read into a message.
		if (res.status !== 200) {
			const message = `Piper server answered ${res.status}.`;
			this.invalidate(port, message);
			throw new Error(message);
		}
		if (!isWav(res.body)) {
			const message = "The Piper server's answer was not WAV audio.";
			this.invalidate(port, message);
			throw new Error(message);
		}

		const wav = parseWav(res.body);
		return {
			kind: "buffer",
			audio: res.body,
			sampleRate: wav.sampleRate,
			durationMs: wav.durationMs,
			// Natural-speed audio, so natural-speed timings; the player scales both.
			words: allocateWordTimings(req.chunk, wav.durationMs, 1),
		};
	}

	async dispose(): Promise<void> {
		this.cancelPending();
	}
}

/**
 * The manual read paths' availability step. Piper's `isAvailable()` only reads
 * a cache, so a read with Piper pinned probes here first: that fills the
 * voice list before the pinned voice is chosen, and refuses the read with the
 * server's reason before playback starts. Null for every other engine, whose
 * read path stays exactly as it was.
 */
export async function confirmManualEngine(engine: SpeechEngine): Promise<EngineAvailability | null> {
	return engine instanceof PiperEngine ? await engine.check() : null;
}
