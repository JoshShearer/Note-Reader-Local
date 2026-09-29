import { isRecord, normaliseSettings, type Settings } from "./index";

/*
 * The whole of data.json.
 *
 * Kept free of any obsidian import so the load -> save round trip can be
 * tested in plain Node: that round trip runs on every rate nudge, and anything
 * it drops is gone for good.
 */

export const PLUGIN_DATA_VERSION = 2;

/** The v1 default highlight colour, which v2 replaces with "" (theme). */
const V1_DEFAULT_HIGHLIGHT = "#ffd54f";

export interface PluginData {
	/**
	 * Schema version. A number rather than a literal because a file
	 * written by a newer build keeps its label; see loadPluginData.
	 */
	version: number;
	settings: Settings;
	/**
	 * Per-note reading positions. Reserved: nothing writes it yet, but the
	 * container has to be safe to put it in before anything does.
	 */
	positions: Record<string, unknown>;
	/** Anything else at the root belongs to someone else and is kept. */
	[key: string]: unknown;
}

/** The v0 top-level keys, i.e. the flat Settings object as it was saved. */
const V0_KEYS = [
	"engine",
	"voiceId",
	"rate",
	"pitch",
	"highlight",
	"strip",
	"bufferAhead",
	"kokoroModelPath",
	"kokoroDevice",
	"kokoroThreads",
	"kokoroWeights",
] as const;

function boolOr(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

/**
 * Lift the unversioned v0 shape (flat Settings as the data.json root, with a
 * nested `strip` object) into v1.
 *
 * `strip.urls` is inverted, not copied: v0 stored "skip URLs", v1 stores
 * "speak URLs". A copy would silently flip every existing user's preference.
 * `strip.code` feeds both code keys, because v0 had one switch for both.
 *
 * The fallbacks are the v0 defaults, not the v1 ones, so a v0 file missing a
 * strip key migrates to what that user was actually hearing.
 */
export function migrateV0(raw: Record<string, unknown>): PluginData {
	const strip = isRecord(raw.strip) ? raw.strip : {};
	const skipUrlsV0 = boolOr(strip.urls, true);
	const skipCodeV0 = boolOr(strip.code, true);

	const candidate: Record<string, unknown> = {};
	const rest: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (key === "strip") continue;
		if ((V0_KEYS as readonly string[]).includes(key)) candidate[key] = value;
		else rest[key] = value;
	}

	candidate.skipCodeBlocks = skipCodeV0;
	candidate.skipInlineCode = skipCodeV0;
	candidate.speakUrls = !skipUrlsV0;
	candidate.skipTags = boolOr(strip.tags, true);
	candidate.skipTables = boolOr(strip.tables, true);
	candidate.skipHeadings = boolOr(strip.headings, false);

	// v0 had the same default colour as v1, so it goes on through v1 -> v2.
	return migrateV1({
		...rest,
		version: 1,
		settings: normaliseSettings(candidate),
		positions: {},
	});
}

/**
 * v1 -> v2: the stored default highlight colour becomes "" (follow the theme).
 *
 * Until v2 the colour setting was never applied, so everyone saw #ffd54f
 * whatever was stored, and a stored #ffd54f is overwhelmingly the untouched
 * default rather than a choice. This is a one-shot migration and not a
 * normaliseSettings rule because a rule would run on every load and undo a
 * later, deliberate pick of that same yellow. Only that exact colour moves;
 * anything else was set by hand and is kept. See docs/adr/0005.
 */
export function migrateV1(data: PluginData): PluginData {
	const highlight = data.settings.highlight;
	const color =
		highlight.color.toLowerCase() === V1_DEFAULT_HIGHLIGHT ? "" : highlight.color;
	return {
		...data,
		version: 2,
		settings: { ...data.settings, highlight: { ...highlight, color } },
	};
}

/**
 * Turn whatever loadData() returned into a current-version container.
 *
 * No numeric `version` means v0, including null (no data.json yet) and
 * garbage, which both migrate to defaults. Older versions step forward one
 * migration at a time (v0 -> v1 -> v2). The current version, and anything
 * newer, keeps its label as-is: a file from a newer build is normalised as
 * best this build can, but not relabelled or migrated, so that build still
 * knows to run its own migration if the user goes back to it.
 */
export function loadPluginData(raw: unknown): PluginData {
	if (!isRecord(raw)) return migrateV0({});
	if (typeof raw.version !== "number") return migrateV0(raw);

	const data: PluginData = {
		...raw,
		version: raw.version,
		settings: normaliseSettings(raw.settings),
		positions: isRecord(raw.positions) ? raw.positions : {},
	};
	return data.version === 1 ? migrateV1(data) : data;
}

/** What saveData() writes: the loaded container with the live settings in it. */
export function serialisePluginData(data: PluginData, settings: Settings): PluginData {
	return { ...data, settings };
}
