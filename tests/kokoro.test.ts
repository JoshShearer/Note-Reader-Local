/**
 * Which Kokoro weights file gets loaded, and as which dtype.
 *
 * This pairing is the one place where a silent mistake is expensive: the file
 * name and the dtype are passed separately to transformers.js, so picking
 * `model_quantized.onnx` while claiming `q4f16` produces either a crash deep
 * in onnxruntime or noise instead of speech. The choice also has a large
 * performance consequence (int8 measured about 2.5x slower to synthesise than
 * q4f16 on a desktop CPU), so "any weights file will do" is not good enough.
 */

import { gzipSync } from "node:zlib";
import { Buffer } from "node:buffer";
import {
	KokoroEngine,
	KOKORO_WEIGHTS,
	KOKORO_MODEL_METADATA,
	KOKORO_RELOAD_REQUIRED,
	VOICE_FILE_SIZE_BYTES,
	probeGpu,
	voiceFilePath,
} from "../src/engines/onnx/kokoro.ts";
import type { ModelStore } from "../src/engines/onnx/kokoro.ts";
import { RUNTIME_FILES } from "../src/engines/onnx/runtime.ts";
import type { SpeechChunk, SynthRequest } from "../src/audio/types.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
	if (cond) console.log(`  ok   ${name}`);
	else {
		failures += 1;
		console.log(`  FAIL ${name} ${detail}`);
	}
}

/** A model store backed by a set of file names that "exist". */
function fakeStore(present: string[]): ModelStore {
	const has = (p: string): boolean => present.includes(p);
	return {
		dir: "models",
		modelBase: "local-model://kokoro/",
		workerPath: "plugin/kokoro-worker.js",
		async readPluginFile() {
			return new ArrayBuffer(0);
		},
		async exists(p: string) {
			return has(p);
		},
		async read() {
			return new ArrayBuffer(0);
		},
		async readOptional(p: string) {
			return has(p) ? new ArrayBuffer(0) : null;
		},
	};
}

const FAST = KOKORO_WEIGHTS.fast.path;
const SMALL = KOKORO_WEIGHTS.small.path;
const CORE = ["config.json", "tokenizer.json"];

console.log("the weights build is chosen by preference, not by luck");
{
	const both = [...CORE, FAST, SMALL];

	const fast = new KokoroEngine(fakeStore(both), { device: "wasm", weights: "fast" });
	check(
		"prefers the fast build when asked for speed",
		(await fast.installedWeights())?.path === FAST,
		JSON.stringify(await fast.installedWeights()),
	);

	const small = new KokoroEngine(fakeStore(both), { device: "wasm", weights: "small" });
	check(
		"prefers the small build when asked for size",
		(await small.installedWeights())?.path === SMALL,
		JSON.stringify(await small.installedWeights()),
	);
}

console.log("whatever is actually downloaded wins over the preference");
{
	// Someone who installed only the small build must not be told the engine
	// is unavailable because the preferred build is missing.
	const engine = new KokoroEngine(fakeStore([...CORE, SMALL]), {
		device: "wasm",
		weights: "fast",
	});
	check("falls back to the installed build", (await engine.installedWeights())?.path === SMALL);
	check("reports itself available", (await engine.isAvailable()).available);
}

console.log("no weights at all is not available (NRL-25: distinguishable reason)");
let weightsMissingReason = "";
{
	const engine = new KokoroEngine(fakeStore(CORE), { device: "wasm", weights: "fast" });
	check("no build found", (await engine.installedWeights()) === null);
	const result = await engine.isAvailable();
	check("not available without weights", result.available === false);
	if (!result.available) weightsMissingReason = result.reason;
	check(
		"reason is the exact wording thrown elsewhere in this file (kokoro.ts's own irony fix)",
		weightsMissingReason === "Kokoro weights are missing. Download them from settings.",
		weightsMissingReason,
	);
}

console.log("missing core files are not papered over by weights (NRL-25: distinguishable reason)");
{
	const engine = new KokoroEngine(fakeStore([FAST]), { device: "wasm", weights: "fast" });
	const result = await engine.isAvailable();
	check("tokenizer and config are required", result.available === false);
	check(
		"reason is DIFFERENT from the weights-missing reason",
		!result.available && result.reason !== weightsMissingReason && result.reason.length > 0,
		!result.available ? result.reason : "available:true",
	);
}

console.log("a store that throws is reported, not propagated (NRL-25)");
{
	const failingStore: ModelStore = {
		dir: "models",
		modelBase: "local-model://kokoro/",
		workerPath: "plugin/kokoro-worker.js",
		async readPluginFile() {
			return new ArrayBuffer(0);
		},
		async exists() {
			throw new Error("EIO reading vault adapter");
		},
		async read() {
			return new ArrayBuffer(0);
		},
		async readOptional() {
			return null;
		},
	};
	const engine = new KokoroEngine(failingStore, { device: "wasm", weights: "fast" });
	const result = await engine.isAvailable();
	check("throwing store: not available, does not propagate", result.available === false);
	check(
		"throwing store: reason carries the thrown message",
		!result.available && result.reason.includes("EIO reading vault adapter"),
		!result.available ? result.reason : "available:true",
	);
}

/**
 * Pretend this machine has (or has not) a usable GPU.
 *
 * The real probe asks for an adapter, which node has no notion of, and the
 * interesting cases are precisely the awkward ones: an adapter that exists but
 * lacks `shader-f16` (what a Chromium-on-NVIDIA machine actually reports), and
 * an adapter that exists while no GPU-loadable weights are downloaded.
 */
function withGpu(options: { f16: boolean; software?: boolean } | null): void {
	const gpu =
		options === null
			? undefined
			: {
					requestAdapter: async () => ({
						features: new Set(options.f16 ? ["shader-f16"] : []),
						info: options.software
							? { vendor: "google", architecture: "swiftshader" }
							: { vendor: "nvidia", architecture: "ampere" },
					}),
				};
	Object.defineProperty(globalThis, "navigator", {
		value: { gpu, hardwareConcurrency: 8 },
		configurable: true,
		writable: true,
	});
}

const GPU = KOKORO_WEIGHTS.gpu.path;

console.log("a GPU is used only with weights it can actually load");
{
	withGpu({ f16: false });

	// The measured case: an adapter with no shader-f16. Half-precision builds
	// will not load on it, so float32 is the only GPU-usable file.
	const withFp32 = new KokoroEngine(fakeStore([...CORE, GPU, FAST]), {
		device: "auto",
		weights: "fast",
	});
	check(
		"float32 build runs on the GPU",
		JSON.stringify(await withFp32.plannedBackend()) ===
			JSON.stringify({ device: "webgpu", path: GPU }),
		JSON.stringify(await withFp32.plannedBackend()),
	);

	// Same GPU, but only CPU builds downloaded: taking the GPU here would
	// fail to load anything, so the CPU with real weights is the right answer.
	const withoutFp32 = new KokoroEngine(fakeStore([...CORE, FAST]), {
		device: "auto",
		weights: "fast",
	});
	check(
		"falls back to the CPU when no GPU build is downloaded",
		JSON.stringify(await withoutFp32.plannedBackend()) ===
			JSON.stringify({ device: "wasm", path: FAST }),
		JSON.stringify(await withoutFp32.plannedBackend()),
	);
}

console.log("an adapter with shader-f16 can use the half-precision build");
{
	withGpu({ f16: true });
	const engine = new KokoroEngine(fakeStore([...CORE, "onnx/model_fp16.onnx", GPU]), {
		device: "auto",
		weights: "fast",
	});
	check(
		"fp16 preferred when supported",
		(await engine.plannedBackend())?.path === "onnx/model_fp16.onnx",
		JSON.stringify(await engine.plannedBackend()),
	);
}

console.log("a software renderer does not count as a GPU");
{
	// Forcing WebGPU on without a working Vulkan backend yields SwiftShader.
	// Running the model there is slower than the threaded CPU build, so it
	// must not be mistaken for acceleration.
	withGpu({ f16: false, software: true });
	const report = await probeGpu();
	check("reported unusable", !report.usable, JSON.stringify(report));
	check("says why", report.detail.toLowerCase().includes("software"), report.detail);

	const engine = new KokoroEngine(fakeStore([...CORE, GPU, FAST]), {
		device: "auto",
		weights: "fast",
	});
	const plan = await engine.plannedBackend();
	check("stays on the CPU", plan?.device === "wasm", JSON.stringify(plan));
}

console.log("no GPU means the CPU build, whatever the setting says");
{
	withGpu(null);
	const engine = new KokoroEngine(fakeStore([...CORE, GPU, FAST]), {
		device: "webgpu",
		weights: "gpu",
	});
	const plan = await engine.plannedBackend();
	check("device is wasm", plan?.device === "wasm", JSON.stringify(plan));
	check("uses a CPU build", plan?.path === FAST, JSON.stringify(plan));
}

console.log("voice ids map to voice files");
{
	check("prefixed id", voiceFilePath("kokoro:af_heart") === "voices/af_heart.bin");
	check("bare id", voiceFilePath("bm_george") === "voices/bm_george.bin");
}

console.log("NRL-26: every kokoro voice reports local: true, requiresNetwork: false");
{
	// Genuinely true for every voice: kokoro.worker.ts's fetch shim plus
	// isRemote/assertLocal reject any non-blob URL at runtime. No network
	// code path exists.
	const engine = new KokoroEngine(fakeStore([]));
	const voices = await engine.listVoices();
	check("has voices", voices.length > 0, `got ${voices.length}`);
	check("every voice is local: true", voices.every((v) => v.local === true), JSON.stringify(voices.map((v) => v.local)));
	check("every voice is requiresNetwork: false", voices.every((v) => v.requiresNetwork === false), JSON.stringify(voices.map((v) => v.requiresNetwork)));
}

console.log(
	"NRL-33: KOKORO_MODEL_METADATA and VOICE_FILE_SIZE_BYTES are pinned to what was actually measured this session",
);
{
	check(
		"model metadata name is the canonical onnx-community id",
		KOKORO_MODEL_METADATA.name === "onnx-community/Kokoro-82M-v1.0-ONNX",
		KOKORO_MODEL_METADATA.name,
	);
	check(
		"model metadata language is English (US, UK) only",
		KOKORO_MODEL_METADATA.language === "English (US, UK)",
		KOKORO_MODEL_METADATA.language,
	);
	check(
		"model metadata license matches kokoro-js's own package.json",
		KOKORO_MODEL_METADATA.license === "Apache-2.0",
		KOKORO_MODEL_METADATA.license,
	);
	check(
		"voice file size is exactly 522240 bytes, measured from kokoro-js's voices/*.bin",
		VOICE_FILE_SIZE_BYTES === 522240,
		String(VOICE_FILE_SIZE_BYTES),
	);
}

/**
 * NRL-101: a reported synthesis failure must not poison the session.
 *
 * This block is the bare-Node half of rule 12 for this ticket, and what it
 * reproduces is the BLAST RADIUS, not the trigger. The initial
 * `OrtRun ... invalid expand shape` crash happened once in ~15 minutes on one
 * Android device and is not reproduced anywhere; what is reproduced here is
 * that after ANY reported speak failure the engine hands the next read the
 * same Worker, the same onnxruntime session and no indication that anything
 * needs restarting.
 *
 * The seam had no precedent in this file: every block above constructs the
 * real engine against `fakeStore()` and never calls `load()` or
 * `synthesize()`, so the four globals the load path needs are installed here
 * from scratch and restored in a `finally`. The engine only ever reads
 * `event.data` off a worker message, so a plain `{ data: msg }` object is a
 * sufficient stand-in for a real `MessageEvent`; no `MessageEvent` subclass
 * and no `structuredClone` is involved, which is also why the fake can ignore
 * the transfer list it is handed.
 */
console.log("NRL-101: a reported synthesis failure recycles the worker instead of poisoning it");
{
	/** The real message from the one observed crash (NRL-101's report). */
	const ORT_TEXT =
		"failed to call OrtRun(). ERROR_CODE: 2, ERROR_MESSAGE: Non-zero status code returned " +
		"while running Expand node. Name:'/encoder/bert/Expand' Status Message: invalid expand shape";

	type Reply = "fail" | "ok" | "hang";
	/**
	 * How the fake answers a `speak`, keyed on the request's own text.
	 *
	 * Keyed on text rather than on a per-instance counter on purpose: the
	 * concurrency cases below need request A to fail while request B hangs on
	 * the SAME worker, and the recycled worker must then answer a third
	 * request differently again. A sequence counter restarts at 1 on the new
	 * instance and cannot express that; the text can.
	 */
	let replyFor: (text: string) => Reply = () => "fail";

	let constructions = 0;
	let terminations = 0;
	let speaksSeen: string[] = [];

	class FakeWorker {
		private listeners = new Map<string, Array<(ev: unknown) => void>>();
		readonly index: number;
		constructor(
			readonly url: string,
			readonly options?: unknown,
		) {
			constructions += 1;
			this.index = constructions;
		}
		addEventListener(type: string, fn: (ev: unknown) => void): void {
			const list = this.listeners.get(type) ?? [];
			list.push(fn);
			this.listeners.set(type, list);
		}
		removeEventListener(): void {
			/* the engine never removes a worker listener; present for shape only */
		}
		private emit(msg: unknown): void {
			// Asynchronous, as a real worker is, so the engine's promise wiring
			// is exercised rather than short-circuited.
			setTimeout(() => {
				for (const fn of this.listeners.get("message") ?? []) fn({ data: msg });
			}, 0);
		}
		postMessage(msg: { type: string; id?: number; text?: string }): void {
			if (msg.type === "init") {
				this.emit({ type: "ready", device: "wasm", threads: 1 });
				return;
			}
			if (msg.type === "speak") {
				const text = msg.text ?? "";
				speaksSeen.push(text);
				const reply = replyFor(text);
				if (reply === "hang") return;
				if (reply === "ok") {
					this.emit({
						type: "audio",
						id: msg.id,
						pcm: new Float32Array(240),
						sampleRate: 24000,
					});
					return;
				}
				this.emit({ type: "error", id: msg.id, message: ORT_TEXT });
				return;
			}
			// voice / cancel / dispose need no answer.
		}
		terminate(): void {
			terminations += 1;
			this.listeners.clear();
		}
	}

	/** A store that hands back a DISTINCT buffer per path and counts reads. */
	function recordingStore(present: string[]): ModelStore & { reads: Map<string, number> } {
		const reads = new Map<string, number>();
		const has = (p: string): boolean => present.includes(p);
		return {
			reads,
			dir: "models",
			modelBase: "local-model://kokoro/",
			workerPath: "plugin/kokoro-worker.js",
			async readPluginFile() {
				return new ArrayBuffer(0);
			},
			async exists(p: string) {
				return has(p);
			},
			async read() {
				return new ArrayBuffer(8);
			},
			async readOptional(p: string) {
				reads.set(p, (reads.get(p) ?? 0) + 1);
				// A distinct buffer per call: loadOnce hands these to
				// postMessage as a transfer list, and sharing one across files
				// would be an error in a real browser even though this fake
				// ignores the list.
				return has(p) ? new ArrayBuffer(16) : null;
			},
		};
	}

	/** gzip + digest one payload exactly as `esbuild.config.mjs` does. */
	async function packed(payload: Uint8Array<ArrayBuffer>): Promise<{ gzip: string; sha256: string }> {
		const digest = await crypto.subtle.digest("SHA-256", payload);
		return {
			gzip: Buffer.from(gzipSync(payload)).toString("base64"),
			sha256: Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(""),
		};
	}

	function chunkFor(text: string): SpeechChunk {
		return {
			id: `c-${text}`,
			sequence: 0,
			blockType: "paragraph",
			filePath: "Note.md",
			text,
			sourceIndex: Array.from(text, (_, i) => i),
			sourceStart: 0,
			sourceEnd: text.length,
		};
	}
	const req = (text: string): SynthRequest => ({ chunk: chunkFor(text), rate: 1, pitch: 0 });

	async function settle(): Promise<void> {
		for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
	}
	async function waitForSpeak(text: string): Promise<void> {
		for (let i = 0; i < 500 && !speaksSeen.includes(text); i++) {
			await new Promise((r) => setTimeout(r, 2));
		}
	}
	/** The rejection message, or a marker if it resolved after all. */
	async function failureOf(p: Promise<unknown>): Promise<string> {
		try {
			await p;
			return "<resolved>";
		} catch (err) {
			return err instanceof Error ? err.message : String(err);
		}
	}

	const PRESENT = ["config.json", "tokenizer.json", "tokenizer_config.json", FAST, "voices/af_heart.bin"];
	const saved = {
		Worker: (globalThis as Record<string, unknown>).Worker,
		code: (globalThis as Record<string, unknown>).KOKORO_WORKER_CODE,
		ort: (globalThis as Record<string, unknown>).__ORT_ASSETS__,
		fetch: globalThis.fetch,
	};
	let fetchCalls = 0;

	try {
		(globalThis as Record<string, unknown>).Worker = FakeWorker;
		// An empty inlined worker makes getWorkerBlobUrl take the base64
		// branch, so store.workerPath is never read.
		(globalThis as Record<string, unknown>).KOKORO_WORKER_CODE = btoa("");
		// A REAL two-entry pack for the jsep pair loadOnce asks for, built the
		// way the build builds it: gzip of the plain bytes, plus the digest OF
		// THE PLAIN BYTES, so unpackRuntimeFile's integrity check really runs.
		(globalThis as Record<string, unknown>).__ORT_ASSETS__ = {
			[RUNTIME_FILES[2]]: await packed(new TextEncoder().encode("// fake ort glue\n")),
			[RUNTIME_FILES[3]]: await packed(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
		};
		// Non-negotiable 6: the recycle must reuse what is on disk. A fetch
		// that throws turns any network access into a visible failure rather
		// than a silent success.
		globalThis.fetch = (async () => {
			fetchCalls += 1;
			throw new Error("NRL-101: the recycle must not fetch");
		}) as typeof fetch;
		withGpu(null);

		// ---- R1/R2/R3/R4/R5/G7/G9: one engine, three reads, every speak failing.
		{
			replyFor = () => "fail";
			constructions = 0;
			terminations = 0;
			speaksSeen = [];
			const store = recordingStore(PRESENT);
			const engine = new KokoroEngine(store, { device: "wasm", weights: "fast" });
			const ac = new AbortController();

			const first = await failureOf(engine.synthesize(req("one"), ac.signal));
			check(
				"G7 guard: the FIRST failure still carries the worker's own message, not the hint",
				first.includes("invalid expand shape"),
				first,
			);
			check("R2: a reported failure makes isPrepared() false", engine.isPrepared() === false, String(engine.isPrepared()));
			check("one worker so far", constructions === 1, `constructions=${constructions}`);

			const second = await failureOf(engine.synthesize(req("two"), ac.signal));
			check(
				"R1: the next read constructs a SECOND worker instead of reusing the poisoned one",
				constructions === 2,
				`constructions=${constructions}`,
			);
			check("the poisoned worker was terminated", terminations === 1, `terminations=${terminations}`);
			check(
				"R5: the recycled load re-reads the already-downloaded weights from the store",
				store.reads.get(FAST) === 2,
				`reads=${store.reads.get(FAST)}`,
			);
			check(
				"the second read still reports the worker's own message, the recycle having been spent on it",
				second.includes("invalid expand shape"),
				second,
			);

			const third = await failureOf(engine.synthesize(req("three"), ac.signal));
			check(
				"R3: with the recycle spent, the third read names the reload the user has to do",
				third === KOKORO_RELOAD_REQUIRED,
				third,
			);
			check(
				"R4: and it does NOT reload again - exactly two workers across three reads",
				constructions === 2,
				`constructions=${constructions}`,
			);
			check("G9 guard: zero fetch() calls across the whole recycle", fetchCalls === 0, `fetchCalls=${fetchCalls}`);
			await engine.dispose();
		}

		// ---- R6: a success refills the one-recycle budget.
		{
			replyFor = (t) => (t === "good" ? "ok" : "fail");
			constructions = 0;
			terminations = 0;
			speaksSeen = [];
			const engine = new KokoroEngine(recordingStore(PRESENT), { device: "wasm", weights: "fast" });
			const ac = new AbortController();

			await failureOf(engine.synthesize(req("bad-1"), ac.signal));
			const recovered = await engine.synthesize(req("good"), ac.signal);
			check("the recycling read actually produces audio", recovered.kind === "buffer" && recovered.audio.byteLength > 0);
			check("two workers after the first recycle", constructions === 2, `constructions=${constructions}`);
			check(
				"a successful read clears the failure mark, so isPrepared() is true again",
				engine.isPrepared() === true,
				String(engine.isPrepared()),
			);

			await failureOf(engine.synthesize(req("bad-2"), ac.signal));
			const after = await failureOf(engine.synthesize(req("bad-3"), ac.signal));
			check(
				"R6: a success refills the budget, so a later failure recycles again",
				constructions === 3,
				`constructions=${constructions}`,
			);
			check(
				"and that read reports the worker's own message rather than the hint",
				after.includes("invalid expand shape"),
				after,
			);
			await engine.dispose();
		}

		// ---- R7/G11: the recycle happens inside prepare() too, so main.ts's
		// loading notice covers it rather than flashing in front of it.
		{
			replyFor = () => "fail";
			constructions = 0;
			terminations = 0;
			speaksSeen = [];
			const engine = new KokoroEngine(recordingStore(PRESENT), { device: "wasm", weights: "fast" });
			const ac = new AbortController();

			await failureOf(engine.synthesize(req("prep-1"), ac.signal));
			check("one worker before prepare()", constructions === 1, `constructions=${constructions}`);
			// Measured on a Pixel 9 Pro XL: without this, main.ts raises the
			// "Loading Kokoro..." notice around prepare(), load() returns the
			// stale `ready` in 0 ms, the notice is dismissed after 88 ms, and
			// synthesize() then spends 9,840 ms reloading behind a silent UI.
			await engine.prepare();
			check(
				"R7: prepare() recycles a failed session, so the reload sits inside the loading notice",
				constructions === 2,
				`constructions=${constructions}`,
			);
			check("and prepare() leaves the engine prepared", engine.isPrepared() === true, String(engine.isPrepared()));
			// The following synthesize must NOT reload a second time: the mark
			// was already consumed by prepare().
			const after = await failureOf(engine.synthesize(req("prep-2"), ac.signal));
			check(
				"R7: and synthesize() does not reload again after prepare() already did",
				constructions === 2,
				`constructions=${constructions}`,
			);
			check("that read reports the worker's own message", after.includes("invalid expand shape"), after);

			// With the budget spent, prepare() must NOT throw: a throw out of
			// prepare() is a candidate load failure, and playWithFallback would
			// turn it into "no speech engine is available", losing the hint.
			let prepareThrew = "";
			try {
				await engine.prepare();
			} catch (err) {
				prepareThrew = err instanceof Error ? err.message : String(err);
			}
			check(
				"G11 guard: prepare() never throws the reload hint - only synthesize() may",
				prepareThrew === "",
				prepareThrew,
			);
			check("and prepare() built no third worker", constructions === 2, `constructions=${constructions}`);
			const hint = await failureOf(engine.synthesize(req("prep-3"), ac.signal));
			check("the hint still arrives from synthesize()", hint === KOKORO_RELOAD_REQUIRED, hint);
			await engine.dispose();
		}

		// ---- G8: an abort must NOT arm the recycle.
		{
			replyFor = (t) => (t === "hangs" ? "hang" : "fail");
			constructions = 0;
			terminations = 0;
			speaksSeen = [];
			const engine = new KokoroEngine(recordingStore(PRESENT), { device: "wasm", weights: "fast" });

			const ac = new AbortController();
			const aborted = engine.synthesize(req("hangs"), ac.signal);
			const guard = failureOf(aborted);
			await waitForSpeak("hangs");
			ac.abort();
			const why = await guard;
			check("the aborted read rejects as an abort", why === "Aborted", why);
			check(
				"G8 guard: an abort leaves the engine prepared - it is not a session failure",
				engine.isPrepared() === true,
				String(engine.isPrepared()),
			);

			const next = await failureOf(engine.synthesize(req("plain"), new AbortController().signal));
			check(
				"G8 guard: and the read after an abort reuses the SAME worker",
				constructions === 1,
				`constructions=${constructions}`,
			);
			check("the read after the abort fails on its own merits", next.includes("invalid expand shape"), next);
			await engine.dispose();
		}

		// ---- G10: dispose()'s rejection of a concurrent prefetched pending must not re-arm the mark.
		{
			// The player prefetches, so at the moment chunk N poisons the
			// session chunk N+1 is already awaiting its own pending entry. The
			// recycle's dispose() rejects that entry with "Kokoro engine
			// disposed". A mark set from a catch around the await would see
			// that rejection and re-arm the flag the recycle just consumed,
			// guaranteeing a second reload on the very next read. This pins
			// that it does not happen.
			replyFor = (t) => (t === "poison" ? "fail" : t === "prefetched" ? "hang" : "ok");
			constructions = 0;
			terminations = 0;
			speaksSeen = [];
			const engine = new KokoroEngine(recordingStore(PRESENT), { device: "wasm", weights: "fast" });
			const ac = new AbortController();

			const poison = failureOf(engine.synthesize(req("poison"), ac.signal));
			const prefetched = failureOf(engine.synthesize(req("prefetched"), ac.signal));
			await poison;
			await waitForSpeak("prefetched");

			await engine.synthesize(req("recovers"), ac.signal);
			// Snapshot rather than an absolute count, deliberately: the number
			// differs across the diff (1 before the fix, 2 after) while the
			// property being pinned - that no FURTHER worker is built - is the
			// same on both sides, so an absolute count would read as a red for
			// the wrong reason.
			const afterRecycle = constructions;
			await engine.synthesize(req("recovers-again"), ac.signal);
			check(
				"G10 guard: a dispose-rejected concurrent pending does not re-arm the recycle",
				constructions === afterRecycle,
				`before=${afterRecycle} after=${constructions}`,
			);
			// The hanging prefetched entry is only ever settled by a dispose -
			// the recycle's own one after the fix, this one before it - so it
			// is awaited last rather than mid-sequence, where it would never
			// settle on the unfixed engine and stall the suite.
			await engine.dispose();
			const prefetchedWhy = await prefetched;
			check(
				"the concurrent prefetched request is settled by a dispose, never left dangling",
				prefetchedWhy === "Kokoro engine disposed",
				prefetchedWhy,
			);
			await settle();
		}
	} finally {
		if (saved.Worker === undefined) delete (globalThis as Record<string, unknown>).Worker;
		else (globalThis as Record<string, unknown>).Worker = saved.Worker;
		if (saved.code === undefined) delete (globalThis as Record<string, unknown>).KOKORO_WORKER_CODE;
		else (globalThis as Record<string, unknown>).KOKORO_WORKER_CODE = saved.code;
		if (saved.ort === undefined) delete (globalThis as Record<string, unknown>).__ORT_ASSETS__;
		else (globalThis as Record<string, unknown>).__ORT_ASSETS__ = saved.ort;
		globalThis.fetch = saved.fetch;
	}
}

console.log("");
if (failures > 0) {
	console.log(`${failures} FAILURE(S)`);
	process.exit(1);
}
console.log("all kokoro weights tests passed");
