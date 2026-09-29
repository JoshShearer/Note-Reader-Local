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

import {
	KokoroEngine,
	KOKORO_WEIGHTS,
	probeGpu,
	voiceFilePath,
} from "../src/engines/onnx/kokoro.ts";
import type { ModelStore } from "../src/engines/onnx/kokoro.ts";

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
		ortFile: (name: string) => `plugin/ort/${name}`,
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
		ortFile: (name: string) => `plugin/ort/${name}`,
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

console.log("");
if (failures > 0) {
	console.log(`${failures} FAILURE(S)`);
	process.exit(1);
}
console.log("all kokoro weights tests passed");
