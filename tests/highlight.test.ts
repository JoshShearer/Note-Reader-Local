/**
 * Sentence and word highlighting: settings preservation, independent control, defaults.
 *
 * Tests focus on settings normalisation (non-negotiable 10: preserve unknown keys),
 * independent control of sentence and word toggles, and defaults.
 * StateEffect composition (sentence first, word overwrites) and timing gate (word only
 * when engine.capabilities.timing !== "none") are verified in main.ts event handlers
 * during E2E testing.
 */

import { DEFAULT_SETTINGS, normaliseSettings } from "../src/settings/index.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
	if (cond) console.log(`  ok   ${name}`);
	else {
		failures += 1;
		console.log(`  FAIL ${name} ${detail}`);
	}
}

// Test 1: Settings round-trip preserves both sentence and word toggles
console.log("Settings round-trip: sentence and word toggles preserved");
{
	const settings = {
		...DEFAULT_SETTINGS,
		highlight: { ...DEFAULT_SETTINGS.highlight, sentence: false, word: true },
	};
	const normalised = normaliseSettings(settings);
	check("sentence toggle preserved as false", normalised.highlight.sentence === false);
	check("word toggle preserved as true", normalised.highlight.word === true);

	// Round trip the other way
	const settings2 = {
		...DEFAULT_SETTINGS,
		highlight: { ...DEFAULT_SETTINGS.highlight, sentence: true, word: false },
	};
	const normalised2 = normaliseSettings(settings2);
	check("sentence toggle preserved as true", normalised2.highlight.sentence === true);
	check("word toggle preserved as false", normalised2.highlight.word === false);
}

// Test 2: Independent control of sentence vs word
console.log("Independent control: sentence and word toggles are independent");
{
	// All combinations
	const combos = [
		{ sentence: true, word: true },
		{ sentence: true, word: false },
		{ sentence: false, word: true },
		{ sentence: false, word: false },
	];

	for (const combo of combos) {
		const settings = normaliseSettings({
			highlight: { enabled: true, ...combo, color: "" },
		});
		check(
			`sentence=${combo.sentence}, word=${combo.word}`,
			settings.highlight.sentence === combo.sentence && settings.highlight.word === combo.word,
			JSON.stringify(settings.highlight),
		);
	}
}

// Test 3: Settings normalisation preserves unknown keys in highlight object (non-negotiable 10)
console.log("Non-negotiable 10: normaliseSettings preserves unknown highlight keys");
{
	const settings = normaliseSettings({
		highlight: {
			enabled: true,
			sentence: true,
			word: false,
			color: "#aabbcc",
			futureKey: "keep-this",
		},
	}) as unknown as Record<string, any>;
	check(
		"unknown key in highlight survives",
		settings.highlight?.futureKey === "keep-this",
		JSON.stringify(settings.highlight),
	);
	check("known keys still validated", settings.highlight?.sentence === true && settings.highlight?.word === false);
}

// Test 4: Defaults for sentence and word are both true
console.log("DEFAULT_SETTINGS: sentence and word both true");
{
	check("sentence default is true", DEFAULT_SETTINGS.highlight.sentence === true);
	check("word default is true", DEFAULT_SETTINGS.highlight.word === true);
	check("enabled default is true", DEFAULT_SETTINGS.highlight.enabled === true);
}

// Test 5: Missing sentence/word keys use defaults
console.log("Missing keys use defaults");
{
	const oldSettings = normaliseSettings({
		highlight: { enabled: false, color: "#ff0000" },
	});
	check("missing sentence gets default (true)", oldSettings.highlight.sentence === true);
	check("missing word gets default (true)", oldSettings.highlight.word === true);
	check("enabled preserved", oldSettings.highlight.enabled === false);
	check("color preserved", oldSettings.highlight.color === "#ff0000");
}

// Test 6: Invalid values for sentence/word fall back to defaults
console.log("Invalid values fall back to defaults");
{
	const badSettings = normaliseSettings({
		highlight: {
			enabled: true,
			sentence: "not a boolean" as any,
			word: null as any,
			color: "",
		},
	});
	check("invalid sentence falls back to default", badSettings.highlight.sentence === true);
	check("invalid word falls back to default", badSettings.highlight.word === true);
}

if (failures > 0) {
	console.log(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall highlight checks passed");
