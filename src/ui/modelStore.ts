import { App } from "obsidian";
import { KOKORO_WEIGHT_PATHS, type ModelStore } from "../engines/onnx/kokoro";
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
