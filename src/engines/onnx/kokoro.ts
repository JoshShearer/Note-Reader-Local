import type {
	EngineCapabilities,
	EngineId,
	SpeechEngine,
	SynthRequest,
	SynthResult,
	VoiceInfo,
} from "../../audio/types";
import { allocateWordTimings } from "../../audio/words";
import { pcmToWav } from "../../audio/wav";
import type { DeviceRequest, FromWorker, ModelFile, ToWorker } from "./kokoro.worker";

/**
 * Kokoro, run locally in a Web Worker.
 *
 * This is the engine that makes the plugin usable on a phone. Android's
 * WebView does not give plugins access to the system text-to-speech engine, and
 * a community plugin cannot add native code, so the only route to good on-device
 * speech is to run the model in the WebView itself.
 *
 * Model files live in the vault rather than in the plugin folder, so they
 * survive plugin updates. The bundled onnxruntime WASM does live in the plugin
 * folder, since it ships with the code.
 */

const KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const SAMPLE_RATE = 24000;

/** Files that must be present for the engine to run. */
const REQUIRED_FILES = ["config.json", "tokenizer.json"];

export type KokoroDtype = "fp32" | "fp16" | "q8" | "q4" | "q4f16";

export interface WeightsVariant {
	path: string;
	dtype: KokoroDtype;
	/** Download size, for a settings page that has to justify itself. */
	sizeMb: number;
	label: string;
	description: string;
}

/**
 * The two weight files worth downloading, and why.
 *
 * Quantisation is not a straight size-for-quality trade here. The int8 build
 * is the smallest, but onnxruntime's WASM backend runs it through dynamic
 * quantisation ops that are far slower than the 4-bit-with-fp16 build:
 * measured on a desktop CPU with four threads, int8 synthesises at about 2.5x
 * slower than real time while q4f16 runs at roughly 1x, which is the
 * difference between a pause after every sentence and continuous speech. So
 * the smaller file is kept for phones, where the download and the memory
 * ceiling matter more than throughput, and the faster one is the desktop
 * default.
 */
export const KOKORO_WEIGHTS: Record<"gpu" | "fast" | "small", WeightsVariant> = {
	gpu: {
		path: "onnx/model.onnx",
		dtype: "fp32",
		sizeMb: 326,
		label: "GPU (fp32)",
		description:
			"Roughly ten times faster than playback on a discrete GPU, and useless without one.",
	},
	fast: {
		path: "onnx/model_q4f16.onnx",
		dtype: "q4f16",
		sizeMb: 155,
		label: "Fast (q4f16)",
		description: "About real-time on a desktop CPU. The right choice unless space is tight.",
	},
	small: {
		path: "onnx/model_quantized.onnx",
		dtype: "q8",
		sizeMb: 92,
		label: "Small (q8)",
		description: "Smaller download, noticeably slower to synthesise. Meant for phones.",
	},
};

/** Which weights to reach for first. Resolved from settings and hardware. */
export type WeightsPreference = "gpu" | "fast" | "small";

const ALL_WEIGHTS: Array<{ path: string; dtype: KokoroDtype }> = [
	KOKORO_WEIGHTS.gpu,
	KOKORO_WEIGHTS.fast,
	KOKORO_WEIGHTS.small,
	{ path: "onnx/model_fp16.onnx", dtype: "fp16" },
	{ path: "onnx/model_q4.onnx", dtype: "q4" },
];

/**
 * What this machine's GPU can actually do.
 *
 * Three different answers hide behind "does WebGPU work": the API can be
 * missing, it can be present with no adapter behind it, and an adapter can
 * exist without the half-precision support that the smaller float builds
 * need. They lead to different weights, so they are probed rather than
 * assumed. Measured case in point: Chromium on Linux with an NVIDIA card
 * exposes `navigator.gpu`, returns no adapter unless the browser was started
 * with the Vulkan backend enabled, and even then reports no `shader-f16`.
 */
export interface GpuReport {
	/** An adapter was handed over, so WebGPU can really be used. */
	usable: boolean;
	/** Adapter supports `shader-f16`, so half-precision weights will load. */
	f16: boolean;
	/** Human-readable adapter description, or why there is none. */
	detail: string;
}

export async function probeGpu(): Promise<GpuReport> {
	const gpu = (
		navigator as Navigator & {
			gpu?: {
				requestAdapter(): Promise<{
					features?: { has(name: string): boolean };
					info?: { vendor?: string; architecture?: string };
					isFallbackAdapter?: boolean;
				} | null>;
			};
		}
	).gpu;
	if (!gpu) {
		return { usable: false, f16: false, detail: "This build has no WebGPU support." };
	}
	try {
		const adapter = await gpu.requestAdapter();
		if (!adapter) {
			return {
				usable: false,
				f16: false,
				detail:
					"WebGPU is present but no adapter was offered. On Linux, Obsidian has to be " +
					"started with --enable-features=Vulkan for the GPU to be visible.",
			};
		}
		const name = [adapter.info?.vendor, adapter.info?.architecture]
			.filter(Boolean)
			.join(" ");

		// A software adapter is a trap, not a GPU. Chromium hands one over
		// when WebGPU is forced on without a working Vulkan backend, and
		// rasterising a neural net on SwiftShader is slower than the threaded
		// WASM build we would otherwise have used, so this counts as "no GPU".
		const software =
			adapter.isFallbackAdapter === true ||
			/swiftshader|llvmpipe|lavapipe|software/i.test(name);
		if (software) {
			return {
				usable: false,
				f16: false,
				detail: `Only a software renderer is available (${name || "unknown"}), which is slower than the CPU build.`,
			};
		}

		const f16 = adapter.features?.has("shader-f16") ?? false;
		return {
			usable: true,
			f16,
			detail: name ? `${name}${f16 ? "" : ", no shader-f16"}` : "GPU adapter available",
		};
	} catch (err) {
		return {
			usable: false,
			f16: false,
			detail: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Weights to try, best first, for a given backend.
 *
 * Whatever is already on disk wins over what we would have picked: a user who
 * downloaded one build should not be told the engine is unavailable because a
 * different one is missing. The GPU list is short on purpose. Integer builds
 * fall back to the CPU there, and without `shader-f16` the half-precision
 * files will not load at all, so a GPU with no float32 build on disk is
 * better served by dropping back to the CPU entirely.
 */
function weightsOrder(device: "wasm" | "webgpu", preference: WeightsPreference, f16 = false) {
	const first: string[] =
		device === "webgpu"
			? f16
				? ["onnx/model_fp16.onnx", KOKORO_WEIGHTS.gpu.path]
				: [KOKORO_WEIGHTS.gpu.path]
			: preference === "small"
				? [KOKORO_WEIGHTS.small.path, KOKORO_WEIGHTS.fast.path]
				: [KOKORO_WEIGHTS.fast.path, KOKORO_WEIGHTS.small.path];

	if (device === "webgpu") {
		// Only GPU-loadable builds, so a missing one means "use the CPU"
		// rather than "load something the GPU will refuse".
		return ALL_WEIGHTS.filter((w) => first.includes(w.path)).sort(
			(a, b) => first.indexOf(a.path) - first.indexOf(b.path),
		);
	}

	return [...ALL_WEIGHTS].sort((a, b) => {
		const ai = first.indexOf(a.path);
		const bi = first.indexOf(b.path);
		return (ai === -1 ? first.length : ai) - (bi === -1 ? first.length : bi);
	});
}

/** Every weights file name, for install checks. */
export const KOKORO_WEIGHT_PATHS = ALL_WEIGHTS.map((w) => w.path);

export interface KokoroOptions {
	/** Which backend to ask for. The worker falls back if it cannot be had. */
	device: DeviceRequest;
	/** Upper bound on WASM threads; the worker drops to 1 if they fail. */
	threads: number;
	/** Which weights build to prefer when more than one is on disk. */
	weights: WeightsPreference;
}

const DEFAULT_OPTIONS: KokoroOptions = { device: "auto", threads: 4, weights: "fast" };

/** Vault-relative path of the style vector for a voice id like `kokoro:af_heart`. */
export function voiceFilePath(voiceId: string): string {
	return `voices/${voiceId.replace(/^kokoro:/, "")}.bin`;
}

const CAPABILITIES: EngineCapabilities = {
	voices: true,
	timing: "measured",
	rate: true,
	// Kokoro has no pitch control; the voice files carry the style instead.
	pitch: false,
	desktopOnly: false,
	// The worker hands back a finished buffer, so the element the player pauses
	// is the one actually making the sound.
	pause: true,
	resume: true,
	// The worker returns audio plus word timings and nothing coarser.
	sentenceBoundary: false,
	// Every voice is a file in the vault and the worker refuses remote fetches,
	// so "does this voice need the network" has a definite answer: no.
	offlineStatus: true,
	// Kokoro returns samples; the player decides how fast to play them.
	ownsPlayback: false,
};

interface KokoroVoice {
	file: string;
	name: string;
	lang: string;
	gender: "male" | "female" | "neutral";
}

/** The voices shipped with Kokoro. `af`/`am` are en-US, `bf`/`bm` en-GB. */
const VOICES: KokoroVoice[] = [
	{ file: "af_heart", name: "Heart", lang: "en-US", gender: "female" },
	{ file: "af_alloy", name: "Alloy", lang: "en-US", gender: "female" },
	{ file: "af_aoede", name: "Aoede", lang: "en-US", gender: "female" },
	{ file: "af_bella", name: "Bella", lang: "en-US", gender: "female" },
	{ file: "af_jessica", name: "Jessica", lang: "en-US", gender: "female" },
	{ file: "af_kore", name: "Kore", lang: "en-US", gender: "female" },
	{ file: "af_nicole", name: "Nicole", lang: "en-US", gender: "female" },
	{ file: "af_nova", name: "Nova", lang: "en-US", gender: "female" },
	{ file: "af_river", name: "River", lang: "en-US", gender: "female" },
	{ file: "af_sarah", name: "Sarah", lang: "en-US", gender: "female" },
	{ file: "af_sky", name: "Sky", lang: "en-US", gender: "female" },
	{ file: "am_adam", name: "Adam", lang: "en-US", gender: "male" },
	{ file: "am_echo", name: "Echo", lang: "en-US", gender: "male" },
	{ file: "am_eric", name: "Eric", lang: "en-US", gender: "male" },
	{ file: "am_fenrir", name: "Fenrir", lang: "en-US", gender: "male" },
	{ file: "am_liam", name: "Liam", lang: "en-US", gender: "male" },
	{ file: "am_michael", name: "Michael", lang: "en-US", gender: "male" },
	{ file: "am_onyx", name: "Onyx", lang: "en-US", gender: "male" },
	{ file: "am_puck", name: "Puck", lang: "en-US", gender: "male" },
	{ file: "am_santa", name: "Santa", lang: "en-US", gender: "male" },
	{ file: "bf_alice", name: "Alice", lang: "en-GB", gender: "female" },
	{ file: "bf_emma", name: "Emma", lang: "en-GB", gender: "female" },
	{ file: "bf_isabella", name: "Isabella", lang: "en-GB", gender: "female" },
	{ file: "bf_lily", name: "Lily", lang: "en-GB", gender: "female" },
	{ file: "bm_daniel", name: "Daniel", lang: "en-GB", gender: "male" },
	{ file: "bm_fable", name: "Fable", lang: "en-GB", gender: "male" },
	{ file: "bm_george", name: "George", lang: "en-GB", gender: "male" },
	{ file: "bm_lewis", name: "Lewis", lang: "en-GB", gender: "male" },
];

export interface ModelStore {
	/** Absolute path of the model directory, in Obsidian's filesystem form. */
	dir: string;
	/** Prefix the worker resolves model requests against; never fetched directly. */
	modelBase: string;
	/** Vault path of the bundled worker script. */
	workerPath: string;
	/** Vault path of one bundled onnxruntime file. */
	ortFile(name: string): string;
	/** Read any file the vault adapter knows about, including plugin files. */
	readPluginFile(vaultPath: string): Promise<ArrayBuffer>;
	exists(relativePath: string): Promise<boolean>;
	read(relativePath: string): Promise<ArrayBuffer>;
	/** Bytes for the model weights, or null if not downloaded yet. */
	readOptional(relativePath: string): Promise<ArrayBuffer | null>;
}

interface Pending {
	resolve: (value: { pcm: Float32Array; sampleRate: number }) => void;
	reject: (err: Error) => void;
}

export class KokoroEngine implements SpeechEngine {
	readonly id: EngineId = "kokoro";
	readonly label = "Kokoro (local neural)";
	readonly capabilities = CAPABILITIES;

	private worker: Worker | null = null;
	private ready: Promise<void> | null = null;
	private prepared = false;
	private voice: VoiceInfo;
	private pending = new Map<number, Pending>();
	private nextId = 1;
	private progressCb: ((loaded: number, total: number) => void) | null = null;
	private infoCb: ((message: string) => void) | null = null;
	private blobs = new Map<string, string>();
	private options: KokoroOptions;
	/** Voice files already handed to the worker, so each is sent once. */
	private sentVoices = new Set<string>();
	/** Backend the worker actually settled on, once it is running. */
	private runtime: { device: string; threads: number } | null = null;

	constructor(
		private readonly store: ModelStore,
		options: Partial<KokoroOptions> = {},
	) {
		this.options = { ...DEFAULT_OPTIONS, ...options };
		const first = VOICES[0]!;
		this.voice = {
			id: `kokoro:${first.file}`,
			name: `${first.name} (${first.lang})`,
			lang: first.lang,
			gender: first.gender,
			engineId: "kokoro",
		};
	}

	onProgress(cb: (loaded: number, total: number) => void): void {
		this.progressCb = cb;
	}

	/** Diagnostic messages from the worker: which backend, why one failed. */
	onInfo(cb: (message: string) => void): void {
		this.infoCb = cb;
	}

	/**
	 * Apply settings that only take effect at load time.
	 *
	 * Changing the backend means a different onnxruntime session, so a running
	 * worker is thrown away rather than reconfigured. Doing nothing when
	 * nothing changed keeps a settings-tab redraw from costing a reload.
	 */
	setOptions(next: Partial<KokoroOptions>): void {
		const merged = { ...this.options, ...next };
		const changed =
			merged.device !== this.options.device ||
			merged.threads !== this.options.threads ||
			merged.weights !== this.options.weights;
		this.options = merged;
		if (changed && (this.worker || this.ready)) void this.dispose();
	}

	runtimeInfo(): string | null {
		if (!this.runtime) return null;
		return this.runtime.device === "webgpu"
			? "GPU (WebGPU)"
			: `CPU (WASM, ${this.runtime.threads} thread${this.runtime.threads === 1 ? "" : "s"})`;
	}

	isPrepared(): boolean {
		return this.prepared;
	}

	/** Load the model now rather than on the first sentence. */
	async prepare(): Promise<void> {
		await this.load();
	}

	async isAvailable(): Promise<boolean> {
		for (const file of REQUIRED_FILES) {
			if (!(await this.store.exists(file))) return false;
		}
		// The weights are the big one; any build we know how to load will do.
		for (const candidate of ALL_WEIGHTS) {
			if (await this.store.exists(candidate.path)) return true;
		}
		return false;
	}

	/** Which weights build is on disk and would be used, if any. */
	async installedWeights(): Promise<WeightsVariant | { path: string } | null> {
		const plan = await this.planBackend().catch(() => null);
		if (!plan) return null;
		return (
			Object.values(KOKORO_WEIGHTS).find((w) => w.path === plan.weights.path) ??
			plan.weights
		);
	}

	/**
	 * What this engine would load right now, without loading it.
	 *
	 * The answer depends on the GPU and on what has been downloaded, so it
	 * cannot be derived from settings alone, and a settings page that guessed
	 * would be wrong exactly when it matters.
	 */
	async plannedBackend(): Promise<{ device: "wasm" | "webgpu"; path: string } | null> {
		const plan = await this.planBackend().catch(() => null);
		return plan ? { device: plan.device, path: plan.weights.path } : null;
	}

	/**
	 * Decide backend and weights together, from what the hardware offers and
	 * what is actually downloaded.
	 *
	 * The GPU is only worth taking if a build it can load is present: falling
	 * back to the CPU with weights that exist beats failing on a GPU with
	 * weights that do not.
	 */
	private async planBackend(): Promise<{
		device: "wasm" | "webgpu";
		weights: { path: string; dtype: KokoroDtype };
		why: string;
	}> {
		const wantGpu = this.options.device === "webgpu" || this.options.device === "auto";
		if (wantGpu) {
			const gpu = await probeGpu();
			if (gpu.usable) {
				for (const candidate of weightsOrder("webgpu", this.options.weights, gpu.f16)) {
					if (await this.store.exists(candidate.path)) {
						return {
							device: "webgpu",
							weights: candidate,
							why: `GPU (${gpu.detail}) with ${candidate.path}`,
						};
					}
				}
				this.infoCb?.(
					`GPU available (${gpu.detail}) but no GPU-loadable weights are downloaded; using the CPU`,
				);
			} else {
				this.infoCb?.(`no GPU: ${gpu.detail}`);
			}
		}

		const preference = this.options.weights === "gpu" ? "fast" : this.options.weights;
		for (const candidate of weightsOrder("wasm", preference)) {
			if (await this.store.exists(candidate.path)) {
				return { device: "wasm", weights: candidate, why: `CPU with ${candidate.path}` };
			}
		}
		throw new Error("Kokoro weights are missing. Download them from settings.");
	}

	async listVoices(): Promise<VoiceInfo[]> {
		return VOICES.map((v) => ({
			id: `kokoro:${v.file}`,
			name: `${v.name} (${v.lang})`,
			lang: v.lang,
			gender: v.gender,
			engineId: "kokoro" as const,
		}));
	}

	/**
	 * Switch voice without reloading the model.
	 *
	 * A Kokoro voice is a 512KB style vector, not a model, so a running worker
	 * only needs the extra bytes. Reloading for a voice change would cost the
	 * full model load for no reason.
	 */
	async selectVoice(voice: VoiceInfo): Promise<void> {
		this.voice = voice;
		if (!this.worker) return;
		await this.sendVoice(voice);
	}

	private async sendVoice(voice: VoiceInfo): Promise<void> {
		const path = voiceFilePath(voice.id);
		if (this.sentVoices.has(path)) return;
		const bytes = await this.store.readOptional(path);
		if (!bytes) {
			throw new Error(
				`Voice file ${path} is not downloaded. Pick it in settings to fetch it.`,
			);
		}
		this.sentVoices.add(path);
		this.worker?.postMessage({ type: "voice", path, bytes } satisfies ToWorker, [bytes]);
	}

	/**
	 * Read a plugin file and expose it as a same-origin blob URL.
	 *
	 * Cache within this engine instance until disposal: the worker imports the
	 * glue module after construction, so its URL must remain valid until then.
	 */
	private async blobFor(vaultPath: string, type: string): Promise<string> {
		const cached = this.blobs.get(vaultPath);
		if (cached) return cached;
		const bytes = await this.store.readPluginFile(vaultPath);
		const url = URL.createObjectURL(new Blob([bytes], { type }));
		this.blobs.set(vaultPath, url);
		return url;
	}

	/**
	 * Load the model, giving up on threads rather than on loading.
	 *
	 * The worker already falls back from a thread pool to a single thread when
	 * onnxruntime refuses to start one. This is the outer net for the case
	 * that fallback cannot catch: a nested worker that fails asynchronously
	 * surfaces as an uncaught error in the worker, not as a rejection from the
	 * load we are awaiting. Reported failures there have no stack worth
	 * reading, so the only honest response is to retry the boring way.
	 */
	async load(): Promise<void> {
		if (this.ready) return await this.ready;
		try {
			await this.loadOnce();
		} catch (err) {
			if (this.options.threads <= 1) throw err;
			this.infoCb?.(
				`threaded load failed (${err instanceof Error ? err.message : String(err)}); retrying single-threaded`,
			);
			this.options = { ...this.options, threads: 1 };
			await this.dispose();
			await this.loadOnce();
		}
	}

	private async loadOnce(): Promise<void> {
		if (this.ready) return await this.ready;

		this.ready = (async () => {
			const files: ModelFile[] = [];
			for (const path of ["config.json", "tokenizer.json", "tokenizer_config.json"]) {
				const bytes = await this.store.readOptional(path);
				if (bytes) files.push({ path, bytes });
			}

			// Backend and weights are one decision, not two. The GPU can only
			// load some builds, so choosing it without checking what is on
			// disk would mean loading nothing at all.
			const plan = await this.planBackend();
			this.infoCb?.(`backend choice: ${plan.why}`);

			const weights = await this.store.readOptional(plan.weights.path);
			if (!weights) {
				throw new Error("Kokoro weights are missing. Download them from settings.");
			}
			files.push({ path: plan.weights.path, bytes: weights });
			const dtype = plan.weights.dtype;

			const voicePath = voiceFilePath(this.voice.id);
			const voiceBytes = await this.store.readOptional(voicePath);
			if (!voiceBytes) {
				throw new Error(
					`Voice file ${voicePath} is not downloaded. Pick a voice in settings to fetch it.`,
				);
			}
			files.push({ path: voicePath, bytes: voiceBytes });
			this.sentVoices = new Set([voicePath]);

			// The worker script and the onnxruntime binary are turned into blob
			// URLs rather than loaded from a path. A blob URL inherits this
			// document's origin, so the Worker is same-origin, whereas any
			// `app://<vault-hash>` resource URL Obsidian hands out is a
			// different origin and cannot construct a Worker at all.
			const workerBlob = await this.blobFor(this.store.workerPath, "text/javascript");
			const ortBlob = await this.blobFor(
				this.store.ortFile("ort-wasm-simd-threaded.jsep.mjs"),
				"text/javascript",
			);
			const wasmBlob = await this.blobFor(
				this.store.ortFile("ort-wasm-simd-threaded.jsep.wasm"),
				"application/wasm",
			);

			const worker = new Worker(workerBlob, { type: "classic" });
			this.worker = worker;

			const booted = new Promise<void>((resolve, reject) => {
				worker.addEventListener("message", (event: MessageEvent<FromWorker>) => {
					const msg = event.data;
					switch (msg.type) {
						case "progress":
							this.progressCb?.(msg.loaded, msg.total);
							break;
						case "info":
							this.infoCb?.(msg.message);
							break;
						case "ready":
							this.runtime = { device: msg.device, threads: msg.threads };
							this.infoCb?.(`kokoro ready on ${this.runtimeInfo()}`);
							resolve();
							break;
						case "audio": {
							const entry = this.pending.get(msg.id);
							if (entry) {
								this.pending.delete(msg.id);
								entry.resolve({ pcm: msg.pcm, sampleRate: msg.sampleRate });
							}
							break;
						}
						case "error": {
							if (msg.id !== undefined) {
								const entry = this.pending.get(msg.id);
								if (entry) {
									this.pending.delete(msg.id);
									entry.reject(new Error(msg.message));
								}
							} else {
								const err = new Error(msg.message);
								if (msg.stack) (err as Error & { workerStack?: string }).workerStack = msg.stack;
								reject(err);
							}
							break;
						}
					}
				});
				worker.addEventListener("error", (event) => {
					reject(new Error(event.message || "Kokoro worker failed to start"));
				});
			});

			const message: ToWorker = {
				type: "init",
				modelId: KOKORO_MODEL_ID,
				modelBase: this.store.modelBase,
				// The runtime is addressed by explicit URLs rather than a
				// directory prefix, because the glue module is loaded with a
				// dynamic import that no fetch shim can intercept. onnxruntime
				// accepts an object here and uses each URL verbatim.
				wasmPaths: { mjs: ortBlob, wasm: wasmBlob },
				files,
				dtype,
				// Already resolved against the adapter and what is downloaded;
				// the worker's own probe is the backstop, not the decision.
				device: plan.device,
				threads: this.options.threads,
			};
			worker.postMessage(
				message,
				files.map((f) => f.bytes),
			);

			await booted;
		})();

		try {
			await this.ready;
			this.prepared = true;
		} catch (err) {
			this.ready = null;
			this.prepared = false;
			this.worker?.terminate();
			this.worker = null;
			this.sentVoices.clear();
			throw err;
		}
	}

	/**
	 * Drop synthesis that nobody is waiting for any more.
	 *
	 * Rejecting the caller's promises is only half of it: without telling the
	 * worker, its queue keeps grinding through abandoned sentences and the
	 * next thing the user actually asked for waits behind all of them.
	 */
	cancelPending(): void {
		for (const entry of this.pending.values()) {
			entry.reject(new DOMException("Aborted", "AbortError"));
		}
		this.pending.clear();
		this.worker?.postMessage({ type: "cancel" } satisfies ToWorker);
	}

	async synthesize(req: SynthRequest, signal: AbortSignal): Promise<SynthResult> {
		if (signal.aborted) throw new DOMException("Aborted", "AbortError");
		// Prefetch starts several requests at once. Every caller must await the
		// shared boot promise, not just the caller that started loading.
		await this.load();
		// A voice picked after the model loaded still has to reach the worker.
		await this.sendVoice(this.voice);
		if (signal.aborted) throw new DOMException("Aborted", "AbortError");

		const id = this.nextId++;
		const pcm = await new Promise<{ pcm: Float32Array; sampleRate: number }>(
			(resolve, reject) => {
				const onAbort = (): void => {
					this.pending.delete(id);
					reject(new DOMException("Aborted", "AbortError"));
				};
				signal.addEventListener("abort", onAbort, { once: true });

				this.pending.set(id, {
					resolve: (value) => {
						signal.removeEventListener("abort", onAbort);
						resolve(value);
					},
					reject: (err) => {
						signal.removeEventListener("abort", onAbort);
						reject(err);
					},
				});

				const message: ToWorker = {
					type: "speak",
					id,
					text: req.chunk.text,
					voice: this.voice.id.replace(/^kokoro:/, ""),
					rate: req.rate || 1,
				};
				this.worker?.postMessage(message);
			},
		);

		const sampleRate = pcm.sampleRate || SAMPLE_RATE;
		const wav = pcmToWav(float32ToPcm16(pcm.pcm), sampleRate);
		const info = durationOf(wav, sampleRate);
		return {
			kind: "buffer",
			audio: wav,
			sampleRate,
			durationMs: info,
			words: allocateWordTimings(req.chunk, info, req.rate || 1),
		};
	}

	async dispose(): Promise<void> {
		for (const entry of this.pending.values()) {
			entry.reject(new Error("Kokoro engine disposed"));
		}
		this.pending.clear();
		try {
			this.worker?.postMessage({ type: "dispose" } satisfies ToWorker);
		} catch {
			// worker may already be gone
		}
		this.worker?.terminate();
		this.worker = null;
		this.ready = null;
		this.prepared = false;
		this.runtime = null;
		this.sentVoices.clear();
		for (const url of this.blobs.values()) URL.revokeObjectURL(url);
		this.blobs.clear();
	}
}

/** Kokoro emits float samples; browsers want 16-bit PCM. */
function float32ToPcm16(input: Float32Array): ArrayBuffer {
	const out = new Int16Array(input.length);
	for (let i = 0; i < input.length; i++) {
		const clamped = Math.max(-1, Math.min(1, input[i]!));
		out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
	}
	return out.buffer;
}

function durationOf(wav: ArrayBuffer, sampleRate: number): number {
	// 16-bit mono: bytes per second is sampleRate * 2.
	const payload = wav.byteLength - 44;
	return Math.max(0, (payload / (sampleRate * 2)) * 1000);
}

export { KOKORO_MODEL_ID, VOICES as KOKORO_VOICES };
