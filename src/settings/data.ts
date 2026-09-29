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

export interface ReadingPosition {
	filePath: string;
	segmentId: string;
	segmentIndex: number;
	sourceOffset: number;
	updatedAt: number;
}

export interface PluginData {
	/**
	 * Schema version. A number rather than a literal because a file
	 * written by a newer build keeps its label; see loadPluginData.
	 */
	version: number;
	settings: Settings;
	/**
	 * Per-note reading positions. Maps vault-relative file paths to positions.
	 */
	positions: Record<string, ReadingPosition>;
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
		positions: isRecord(raw.positions) ? (raw.positions as Record<string, ReadingPosition>) : {},
	};
	return data.version === 1 ? migrateV1(data) : data;
}

/** What saveData() writes: the loaded container with the live settings in it. */
export function serialisePluginData(data: PluginData, settings: Settings): PluginData {
	return { ...data, settings };
}

/**
 * Does `key` name `path` itself, or something inside it?
 *
 * One predicate for both a file and a folder, because Obsidian's `rename` and
 * `delete` callbacks hand the same TAbstractFile either way and the typings do
 * not promise anything about how a folder's descendants are sequenced. The
 * trailing separator is what keeps `Notes2/x.md` alive when `Notes` is
 * renamed: a bare `startsWith("Notes")` would take it too.
 */
function covers(key: string, path: string): boolean {
	return key === path || key.startsWith(`${path}/`);
}

/**
 * Re-key every stored position under `oldPath` to sit under `newPath`.
 *
 * Returns the input object unchanged when there is nothing to do, which is both
 * a cheap early-out and the signal main.ts uses to decide there is no save to
 * make. Callers must check identity rather than comparing contents.
 *
 * Each moved value's own `filePath` is rewritten to match its new key, so the
 * key and the field cannot disagree. srs.md:425 includes filePath in the
 * persisted shape; the code never reads it back today, but it is part of the
 * contract and a rename is the one moment it is knowable to be wrong.
 *
 * Pure, and returns a new map rather than editing the one it was given, so a
 * caller holding the old container is not surprised.
 *
 * Two passes, and the order is load-bearing. A rename can land on a path that
 * already holds a position - Obsidian has taken the note that was there, so
 * that position is the stale one and the moved value has to win. One pass
 * cannot guarantee that: Object.entries yields insertion order, so a key that
 * is not being moved but sorts after the moved one would be written last and
 * silently clobber it. Copying everything unmatched first and overwriting
 * with the moved values afterwards makes the result independent of the order
 * the keys happen to be in.
 */
export function moveReadingPositions(
	positions: Record<string, ReadingPosition>,
	oldPath: string,
	newPath: string,
): Record<string, ReadingPosition> {
	if (oldPath === newPath) return positions;
	const next: Record<string, ReadingPosition> = {};
	let moved = false;
	for (const [key, value] of Object.entries(positions)) {
		if (!covers(key, oldPath)) next[key] = value;
	}
	for (const [key, value] of Object.entries(positions)) {
		if (!covers(key, oldPath)) continue;
		const newKey = newPath + key.slice(oldPath.length);
		next[newKey] = { ...value, filePath: newKey };
		moved = true;
	}
	// Identity, not equality: "nothing matched" has to be distinguishable from
	// "matched and produced the same contents", or every rename of an untracked
	// file would write data.json for no reason.
	return moved ? next : positions;
}

/**
 * Remove every stored position under `path`.
 *
 * Idempotent by construction, so a delete that arrives twice (Obsidian does not
 * document whether a folder's descendants are reported individually) is
 * harmless. Returns the input object unchanged when nothing matched, for the
 * same reason moveReadingPositions does.
 */
export function dropReadingPositions(
	positions: Record<string, ReadingPosition>,
	path: string,
): Record<string, ReadingPosition> {
	if (Object.keys(positions).every((key) => !covers(key, path))) return positions;
	const next: Record<string, ReadingPosition> = {};
	for (const [key, value] of Object.entries(positions)) {
		if (!covers(key, path)) next[key] = value;
	}
	return next;
}
