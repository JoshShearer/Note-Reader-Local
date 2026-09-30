/**
 * Executable dependencies travel inside main.js. Nothing here downloads.
 *
 * Obsidian's community-plugin policies prohibit installing or updating
 * dependencies, and a runtime fetched from a release URL is executable
 * dependency management regardless of how it is verified (ADR 0026, which
 * supersedes ADR 0024's distribution decision). So the build gzips each
 * onnxruntime-web dist file, base64s it, and injects the result alongside the
 * digests. Decompression is lazy and per-file, so a reader on a system voice
 * never pays for the WebGPU runtime.
 */

/** One packed asset: base64 of the gzip stream, and the digest of the *plain*
 *  bytes. Verifying the plain bytes is what makes this an integrity check
 *  rather than a check that we can inflate our own string. */
export interface PackedRuntimeFile {
	readonly gzip: string;
	readonly sha256: string;
}

/**
 * The four runtime files the pack carries, in the order the build reads them.
 *
 * One list, deliberately. It was previously written out in three places - the
 * build config, the two call sites that load a runtime file, and the usage
 * accounting - and a fourth copy is exactly how a pack and its reader drift
 * into disagreeing about what exists. `esbuild.config.mjs` cannot import this
 * (it runs before the bundle is built, in plain Node, with no TS loader), so
 * `tests/release.test.ts` asserts the two lists are identical rather than
 * leaving the correspondence to inspection.
 */
export const RUNTIME_FILES = [
	"ort-wasm-simd-threaded.mjs",
	"ort-wasm-simd-threaded.wasm",
	"ort-wasm-simd-threaded.jsep.mjs",
	"ort-wasm-simd-threaded.jsep.wasm",
] as const;

declare const __ORT_ASSETS__: Readonly<Record<string, PackedRuntimeFile>> | undefined;

/** Decode and verify one packed asset, with no network access anywhere in the
 *  path: a Blob stream through the platform's own gzip decompressor. */
export async function unpackRuntimeFile(file: PackedRuntimeFile): Promise<ArrayBuffer> {
	const binary = atob(file.gzip);
	const compressed = Uint8Array.from(binary, (c) => c.charCodeAt(0));
	const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"));
	const bytes = await new Response(stream).arrayBuffer();
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	const actual = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
	if (actual !== file.sha256) {
		throw new Error("Bundled ONNX Runtime is corrupted. Reinstall Local TTS Reader.");
	}
	return bytes;
}

/**
 * Read one named asset out of the pack.
 *
 * `hasOwnProperty` rather than a plain lookup, and not for tidiness: a name
 * like `constructor` or `toString` would otherwise resolve to something
 * inherited from `Object.prototype`, and this would hand `Object.prototype.toString`
 * to the gzip decompressor and report it as a corrupt install. Only a key the
 * build actually wrote is an asset.
 */
export async function readBundledRuntime(name: string): Promise<ArrayBuffer> {
	const files = typeof __ORT_ASSETS__ === "undefined" ? undefined : __ORT_ASSETS__;
	const file =
		files && Object.prototype.hasOwnProperty.call(files, name) ? files[name] : undefined;
	if (!file) throw new Error(`Bundled ONNX Runtime is missing "${name}". Reinstall Local TTS Reader.`);
	return await unpackRuntimeFile(file);
}
