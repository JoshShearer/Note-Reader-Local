/**
 * Vault path arithmetic.
 *
 * Kept free of any Obsidian import so it can be tested in plain node, and
 * separated from the adapter calls that do the actual reading and writing.
 *
 * Obsidian addresses everything from the vault root, so a path that "looks
 * right" is not enough: it has to be the exact path the adapter will resolve.
 * These helpers exist to make that a pure, checkable calculation.
 */

/** Collapse repeated slashes and drop leading/trailing ones, like Obsidian. */
export function normaliseVaultPath(path: string): string {
	return path
		.replace(/\\/g, "/")
		.replace(/\/{2,}/g, "/")
		.replace(/^\/+/, "")
		.replace(/\/+$/, "");
}

const PLUGINS_PREFIX = ".obsidian/plugins/";

/**
 * Vault path of a plugin's own folder.
 *
 * `manifest.dir` is documented as a vault path to the plugin folder, and
 * Obsidian populates it as `.obsidian/plugins/local-tts-reader` rather than the
 * bare folder name. Older builds and hand-written manifests may still give just
 * the name, so accept either and normalise to the full path. Being idempotent
 * matters: blindly prefixing an already-prefixed value produced
 * `.obsidian/plugins/.obsidian/plugins/local-tts-reader`, which resolves to
 * nothing and is not an error the adapter reports clearly.
 */
export function pluginVaultPath(manifestDir: string): string {
	const dir = normaliseVaultPath(manifestDir);
	if (dir.startsWith(PLUGINS_PREFIX)) return dir;
	return normaliseVaultPath(PLUGINS_PREFIX + dir);
}

export interface ModelStorePaths {
	/** Vault path of the plugin folder, e.g. `.obsidian/plugins/local-tts-reader`. */
	pluginRoot: string;
	/** Vault path of the model directory. */
	modelDir: string;
	/** Full vault path of one model file. */
	modelFile(relative: string): string;
	/** Vault path of the bundled worker script. */
	workerPath: string;
	/**
	 * Vault path of one onnxruntime file, in a model directory written by a
	 * build that predates ADR 0028.
	 *
	 * The runtime is bundled inside main.js now and nothing reads this, but an
	 * upgrading install can still have real `ort/` files on disk, and
	 * `getTotalUsage` counts them so the disk-usage figure stays true rather
	 * than quietly shrinking. Delete this once no supported upgrade path
	 * reaches back to ADR 0024.
	 */
	ortFile(name: string): string;
}

/**
 * Work out every path the model store needs.
 *
 * The model directory is deliberately not derived from the plugin folder: a
 * plugin update replaces that folder wholesale, and the weights are a 90MB
 * download that should not have to be repeated each time. The ONNX runtime
 * once lived there too (NRL-37) and no longer does: it is bundled inside
 * main.js, because a runtime fetched from a release URL is executable
 * dependency management, which the community-plugin policies prohibit
 * (ADR 0028). See `ortFile` above for why the path survives anyway.
 */
export function modelStorePaths(manifestDir: string, modelDir: string): ModelStorePaths {
	const pluginRoot = pluginVaultPath(manifestDir);
	const dir = normaliseVaultPath(modelDir);

	return {
		pluginRoot,
		modelDir: dir,
		modelFile: (relative: string) => normaliseVaultPath(`${dir}/${relative}`),
		workerPath: `${pluginRoot}/kokoro-worker.js`,
		ortFile: (name: string) => normaliseVaultPath(`${dir}/ort/${name}`),
	};
}
