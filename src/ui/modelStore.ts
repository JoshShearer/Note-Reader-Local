import { App } from "obsidian";
import {
	KOKORO_VOICES,
	KOKORO_WEIGHTS,
	KOKORO_WEIGHT_PATHS,
	voiceFilePath,
	type ModelStore,
} from "../engines/onnx/kokoro";
import type { EngineSelection } from "../engines/selection";
import { modelStorePaths, normaliseVaultPath, pluginVaultPath } from "./paths";

export { modelStorePaths, normaliseVaultPath, pluginVaultPath } from "./paths";

/**
 * Reads Kokoro model files out of the vault.
 *
 * The adapter is used rather than the filesystem API because it is the only
 * storage path that behaves the same on desktop and in the Android WebView.
 */

export interface VaultModelStore extends ModelStore {
	/** True when the shared model files are present. Voices are separate. */
	isFullyInstalled(): Promise<boolean>;
	/** Bytes already on disk, for the download flow. */
	has(relativePath: string): Promise<boolean>;
}

/**
 * The small shared files, needed whatever else is installed.
 *
 * Neither the weights nor the voices are in here. Weights come in builds that
 * trade size against speed, and a voice is a 512KB style vector: downloading
 * all 28 of those up front would be wasted bandwidth, and refusing to let the
 * user pick one until they re-download everything would be worse. Both are
 * fetched on demand instead.
 */
const MODEL_FILES = ["config.json", "tokenizer.json", "tokenizer_config.json"];

const HF_BASE = "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main";

export function createModelStore(
	app: App,
	pluginDir: string,
	modelDir: string,
): VaultModelStore {
	const paths = modelStorePaths(pluginDir, modelDir);
	const dir = paths.modelDir;

	const full = paths.modelFile;

	const read = async (relative: string): Promise<ArrayBuffer> => {
		const bytes = await app.vault.adapter.readBinary(full(relative));
		return bytes;
	};

	const exists = async (relative: string): Promise<boolean> => {
		return await app.vault.adapter.exists(full(relative));
	};

	// manifest.dir is already vault-relative. Read through the adapter on both
	// desktop and mobile; the engine turns these bytes into same-origin blobs.
	const readPluginFile = async (vaultPath: string): Promise<ArrayBuffer> => {
		return await app.vault.adapter.readBinary(vaultPath);
	};

	return {
		dir,

		readPluginFile,

		workerPath: paths.workerPath,

		ortFile: paths.ortFile,

		/**
		 * Prefix the worker resolves model requests against.
		 *
		 * The worker's fetch shim matches by path suffix and serves the bytes it
		 * was sent, so this only needs to be a stable, non-network string.
		 */
		modelBase: "local-model://kokoro/",

		exists,
		read,

		async readOptional(relative: string): Promise<ArrayBuffer | null> {
			if (!(await exists(relative))) return null;
			return await read(relative);
		},

		has: async (relative: string): Promise<boolean> => {
			return await app.vault.adapter.exists(full(relative));
		},

		async isFullyInstalled(): Promise<boolean> {
			for (const file of MODEL_FILES) {
				if (!(await app.vault.adapter.exists(full(file)))) return false;
			}
			for (const weights of KOKORO_WEIGHT_PATHS) {
				if (await app.vault.adapter.exists(full(weights))) return true;
			}
			return false;
		},
	};
}

export interface DownloadProgress {
	file: string;
	loaded: number;
	total: number;
}

export interface DownloadResult {
	ok: boolean;
	error?: string;
}

/**
 * Fetch the model into the vault.
 *
 * The model is written to a vault path rather than the plugin folder on
 * purpose: updating or reinstalling the plugin replaces its own folder, and a
 * 90 MB download should not have to be repeated every time.
 *
 * This is the one time the plugin reaches the network, and it only ever fetches
 * model weights from a fixed URL. Nothing about the user's notes is sent.
 */
export async function downloadModel(
	app: App,
	modelDir: string,
	weightsPath: string,
	voiceFile: string,
	onProgress: (progress: DownloadProgress) => void,
): Promise<DownloadResult> {
	const paths = [...MODEL_FILES, weightsPath, `voices/${voiceFile}`];
	return await downloadFiles(app, modelDir, paths, onProgress);
}

/**
 * Fetch a single voice.
 *
 * Separate from the model download so picking a new voice costs 512KB rather
 * than the whole 90MB install, which is what makes the voice list usable
 * instead of decorative.
 */
export async function downloadVoice(
	app: App,
	modelDir: string,
	voiceFile: string,
	onProgress: (progress: DownloadProgress) => void,
): Promise<DownloadResult> {
	return await downloadFiles(app, modelDir, [`voices/${voiceFile}`], onProgress);
}

async function downloadFiles(
	app: App,
	modelDir: string,
	paths: string[],
	onProgress: (progress: DownloadProgress) => void,
): Promise<DownloadResult> {
	const dir = normaliseVaultPath(modelDir);

	try {
		for (const folder of [dir, `${dir}/onnx`, `${dir}/voices`]) {
			if (!(await app.vault.adapter.exists(folder))) {
				await app.vault.adapter.mkdir(folder);
			}
		}
	} catch (err) {
		return { ok: false, error: `Could not create model folder: ${errText(err)}` };
	}

	for (const path of paths) {
		try {
			onProgress({ file: path, loaded: 0, total: 0 });
			const res = await fetch(`${HF_BASE}/${path}`);
			if (!res.ok) {
				return { ok: false, error: `Download failed for ${path} (${res.status})` };
			}
			const total = Number(res.headers.get("content-length") ?? 0);

			// Stream when the runtime supports it, so a large file does not have
			// to sit in memory twice on a phone.
			if (res.body && typeof res.body.getReader === "function") {
				const reader = res.body.getReader();
				const parts: Uint8Array[] = [];
				let loaded = 0;
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					if (value) {
						parts.push(value);
						loaded += value.byteLength;
						onProgress({ file: path, loaded, total });
					}
				}
				const merged = new Uint8Array(loaded);
				let at = 0;
				for (const part of parts) {
					merged.set(part, at);
					at += part.byteLength;
				}
				await app.vault.adapter.writeBinary(
					normaliseVaultPath(`${dir}/${path}`),
					merged.buffer,
				);
			} else {
				const buffer = await res.arrayBuffer();
				onProgress({ file: path, loaded: buffer.byteLength, total });
				await app.vault.adapter.writeBinary(normaliseVaultPath(`${dir}/${path}`), buffer);
			}
		} catch (err) {
			return { ok: false, error: `Download failed for ${path}: ${errText(err)}` };
		}
	}

	return { ok: true };
}

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// --- ONNX Runtime on-demand download (NRL-37) ---------------------------
//
// The runtime WASM/mjs files are ~31 MB (measured from
// node_modules/onnxruntime-web's dist files this session: 20,856 +
// 11,133,407 + 44,484 + 21,596,019 bytes). Obsidian's own installer fetches
// only main.js, manifest.json and styles.css, so a directory install never
// had these files bundled with it. They are fetched from this plugin's own
// tagged GitHub Release on explicit user action instead, gated identically
// to the Kokoro model download above (AGENTS.md non-negotiable 6): nothing
// here runs on load, on prewarm, or on first read.

const ORT_RELEASE_REPO = "JoshShearer/Note-Reader-Local";

/** Approximate total download size, for the settings row shown before a
 *  click ever fires a request (measured this session; see comment above). */
export const ORT_RUNTIME_SIZE_MB = 31;

export type OrtStatus = "missing" | "ok" | "mismatch";

/**
 * The subset of Obsidian's `DataAdapter` the atomic-write and status-check
 * helpers need.
 *
 * A narrow injected shape rather than the full `App`, so this logic is
 * unit-testable in the bare-Node suite: `obsidian` has no runtime there
 * (AGENTS.md), the same escape hatch `settings/data.ts` and
 * `settings/positionThrottle.ts` already use. Obsidian's real
 * `app.vault.adapter` satisfies this structurally; no wrapping needed at the
 * call site.
 */
export interface AtomicAdapter {
	writeBinary(path: string, data: ArrayBuffer): Promise<void>;
	readBinary(path: string): Promise<ArrayBuffer>;
	rename(oldPath: string, newPath: string): Promise<void>;
	remove(path: string): Promise<void>;
	exists(path: string): Promise<boolean>;
	/** Obsidian's real `DataAdapter.stat` (obsidian.d.ts:2027) - structural match, no wrapping. */
	stat(path: string): Promise<{ size: number } | null>;
	/** Obsidian's real `DataAdapter.list` (obsidian.d.ts:2033). */
	list(path: string): Promise<{ files: string[]; folders: string[] }>;
	/** Obsidian's real `DataAdapter.rmdir` (obsidian.d.ts:2120). */
	rmdir(path: string, recursive: boolean): Promise<void>;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
	const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(hashBuffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/** Remove a path, swallowing the error: a failed cleanup must not mask the
 *  real failure the caller is already about to report. */
async function removeQuietly(adapter: AtomicAdapter, path: string): Promise<void> {
	try {
		await adapter.remove(path);
	} catch {
		// Best-effort only, see doc comment above.
	}
}

/**
 * Write bytes to `finalPath` only if they pass their checksum, and only ever
 * by an atomic rename - never a partial write visible at the final name.
 *
 * "Refuse half-written files" (ticket acceptance criterion) is satisfied
 * literally: the only path that ever becomes `finalPath` is one that passed
 * its checksum in full, in this attempt. A stale `.part` left over from an
 * earlier crashed attempt is never trusted or renamed over - it is removed
 * before the fresh write, not after, so a half-written file from a previous
 * run can never be silently promoted by a write that fails before it gets
 * that far.
 */
export async function writeBinaryAtomic(
	adapter: AtomicAdapter,
	finalPath: string,
	bytes: ArrayBuffer,
	expectedChecksum: string,
): Promise<DownloadResult> {
	const tempPath = `${finalPath}.part`;

	if (await adapter.exists(tempPath)) {
		await removeQuietly(adapter, tempPath);
	}

	try {
		await adapter.writeBinary(tempPath, bytes);
	} catch (err) {
		await removeQuietly(adapter, tempPath);
		return { ok: false, error: `Could not write ${finalPath}: ${errText(err)}` };
	}

	const actual = await sha256Hex(bytes);
	if (actual !== expectedChecksum) {
		await removeQuietly(adapter, tempPath);
		return {
			ok: false,
			error: `Checksum mismatch for ${finalPath}: expected ${expectedChecksum}, got ${actual}`,
		};
	}

	try {
		await adapter.rename(tempPath, finalPath);
	} catch (err) {
		await removeQuietly(adapter, tempPath);
		return { ok: false, error: `Could not finalise ${finalPath}: ${errText(err)}` };
	}

	return { ok: true };
}

/**
 * Classify every ORT file as `missing` (not downloaded yet - the expected
 * state on a fresh directory install, not a failure), `ok` (present and
 * verified), or `mismatch` (present but corrupt or tampered with).
 *
 * Reuses the read-and-hash shape `validateOrtChecksums()` in main.ts already
 * had, but returns a status per file instead of only tracing, so the caller
 * can tell "not downloaded yet" apart from "downloaded and corrupt" - two
 * states that call for very different UI and, for mismatch, a user-visible
 * Notice rather than a diagnostics-log-only trace().
 */
export async function checkOrtStatus(
	adapter: Pick<AtomicAdapter, "exists" | "readBinary">,
	dir: string,
	files: string[],
	checksums: Record<string, string>,
): Promise<Record<string, OrtStatus>> {
	const result: Record<string, OrtStatus> = {};
	const ortDir = normaliseVaultPath(`${dir}/ort`);

	for (const file of files) {
		const filePath = normaliseVaultPath(`${ortDir}/${file}`);
		const expected = checksums[file];

		if (!(await adapter.exists(filePath))) {
			result[file] = "missing";
			continue;
		}
		if (!expected) {
			// No compiled digest to compare against. Should not happen - every
			// file in `files` comes from the same checksum map - but a file
			// that cannot be verified is not one that can be called `ok`.
			result[file] = "mismatch";
			continue;
		}
		try {
			// readBinary(), never read(): these are binary .wasm/.mjs files,
			// and adapter.read() decodes as UTF-8 text, which is lossy for
			// bytes that are not valid UTF-8 (invalid sequences collapse to
			// U+FFFD). That round-trip once made this exact check hash its own
			// corrupted copy rather than the file, reporting a mismatch
			// unconditionally regardless of whether the file on disk was
			// correct (NRL-60).
			const bytes = await adapter.readBinary(filePath);
			const actual = await sha256Hex(bytes);
			result[file] = actual === expected ? "ok" : "mismatch";
		} catch {
			result[file] = "mismatch";
		}
	}

	return result;
}

/** Reduce a per-file status map to one summary: mismatch outranks missing,
 *  which outranks ok, so any real corruption is never hidden by an
 *  also-missing file next to it. */
export function worstOrtStatus(statuses: Record<string, OrtStatus>): OrtStatus {
	const values = Object.values(statuses);
	if (values.some((s) => s === "mismatch")) return "mismatch";
	if (values.length === 0 || values.some((s) => s === "missing")) return "missing";
	return "ok";
}

/**
 * Fetch the ONNX runtime into the vault, from this plugin's own tagged
 * GitHub Release assets - not a CDN, not onnxruntime-web's own default
 * jsdelivr URL (ADR 0011's original reasoning, preserved: the plugin never
 * reaches a third party at runtime).
 *
 * Each file is buffered completely before its checksum is trusted - never
 * mid-stream - and only written to its final name by `writeBinaryAtomic`
 * once that checksum, computed against the same digests `esbuild.config.mjs`
 * compiled into main.js at build time, matches. `version` is the plugin's own
 * `manifest.version` (bare semver, e.g. "0.1.0"): the same tag shape
 * `release.yml` already produces from a plain version-string tag push, and
 * the same string this repo's own `versions.json` keys on, with no new
 * stored config.
 */
export async function downloadOrtRuntime(
	app: App,
	modelDir: string,
	version: string,
	checksums: Record<string, string>,
	onProgress: (progress: DownloadProgress) => void,
): Promise<DownloadResult> {
	const dir = normaliseVaultPath(modelDir);
	const ortDir = normaliseVaultPath(`${dir}/ort`);
	const files = Object.keys(checksums);

	try {
		for (const folder of [dir, ortDir]) {
			if (!(await app.vault.adapter.exists(folder))) {
				await app.vault.adapter.mkdir(folder);
			}
		}
	} catch (err) {
		return { ok: false, error: `Could not create ort folder: ${errText(err)}` };
	}

	for (const file of files) {
		const expected = checksums[file];
		if (!expected) {
			return { ok: false, error: `No checksum compiled for ${file}; refusing to download` };
		}

		try {
			onProgress({ file, loaded: 0, total: 0 });
			const res = await fetch(
				`https://github.com/${ORT_RELEASE_REPO}/releases/download/${version}/${file}`,
			);
			if (!res.ok) {
				return { ok: false, error: `Download failed for ${file} (${res.status})` };
			}
			const total = Number(res.headers.get("content-length") ?? 0);
			const bytes = await bufferOrtResponse(res, file, total, onProgress);

			const finalPath = normaliseVaultPath(`${ortDir}/${file}`);
			const written = await writeBinaryAtomic(app.vault.adapter, finalPath, bytes, expected);
			if (!written.ok) return written;
		} catch (err) {
			return { ok: false, error: `Download failed for ${file}: ${errText(err)}` };
		}
	}

	return { ok: true };
}

/**
 * Stream a response into one buffer, reporting progress as it arrives.
 *
 * Deliberately separate from `downloadFiles()`'s streaming loop above rather
 * than shared: that path writes each chunk straight to the vault as it
 * arrives, which is exactly the non-atomic, trust-mid-stream behaviour this
 * download must not have (the whole buffer needs to exist before its
 * checksum can be trusted). Reusing it would mean threading an
 * atomic-vs-direct flag through code that today has neither, for a function
 * whose existing direct-write behaviour is deliberately left untouched
 * (owner decision, NRL-37 D5).
 */
async function bufferOrtResponse(
	res: Response,
	file: string,
	total: number,
	onProgress: (progress: DownloadProgress) => void,
): Promise<ArrayBuffer> {
	if (res.body && typeof res.body.getReader === "function") {
		const reader = res.body.getReader();
		const parts: Uint8Array[] = [];
		let loaded = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) {
				parts.push(value);
				loaded += value.byteLength;
				onProgress({ file, loaded, total });
			}
		}
		const merged = new Uint8Array(loaded);
		let at = 0;
		for (const part of parts) {
			merged.set(part, at);
			at += part.byteLength;
		}
		return merged.buffer;
	}
	const buffer = await res.arrayBuffer();
	onProgress({ file, loaded: buffer.byteLength, total });
	return buffer;
}

// --- Installed size, removal, and total usage (NRL-33, R-C02) -----------
//
// "Installed size" is always a real adapter.stat() of the file that is
// actually on disk, never the download-size table above: a build resumed
// from a partial download, or one a user hand-edited, would silently lie
// through a table lookup.

/** The three weights builds a user can download and later remove. */
export type KokoroBuild = "gpu" | "fast" | "small";

/** MB for one build's weights file, decimal (bytes / 1_000_000), matching
 *  `WeightsVariant.sizeMb`'s convention. Null if that build is not on disk. */
export async function getInstalledSizeMb(
	adapter: Pick<AtomicAdapter, "stat">,
	modelDir: string,
	build: KokoroBuild,
): Promise<number | null> {
	const dir = normaliseVaultPath(modelDir);
	const path = normaliseVaultPath(`${dir}/${KOKORO_WEIGHTS[build].path}`);
	const stat = await adapter.stat(path);
	if (!stat) return null;
	return stat.size / 1_000_000;
}

export interface RemoveBuildResult {
	ok: boolean;
	/** Bytes actually freed - 0 whenever `ok` is false. */
	freedBytes: number;
	error?: string;
}

/**
 * Delete one weights build and report bytes freed.
 *
 * `freedBytes` comes from a `stat()` taken immediately before the
 * `remove()`, never from the download-size table, so the reported number is
 * what was really on disk. A build that was never installed is a no-op:
 * `ok: false`, `freedBytes: 0`, and no `remove()` call at all - a caller
 * cannot tell "removed nothing because nothing was there" from "removal
 * failed" by the `ok` flag alone, but it can by checking whether anything
 * was ever on disk first (`getInstalledSizeMb` returning non-null).
 *
 * After the weights file is gone, `onnx/` is removed too if it is now
 * empty, best-effort: a failure there must not mask the weights removal
 * that already succeeded, the same reasoning `removeQuietly()` above uses
 * for the download path's own cleanup.
 */
export async function removeModelBuild(
	adapter: Pick<AtomicAdapter, "stat" | "remove" | "list" | "rmdir">,
	modelDir: string,
	build: KokoroBuild,
): Promise<RemoveBuildResult> {
	const dir = normaliseVaultPath(modelDir);
	const weightsPath = normaliseVaultPath(`${dir}/${KOKORO_WEIGHTS[build].path}`);

	const stat = await adapter.stat(weightsPath);
	if (!stat) {
		return { ok: false, freedBytes: 0 };
	}

	try {
		await adapter.remove(weightsPath);
	} catch (err) {
		return { ok: false, freedBytes: 0, error: errText(err) };
	}

	try {
		const onnxDir = normaliseVaultPath(`${dir}/onnx`);
		const listing = await adapter.list(onnxDir);
		if (listing.files.length === 0 && listing.folders.length === 0) {
			await adapter.rmdir(onnxDir, false);
		}
	} catch {
		// Best-effort only, see doc comment above.
	}

	return { ok: true, freedBytes: stat.size };
}

/**
 * The concrete form of owner Decision 3 (NRL-33): removing the weights
 * behind a *literal* Kokoro pin must fall back to automatic selection, or
 * `resolveSelection` returns a one-element list for the pin and the user is
 * left with "no speech engine is available" and no fallback. An "auto"
 * selection re-ranks itself on its own and needs no special-casing here,
 * and a pin that is still available after the removal (a different build
 * remains) must not be disturbed.
 */
export function shouldClearPinnedKokoro(
	engineSelection: EngineSelection,
	kokoroAvailableAfterRemoval: boolean,
): boolean {
	return engineSelection === "kokoro" && !kokoroAvailableAfterRemoval;
}

export interface UsageSummary {
	totalBytes: number;
	builds: Record<KokoroBuild, number>;
	voicesBytes: number;
	sharedBytes: number;
	ortBytes: number;
}

/**
 * Everything this plugin has ever written into the model directory,
 * including the ORT runtime (owner Decision 2: "everything hidden from the
 * user"). Every figure is a real `adapter.stat()` against what is actually
 * on disk - nothing here is assumed from `WeightsVariant.sizeMb` or
 * `ORT_RUNTIME_SIZE_MB`, both of which are download-size estimates, not
 * installed-size measurements. A file that is not on disk contributes 0,
 * never `NaN` or a negative number.
 */
export async function getTotalUsage(
	adapter: Pick<AtomicAdapter, "stat" | "exists">,
	modelDir: string,
	ortFiles: string[],
): Promise<UsageSummary> {
	const dir = normaliseVaultPath(modelDir);

	const statSize = async (relative: string): Promise<number> => {
		const stat = await adapter.stat(normaliseVaultPath(`${dir}/${relative}`));
		return stat?.size ?? 0;
	};

	let sharedBytes = 0;
	for (const file of MODEL_FILES) {
		sharedBytes += await statSize(file);
	}

	const builds: Record<KokoroBuild, number> = { gpu: 0, fast: 0, small: 0 };
	for (const key of Object.keys(builds) as KokoroBuild[]) {
		builds[key] = await statSize(KOKORO_WEIGHTS[key].path);
	}

	let voicesBytes = 0;
	for (const voice of KOKORO_VOICES) {
		voicesBytes += await statSize(voiceFilePath(voice.file));
	}

	let ortBytes = 0;
	for (const file of ortFiles) {
		ortBytes += await statSize(`ort/${file}`);
	}

	const buildsTotal = builds.gpu + builds.fast + builds.small;
	const totalBytes = sharedBytes + buildsTotal + voicesBytes + ortBytes;

	return { totalBytes, builds, voicesBytes, sharedBytes, ortBytes };
}
