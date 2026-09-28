/**
 * This dedicated worker uses browser APIs on both Electron and mobile.
 * Electron exposes `process` in workers. Transformers' browser distribution
 * still detects it at runtime and selects its empty Node backend, advertising
 * cpu/cuda instead of wasm. ORT's separately imported glue also detects Node.
 * Hide the binding in THIS worker before loading either dependency. This does
 * not mutate the process object or the Obsidian renderer's global environment.
 * Do not register Symbol.for('onnxruntime'): Transformers 3.8's override branch
 * skips initializing its supportedDevices list altogether.
 */
if ("process" in globalThis) {
	if (!Reflect.defineProperty(globalThis, "process", {
		value: undefined,
		configurable: true,
		writable: true,
	})) {
		throw new Error("Could not isolate the Kokoro browser worker from Node detection");
	}
}
