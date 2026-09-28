/**
 * Plugin data: versioning, the v0 -> v1 migration, and key preservation.
 *
 * `saveSettings()` runs on every rate nudge, voice change and toggle flip, so
 * whatever the load -> save round trip drops is dropped for good the next time
 * the user touches a slider. These checks drive the same two calls the plugin
 * makes (`loadPluginData` on load, `serialisePluginData` on save) over plain
 * objects standing in for `data.json`.
 */

import { loadPluginData, serialisePluginData, PLUGIN_DATA_VERSION } from "../src/settings/data.ts";
import { DEFAULT_SETTINGS, normaliseSettings } from "../src/settings/index.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
	if (cond) console.log(`  ok   ${name}`);
	else {
		failures += 1;
		console.log(`  FAIL ${name} ${detail}`);
	}
}

type Json = Record<string, any>;

/** JSON with keys sorted, so equality ignores key order, which data.json does not care about. */
function canon(value: unknown): string {
	return JSON.stringify(value, (_k, v) =>
		v && typeof v === "object" && !Array.isArray(v)
			? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
			: v,
	);
}

/** What the plugin does between onload and the first saveSettings(). */
function roundTrip(raw: unknown, mutate?: (s: Json) => void): Json {
	const data = loadPluginData(raw);
	const settings = data.settings as unknown as Json;
	mutate?.(settings);
	// JSON through and back, as Obsidian does when it writes data.json.
	return JSON.parse(JSON.stringify(serialisePluginData(data, data.settings)));
}

/** Today's flat shape: 11 top-level keys, `strip` nested, no version. */
function v0Fixture(): Json {
	return {
		engine: "espeak",
		voiceId: "espeak:en-gb",
		rate: 1.4,
		pitch: -12,
		highlight: { enabled: false, color: "#00ff00" },
		strip: { tags: false, urls: false, code: false, tables: false, headings: true },
		bufferAhead: 5,
		kokoroModelPath: "models/kokoro",
		kokoroDevice: "webgpu",
		kokoroThreads: 7,
		kokoroWeights: "small",
	};
}

console.log("normaliseSettings keeps keys it does not recognise");
{
	const out = normaliseSettings({
		rate: 1.5,
		futureSetting: "keep-me",
		highlight: { enabled: true, color: "#123456", futureHighlightKey: 3 },
	}) as unknown as Json;
	check("unknown settings key survives", out.futureSetting === "keep-me", JSON.stringify(out));
	check("unknown nested key survives", out.highlight?.futureHighlightKey === 3, JSON.stringify(out.highlight));
	check("known key still validated", out.rate === 1.5);
	const clamped = normaliseSettings({ rate: 99 }) as unknown as Json;
	check("out-of-range rate still clamped", clamped.rate === 2, String(clamped.rate));
}

console.log("unrelated keys survive load -> save");
{
	const saved = roundTrip({
		version: 1,
		settings: { ...DEFAULT_SETTINGS, futureSetting: "keep-me" },
		positions: {},
		otherFeature: { enabled: true },
	});
	check("unknown root key survives", saved.otherFeature?.enabled === true, JSON.stringify(saved));
	check("unknown settings key survives", saved.settings?.futureSetting === "keep-me", JSON.stringify(saved.settings));
}

console.log("positions survive a saveSettings() triggered by a rate change");
{
	const position = { filePath: "Books/a.md", sourceOffset: 9831, updatedAt: 1790620000000 };
	const saved = roundTrip(
		{ version: 1, settings: { ...DEFAULT_SETTINGS }, positions: { "Books/a.md": position } },
		(s) => {
			s.rate = 1.75;
		},
	);
	check("rate change persisted", saved.settings?.rate === 1.75, String(saved.settings?.rate));
	check("position entry survives", JSON.stringify(saved.positions?.["Books/a.md"]) === JSON.stringify(position),
		JSON.stringify(saved.positions));
}

console.log("a v0 data.json lands every value in the v1 shape");
{
	const saved = roundTrip(v0Fixture());
	const s = saved.settings ?? {};
	check("version is 1", saved.version === 1 && PLUGIN_DATA_VERSION === 1, String(saved.version));
	check("positions is an empty object", JSON.stringify(saved.positions) === "{}", JSON.stringify(saved.positions));
	check("engine", s.engine === "espeak", s.engine);
	check("voiceId", s.voiceId === "espeak:en-gb", s.voiceId);
	check("rate", s.rate === 1.4, String(s.rate));
	check("pitch", s.pitch === -12, String(s.pitch));
	check("highlight.enabled", s.highlight?.enabled === false);
	check("highlight.color", s.highlight?.color === "#00ff00", s.highlight?.color);
	check("bufferAhead", s.bufferAhead === 5, String(s.bufferAhead));
	check("kokoroModelPath", s.kokoroModelPath === "models/kokoro", s.kokoroModelPath);
	check("kokoroDevice", s.kokoroDevice === "webgpu", s.kokoroDevice);
	check("kokoroThreads", s.kokoroThreads === 7, String(s.kokoroThreads));
	check("kokoroWeights", s.kokoroWeights === "small", s.kokoroWeights);
	check("strip.tags -> skipTags", s.skipTags === false);
	check("strip.tables -> skipTables", s.skipTables === false);
	check("strip.headings -> skipHeadings", s.skipHeadings === true);
	check("new key skipFrontmatter defaults true", s.skipFrontmatter === true);
	check("new key speakImageAlt defaults true", s.speakImageAlt === true);
	check("new key speakEmbeds defaults false", s.speakEmbeds === false);
	check("new key offlinePreferred defaults false", s.offlinePreferred === false);
	check("v0 strip object is not carried forward", !("strip" in s) && !("strip" in saved), JSON.stringify(saved));
	check("no flat v0 keys left at the root", !("rate" in saved) && !("engine" in saved), JSON.stringify(Object.keys(saved)));
}

console.log("speakUrls is the inverse of strip.urls, in both positions");
{
	// A copy instead of an inversion would silently flip every existing user's
	// URL preference, which is why both directions are pinned.
	const skipping = roundTrip({ ...v0Fixture(), strip: { ...v0Fixture().strip, urls: true } });
	check("strip.urls=true -> speakUrls=false", skipping.settings?.speakUrls === false, String(skipping.settings?.speakUrls));
	const speaking = roundTrip({ ...v0Fixture(), strip: { ...v0Fixture().strip, urls: false } });
	check("strip.urls=false -> speakUrls=true", speaking.settings?.speakUrls === true, String(speaking.settings?.speakUrls));
}

console.log("strip.code lands in both code keys");
{
	for (const code of [true, false]) {
		const saved = roundTrip({ ...v0Fixture(), strip: { ...v0Fixture().strip, code } });
		check(`strip.code=${code} -> skipCodeBlocks=${code}`, saved.settings?.skipCodeBlocks === code);
		check(`strip.code=${code} -> skipInlineCode=${code}`, saved.settings?.skipInlineCode === code);
	}
}

console.log("a v0 file with a missing strip object gets today's defaults");
{
	const { strip: _drop, ...noStrip } = v0Fixture();
	const s = roundTrip(noStrip).settings ?? {};
	// The v0 defaults were strip.urls=true and strip.code=true, so the migrated
	// values must mean "do not speak URLs" and "skip code".
	check("speakUrls false", s.speakUrls === false);
	check("skipCodeBlocks true", s.skipCodeBlocks === true);
	check("skipInlineCode true", s.skipInlineCode === true);
	check("skipTags true", s.skipTags === true);
	check("skipHeadings false", s.skipHeadings === false);
}

console.log("unknown v0 top-level keys are carried to the v1 root");
{
	const saved = roundTrip({ ...v0Fixture(), handEdited: 42 });
	check("kept at the root", saved.handEdited === 42, JSON.stringify(Object.keys(saved)));
}

console.log("a v1 file round-trips unchanged");
{
	const v1 = {
		version: 1,
		settings: {
			...DEFAULT_SETTINGS,
			rate: 1.25,
			speakUrls: true,
			skipInlineCode: false,
		},
		positions: { "x.md": { sourceOffset: 3 } },
	};
	const saved = roundTrip(JSON.parse(JSON.stringify(v1)));
	check("identical after load -> save", JSON.stringify(saved) === JSON.stringify(v1),
		`\n    got  ${JSON.stringify(saved)}\n    want ${JSON.stringify(v1)}`);
}

console.log("garbage input yields defaults");
{
	for (const raw of [null, undefined, "nonsense", 7, [], { version: 1, settings: "x", positions: [] }]) {
		const saved = roundTrip(raw);
		const label = JSON.stringify(raw) ?? "undefined";
		check(`${label}: version 1`, saved.version === 1);
		check(`${label}: default settings`, canon(saved.settings) === canon(DEFAULT_SETTINGS),
			JSON.stringify(saved.settings));
		check(`${label}: positions is an object`, JSON.stringify(saved.positions) === "{}", JSON.stringify(saved.positions));
	}
}

console.log("DEFAULT_SETTINGS keeps today's effective behaviour");
{
	check("code skipped", DEFAULT_SETTINGS.skipCodeBlocks && DEFAULT_SETTINGS.skipInlineCode);
	check("bare URLs not spoken", DEFAULT_SETTINGS.speakUrls === false);
	check("tags and tables skipped", DEFAULT_SETTINGS.skipTags && DEFAULT_SETTINGS.skipTables);
	check("headings read", DEFAULT_SETTINGS.skipHeadings === false);
}

if (failures > 0) {
	console.log(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall settings checks passed");
