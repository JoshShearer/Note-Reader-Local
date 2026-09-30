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

/**
 * Minimal runtime polyfills for WebViews too old to run onnxruntime-web's own
 * code as shipped (NRL-61). esbuild's `target` only transpiles syntax; it
 * does not backfill missing built-ins, so a genuinely old engine crashes the
 * instant vendored code touches one. `Object.hasOwn` is ES2022 (Chrome 93,
 * Sept 2021); async iteration over a `ReadableStream` shipped even later
 * (Chromium ~124, 2024, tracked as whatwg/streams#778). Measured directly on
 * a Huawei P30 Pro's WebView (`com.huawei.webview`, reporting itself as
 * Chrome/88.0.4324.93, Feb 2021): both are absent, and onnxruntime-web's WASM
 * backend init throws `Object.hasOwn is not a function` on the single-thread
 * path and `<x> is not async iterable` on the threaded path before either
 * polyfill existed. Both are additive - `?? ` on `Object.hasOwn` and a
 * `Symbol.asyncIterator in` guard on `ReadableStream.prototype` - so a modern
 * engine's native implementation is always preferred and never shadowed.
 */
if (typeof Object.hasOwn !== "function") {
	Object.hasOwn = (target: object, key: PropertyKey) =>
		Object.prototype.hasOwnProperty.call(target, key);
}

if (
	typeof ReadableStream !== "undefined" &&
	!(Symbol.asyncIterator in ReadableStream.prototype)
) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(ReadableStream.prototype as any)[Symbol.asyncIterator] = async function* (
		this: ReadableStream,
	) {
		const reader = this.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) return;
				yield value;
			}
		} finally {
			reader.releaseLock();
		}
	};
}
