import { App } from "obsidian";
import {
	KOKORO_VOICES,
	KOKORO_WEIGHTS,
	KOKORO_WEIGHT_PATHS,
	voiceFilePath,
	type ModelStore,
} from "../engines/onnx/kokoro";
import type { EngineSelection } from "../engines/selection";
import type { SpeechEngine, VoiceInfo } from "../audio/types";
import { resolveStoredVoice } from "../audio/voiceChoice";
import { modelStorePaths, normaliseVaultPath } from "./paths";

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
	const paths = modelStorePaths(pluginDir, modelDir, app.vault.configDir);
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
	/** On failure, the model-relative path that failed (`voices/af_heart.bin`). */
	file?: string;
	/** On failure, the HTTP status as a string, or the error text. */
	detail?: string;
}

/**
 * Which half of a model download failed (NRL-144). `voice` means the shared
 * files and weights are on disk and only the style vector is missing, which
 * the user needs to be told differently from a model that did not arrive.
 */
export type ModelDownloadResult = DownloadResult & { stage?: "model" | "voice" };

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
): Promise<ModelDownloadResult> {
	// Two stages so a voice failure cannot be reported as the model failing,
	// and so a model failure never goes on to request a voice (NRL-144).
	const model = await downloadFiles(app, modelDir, [...MODEL_FILES, weightsPath], onProgress);
	if (!model.ok) return { ...model, stage: "model" };
	const voice = await downloadFiles(app, modelDir, [`voices/${voiceFile}`], onProgress);
	if (!voice.ok) return { ...voice, stage: "voice" };
	return { ok: true };
}

/** The voice a model Download should fetch, and whether to store it (NRL-144). */
export interface ModelDownloadVoice {
	/** The Kokoro voice id to fetch and, when `persist`, to store. */
	voiceId: string;
	/** The file name under `voices/`, as `downloadModel` takes it. */
	file: string;
	/** True when the stored id was not a Kokoro voice and this one replaces it. */
	persist: boolean;
	/** Why the stored voice was replaced, or null when it was used as-is. */
	notice: string | null;
}

/**
 * Pick the voice the Kokoro model Download fetches alongside the model.
 *
 * The stored id is used as-is when it is a Kokoro id (prefixed or bare).
 * Otherwise - another engine's voice left behind by an engine switch, or no
 * voice at all - it goes through the same `resolveStoredVoice` the first read
 * uses, over Kokoro's own voice list, so the voice downloaded is the voice
 * that read would pick. The caller persists it only after the file is on
 * disk. Reconciling here, at the Download click, rather than on engine switch
 * keeps non-negotiable 6 trivially true: nothing is fetched without a click.
 */
export function voiceForModelDownload(
	engine: Pick<SpeechEngine, "label" | "resolveVoiceId">,
	storedId: string,
	voices: VoiceInfo[],
	appLocale: string,
	preferOffline: boolean,
): ModelDownloadVoice {
	const own = voiceFilePath(storedId);
	if (own !== null) {
		return { voiceId: storedId, file: own.replace(/^voices\//, ""), persist: false, notice: null };
	}
	const resolution = resolveStoredVoice(
		engine as SpeechEngine,
		storedId,
		voices,
		undefined,
		appLocale,
		preferOffline,
	);
	const path = voiceFilePath(resolution.id);
	if (path === null) throw new Error(`${resolution.id} is not a Kokoro voice.`);
	return {
		voiceId: resolution.id,
		file: path.replace(/^voices\//, ""),
		persist: true,
		notice: resolution.notice,
	};
}

/**
 * The Notice text for a model Download, and whether the model is now usable.
 *
 * A voice failure after the model landed says so and keeps `modelInstalled`
 * true, because the caller should still reload the engine and redraw the
 * settings tab: the model is on disk, only the voice needs another try.
 */
export function describeModelDownload(
	result: ModelDownloadResult,
	notice: string | null,
): { message: string; modelInstalled: boolean } {
	if (result.ok) {
		return {
			message: notice ? `Kokoro model ready. ${notice}` : "Kokoro model ready.",
			modelInstalled: true,
		};
	}
	if (result.stage === "voice") {
		return {
			message: `Kokoro model installed, but voice ${result.file ?? "file"} could not be downloaded (${result.detail ?? result.error ?? "unknown error"}). Pick a voice under Voice to retry.`,
			modelInstalled: true,
		};
	}
	return { message: `Download failed: ${result.error}`, modelInstalled: false };
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
		return {
			ok: false,
			error: `Could not create model folder: ${errText(err)}`,
			file: paths[0],
			detail: errText(err),
		};
	}

	for (const path of paths) {
		try {
			onProgress({ file: path, loaded: 0, total: 0 });
			const res = await fetch(`${HF_BASE}/${path}`);
			if (!res.ok) {
				return {
					ok: false,
					error: `Download failed for ${path} (${res.status})`,
					file: path,
					detail: String(res.status),
				};
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
			return {
				ok: false,
				error: `Download failed for ${path}: ${errText(err)}`,
				file: path,
				detail: errText(err),
			};
		}
	}

	return { ok: true };
}

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// --- ONNX Runtime on-demand download (NRL-37) ---------------------------
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
/**
 * The subset of Obsidian's `DataAdapter` the size and removal helpers need.
 *
 * A narrow injected shape rather than the full `App`, so this logic is
 * unit-testable in the bare-Node suite: `obsidian` has no runtime there
 * (AGENTS.md), the same escape hatch `settings/data.ts` and
 * `settings/positionThrottle.ts` already use. Obsidian's real
 * `app.vault.adapter` satisfies this structurally; no wrapping needed at the
 * call site.
 *
 * It used to carry `writeBinary`/`readBinary`/`rename` for the atomic runtime
 * write. The runtime is bundled in main.js now (ADR 0028), so nothing writes
 * binaries here any more and those members are gone rather than left as
 * unused surface.
 */
export interface ModelDirAdapter {
	exists(path: string): Promise<boolean>;
	remove(path: string): Promise<void>;
	/** Obsidian's real `DataAdapter.stat` (obsidian.d.ts:2027) - structural match, no wrapping. */
	stat(path: string): Promise<{ size: number } | null>;
	/** Obsidian's real `DataAdapter.list` (obsidian.d.ts:2033). */
	list(path: string): Promise<{ files: string[]; folders: string[] }>;
	/** Obsidian's real `DataAdapter.rmdir` (obsidian.d.ts:2120). */
	rmdir(path: string, recursive: boolean): Promise<void>;
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
	adapter: Pick<ModelDirAdapter, "stat">,
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
	adapter: Pick<ModelDirAdapter, "stat" | "remove" | "list" | "rmdir">,
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
 * Everything this plugin has written into the model directory (owner
 * Decision 2: "everything hidden from the user"). Every figure is a real
 * `adapter.stat()` against what is actually on disk - nothing here is
 * assumed from `WeightsVariant.sizeMb`, which is a download-size estimate and
 * not an installed-size measurement. A file that is not on disk contributes
 * 0, never `NaN` or a negative number.
 *
 * `ortFiles` is retained by the signature rather than removed: an install
 * that predates ADR 0028 can still have an `ort/` directory on disk from the
 * on-demand runtime, and that disk space is real until the user clears it.
 * Counting it is the difference between telling the truth and quietly
 * reporting a smaller number, so the argument stays and stays required.
 */
export async function getTotalUsage(
	adapter: Pick<ModelDirAdapter, "stat" | "exists">,
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
		// A bare table file name is never null; the guard only satisfies the type.
		const path = voiceFilePath(voice.file);
		if (path !== null) voicesBytes += await statSize(path);
	}

	let ortBytes = 0;
	for (const file of ortFiles) {
		ortBytes += await statSize(`ort/${file}`);
	}

	const buildsTotal = builds.gpu + builds.fast + builds.small;
	const totalBytes = sharedBytes + buildsTotal + voicesBytes + ortBytes;

	return { totalBytes, builds, voicesBytes, sharedBytes, ortBytes };
}
