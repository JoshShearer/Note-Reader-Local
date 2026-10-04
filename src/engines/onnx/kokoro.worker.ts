/**
 * Kokoro synthesis, in a Web Worker.
 *
 * Bundled separately from the plugin with a browser target, because
 * transformers.js and onnxruntime-web pull in code paths that assume a real
 * browser. Keeping them out of `main.js` is what lets the same plugin run in
 * Electron and in the Android WebView.
 *
 * The worker never touches the network. Model bytes are handed in by the main
 * thread (read from the vault) and served through a `fetch` shim, so
 * transformers.js resolves model paths against our local copies instead of the
 * Hugging Face CDN.
 */

import "./browser-environment";
import { env } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";

export interface ModelFile {
	/** Path relative to the model directory, e.g. `onnx/model_quantized.onnx`. */
	path: string;
	bytes: ArrayBuffer;
}

/** Which backend to run inference on. `auto` prefers the GPU if there is one. */
export type DeviceRequest = "auto" | "wasm" | "webgpu";

export interface InitMessage {
	type: "init";
	modelId: string;
	modelBase: string;
	/**
	 * Where to load the onnxruntime runtime from, by explicit URL.
	 *
	 * The glue module has to be named individually because onnxruntime loads
	 * it with a dynamic `import()`, which a fetch shim cannot intercept. The
	 * main thread hands us blob URLs for both files so nothing is fetched.
	 */
	wasmPaths: { mjs: string; wasm: string };
	files: ModelFile[];
	dtype: "fp32" | "fp16" | "q8" | "q4" | "q4f16";
	device: DeviceRequest;
	/**
	 * How many WASM threads to ask for. One means the single-threaded build
	 * path; anything higher is attempted and quietly dropped back to one if
	 * this runtime will not spawn the thread pool.
	 */
	threads: number;
}

export interface SpeakMessage {
	type: "speak";
	id: number;
	text: string;
	voice: string;
	rate: number;
}

/** Extra voice bytes, so switching voice does not mean reloading the model. */
export interface VoiceMessage {
	type: "voice";
	path: string;
	bytes: ArrayBuffer;
}

export type ToWorker =
	| InitMessage
	| SpeakMessage
	| VoiceMessage
	| { type: "cancel" }
	| { type: "dispose" };

export type FromWorker =
	| { type: "progress"; loaded: number; total: number }
	| { type: "ready"; sampleRate?: number; device: "wasm" | "webgpu"; threads: number }
	| { type: "audio"; id: number; pcm: Float32Array; sampleRate: number }
	/** Diagnostic breadcrumb; never user-facing on its own. */
	| { type: "info"; message: string }
	| { type: "error"; id?: number; message: string; stack?: string };

const ctx = self as unknown as {
	fetch: typeof fetch;
	postMessage(message: unknown, transfer?: Transferable[]): void;
	addEventListener(type: "message", fn: (event: MessageEvent<ToWorker>) => void): void;
	close(): void;
};

/** Relative path -> bytes. */
let modelFiles = new Map<string, ArrayBuffer>();
let tts: KokoroTTS | null = null;
let sampleRate = 24000;
/** Last named stage reached, for attributing a stuck or crashed promise. */
let lastStep = "start";

/**
 * Resolve a model request against our local copies.
 *
 * Matching is by path suffix because transformers.js builds URLs from
 * `localModelPath` plus a model id we do not control, and the exact shape has
 * changed between releases. A suffix match is stable across those changes.
 */
function resolveLocal(url: string): ArrayBuffer | null {
	const clean = url.split("?")[0] ?? url;
	for (const [path, bytes] of modelFiles) {
		if (clean.endsWith(path)) return bytes;
	}
	// Also try just the basename, for callers that flatten the path.
	const base = clean.slice(clean.lastIndexOf("/") + 1);
	for (const [path, bytes] of modelFiles) {
		if (path === base || path.endsWith(`/${base}`)) return bytes;
	}
	return null;
}

function installFetchShim(): void {
	const realFetch = ctx.fetch.bind(ctx);
	ctx.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url =
			typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const local = resolveLocal(url);
		if (local) {
			return new Response(local, {
				status: 200,
				headers: {
					"Content-Type": "application/octet-stream",
					"Content-Length": String(local.byteLength),
				},
			});
		}
		// Anything that is not a model file has to be something local, such as
		// the onnxruntime WASM binary, which lives in the plugin folder and
		// comes back as an app:// or capacitor:// URL. Refuse anything that
		// would leave the machine rather than passing it through: a TTS engine
		// that silently phones home would defeat the point of the plugin.
		if (isRemote(url)) {
			throw new Error(`Refused a network request for a local TTS engine: ${url}`);
		}
		return realFetch(input, init);
	};
}

/**
 * Reject remote runtime locations before they reach the runtime.
 *
 * The `fetch` shim is not enough on its own. onnxruntime-web loads its
 * `ort-wasm-simd-threaded.jsep.mjs` glue with a dynamic `import()`, which does
 * not go through `fetch` at all, so a shim cannot see it. Left alone, a bad
 * `ortBase` would quietly pull the runtime off a CDN and the engine would keep
 * working, which is exactly the behaviour this plugin must not have. Checking
 * the URLs up front turns that into a loud failure.
 */
function assertLocal(label: string, url: string): void {
	if (isRemote(url)) {
		throw new Error(
			`Refusing a remote ${label} for a local TTS engine: ${url}. ` +
				`The onnxruntime runtime must be served from the plugin folder.`,
		);
	}
}

/**
 * Would this request leave the machine?
 *
 * Every scheme other than http(s) is local by construction: the onnxruntime
 * binary is served from the plugin folder over `app://` on the desktop and
 * `capacitor://` on Android, and model bytes arrive by postMessage. So only
 * http(s) can be the network, and of those, only ones aimed at another host.
 * Our own origin is allowed so the engine also works when a vault or a dev
 * server is served over http.
 */
function isRemote(url: string): boolean {
	if (!/^https?:\/\//i.test(url)) return false;
	try {
		return new URL(url).origin !== self.location.origin;
	} catch {
		return true;
	}
}

function post(message: FromWorker, transfer: Transferable[] = []): void {
	ctx.postMessage(message, transfer);
}

// Without these, a promise that rejects (or simply never settles because
// nothing calls resolve/reject, e.g. an internal Emscripten runtime that
// stalls during initialization) has no path back to the main thread: our own
// try/catch only sees rejections on a promise chain we are actually awaiting.
// This is what closes that gap for anything happening off that chain.
const globalTarget = self as unknown as {
	addEventListener(type: string, fn: (event: unknown) => void): void;
};
globalTarget.addEventListener("error", (event) => {
	const e = event as { message?: string; error?: { stack?: string } };
	post({
		type: "error",
		message: `Uncaught worker error at step ${lastStep}: ${e.message ?? "unknown error"}`,
		stack: e.error?.stack ?? "",
	});
});
globalTarget.addEventListener("unhandledrejection", (event) => {
	const raw: unknown = (event as { reason?: unknown }).reason;
	const reason = raw as { message?: string; stack?: string } | undefined;
	post({
		type: "error",
		message: `Unhandled rejection at step ${lastStep}: ${reason?.message ?? String(raw)}`,
		stack: reason?.stack ?? "",
	});
});

async function init(msg: InitMessage): Promise<void> {
	try {
		await initInner(msg);
	} catch (err) {
		// Send the full error back so the user-visible Notice names the cause.
		// Without this, an exception thrown deep in transformers.js / ORT comes
		// back as a generic `Cannot read properties of undefined (reading
		// 'wasm')` and leaves nothing to debug.
		post({
			type: "error",
			message: `Worker init failed at step ${lastStep}: ${(err as Error).message}`,
			stack: (err as Error).stack ?? "",
		});
	}
}

async function initInner(msg: InitMessage): Promise<void> {
	lastStep = "installing fetch shim";
	installFetchShim();

	lastStep = "checking URLs";
	assertLocal("model directory", msg.modelBase);
	assertLocal("onnxruntime glue module", msg.wasmPaths.mjs);
	assertLocal("onnxruntime WASM binary", msg.wasmPaths.wasm);

	modelFiles = new Map();
	for (const file of msg.files) {
		// Register both the plain path and the model-id-prefixed form so either
		// URL shape resolves.
		modelFiles.set(file.path, file.bytes);
		const withId = `${msg.modelId}/${file.path}`;
		modelFiles.set(withId, file.bytes);
	}
	env.allowLocalModels = true;
	env.allowRemoteModels = false;
	env.localModelPath = msg.modelBase;
	// Model bytes arrive over postMessage and are served through the fetch
	// shim. transformers.js would otherwise try the filesystem first when it
	// thinks it is in Node (which an Electron worker reports), bypassing the
	// shim entirely. Force every model read down the fetch path.
	env.useFS = false;
	env.useFSCache = false;
	env.useBrowserCache = false;

	lastStep = "configuring browser WASM runtime";
	const wasm = env.backends.onnx?.wasm;
	if (!wasm) throw new Error("Transformers did not initialize the browser ONNX backend");
	wasm.proxy = false;
	wasm.wasmPaths = msg.wasmPaths;

	lastStep = "choosing a backend";
	const plan = await buildAttempts(msg);
	post({
		type: "info",
		message: `backend plan: ${plan.map((a) => `${a.device}/${a.threads}t`).join(" -> ")}`,
	});

	let lastError: unknown = null;
	for (const attempt of plan) {
		lastStep = `loading model on ${attempt.device} with ${attempt.threads} thread(s)`;
		wasm.numThreads = attempt.threads;
		const started = Date.now();
		try {
			tts = await KokoroTTS.from_pretrained(msg.modelId, {
				dtype: msg.dtype,
				device: attempt.device,
				progress_callback: (p: unknown) => {
					const info = p as { status?: string; loaded?: number; total?: number };
					// The callback fires for several phases; only file downloads
					// carry byte counts, and those are what a progress bar can show.
					if (typeof info.loaded === "number" && typeof info.total === "number") {
						post({ type: "progress", loaded: info.loaded, total: info.total });
					}
				},
			});
			post({
				type: "info",
				message: `loaded on ${attempt.device} with ${attempt.threads} thread(s) in ${Date.now() - started}ms`,
			});
			post({ type: "ready", sampleRate, device: attempt.device, threads: attempt.threads });
			return;
		} catch (err) {
			lastError = err;
			tts = null;
			// A failed attempt is expected: it is how we find out that this
			// runtime will not give us a GPU adapter or a thread pool. Only the
			// last one failing is a real error.
			post({
				type: "info",
				message: `backend ${attempt.device}/${attempt.threads}t unavailable: ${errText(err)}`,
			});
		}
	}

	throw new Error(`No usable backend. Last failure: ${errText(lastError)}`);
}

interface Attempt {
	device: "wasm" | "webgpu";
	threads: number;
}

/**
 * Backends to try, best first.
 *
 * Capability probes lie in both directions here, so the plan is a list rather
 * than a decision: `navigator.gpu` can exist with no adapter behind it (Chrome
 * on Linux does exactly this), and `SharedArrayBuffer` can exist while the
 * thread pool still fails to start, because onnxruntime spawns that pool from
 * inside this worker and nested workers are not reliable in Electron. Trying
 * and falling back is the only way to find out which is true today, and it
 * costs one failed load rather than a permanently wrong assumption.
 */
async function buildAttempts(msg: InitMessage): Promise<Attempt[]> {
	const attempts: Attempt[] = [];

	if (msg.device === "webgpu" || msg.device === "auto") {
		if (await hasGpuAdapter()) {
			attempts.push({ device: "webgpu", threads: 1 });
		} else {
			post({ type: "info", message: "no WebGPU adapter; staying on WASM" });
		}
	}

	// The CPU path is always kept as a tail, including when the GPU was asked
	// for explicitly: the weights the main thread sent load on either backend,
	// so a GPU that accepts an adapter but then fails to build a session
	// should cost speed, not the ability to read the note.
	const wanted = Math.max(1, Math.floor(msg.threads));
	const cores = navigator.hardwareConcurrency || 1;
	const threads = Math.min(wanted, Math.max(1, cores));
	const threadsUsable = typeof SharedArrayBuffer !== "undefined";
	if (threads > 1 && threadsUsable) attempts.push({ device: "wasm", threads });
	if (threads > 1 && !threadsUsable) {
		post({ type: "info", message: "no SharedArrayBuffer; threads unavailable" });
	}
	attempts.push({ device: "wasm", threads: 1 });

	return attempts;
}

/** Is there a real GPU behind `navigator.gpu`, not just the API surface? */
async function hasGpuAdapter(): Promise<boolean> {
	const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
	if (!gpu) return false;
	try {
		return (await gpu.requestAdapter()) != null;
	} catch {
		return false;
	}
}

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

async function speak(msg: SpeakMessage, generation: number): Promise<void> {
	if (!tts) throw new Error("Kokoro model is not loaded");

	lastStep = `generating speech (id ${msg.id})`;
	// generate() phonemizes with a separately-bundled espeak-ng WASM module
	// before it ever reaches the ONNX model. That module has its own async
	// init we do not control; if it never settles, nothing here throws, so a
	// stall shows up as this stage staying current with no error ever posted.
	const result = await tts.generate(msg.text, {
		voice: msg.voice as NonNullable<Parameters<KokoroTTS["generate"]>[1]>["voice"],
		speed: msg.rate || 1,
	});
	lastStep = `generated speech (id ${msg.id})`;
	// Playback moved on while this was running: the audio is for a sentence
	// nobody is waiting for, and the main thread has already rejected its
	// promise, so posting it would only be noise.
	if (generation !== currentGeneration) return;

	const pcm = result.audio;
	sampleRate = result.sampling_rate ?? sampleRate;

	// Copy so the buffer can be transferred rather than structured-cloned.
	const copy = new Float32Array(pcm);
	post({ type: "audio", id: msg.id, pcm: copy, sampleRate }, [copy.buffer]);
}

/**
 * Pending synthesis, oldest first, tagged with the run it belongs to.
 *
 * Synthesis is the slowest thing this plugin does, so work that has been
 * abandoned must never be allowed to delay work that has not. Stopping bumps
 * the generation, which drops everything still queued; only the request
 * already inside `generate()` runs to completion, because onnxruntime has no
 * way to interrupt it.
 */
const queue: Array<{ msg: SpeakMessage; generation: number }> = [];
let currentGeneration = 0;
let draining = false;

function enqueue(msg: SpeakMessage): void {
	queue.push({ msg, generation: currentGeneration });
	void drain();
}

/**
 * Let queued messages be delivered before starting the next job.
 *
 * Inference blocks this worker's thread, and finishing one job only yields a
 * microtask, which is not enough for a `message` event to be dispatched.
 * Without this pause the cancel that stopping sends is not seen until the
 * whole queue has been synthesised, which is the exact opposite of what it is
 * for: measured at 45s of abandoned work before a cancel took effect.
 */
function yieldToMessages(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

async function drain(): Promise<void> {
	if (draining) return;
	draining = true;
	try {
		for (;;) {
			await yieldToMessages();
			const job = queue.shift();
			if (!job) return;
			if (job.generation !== currentGeneration) continue;
			try {
				await speak(job.msg, job.generation);
			} catch (err) {
				post({ type: "error", id: job.msg.id, message: errText(err) });
			}
		}
	} finally {
		draining = false;
	}
}

function cancelQueued(): void {
	currentGeneration += 1;
	const dropped = queue.length;
	queue.length = 0;
	if (dropped > 0) post({ type: "info", message: `dropped ${dropped} queued request(s)` });
}

ctx.addEventListener("message", (event: MessageEvent<ToWorker>) => {
	const msg = event.data;
	void (async () => {
		try {
			switch (msg.type) {
				case "init":
					await init(msg);
					break;
				case "speak":
					enqueue(msg);
					break;
				case "voice":
					modelFiles.set(msg.path, msg.bytes);
					break;
				case "cancel":
					cancelQueued();
					break;
				case "dispose":
					cancelQueued();
					tts = null;
					modelFiles.clear();
					ctx.close();
					break;
			}
		} catch (err) {
			post({
				type: "error",
				id: msg.type === "speak" ? msg.id : undefined,
				message: errText(err),
			});
		}
	})();
});
