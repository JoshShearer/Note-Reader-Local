/**
 * NRL-26: voiceChoice.ts's own standalone bare-Node suite.
 *
 * No file covered this module on its own before this ticket - its existing
 * coverage lived entirely inside tests/engine.test.ts, which needs the real
 * spd-say binary. voiceChoice.ts's own docstring already claimed to be "kept
 * free of obsidian imports so it runs under the bare-Node tests"; this file
 * is what makes that claim true for the first time.
 *
 * Focus here is the `preferOffline` tiebreak added in NRL-26: a ranking
 * heuristic within pickLocaleVoice/resolveStoredVoice, not a guarantee
 * (R-S04), and structurally unable to override an already-pinned voice.
 */

import type { EngineAvailability, EngineId, SpeechEngine, SynthRequest, SynthResult, VoiceInfo } from "../src/audio/types.ts";
import { pickLocaleVoice, resolveStoredVoice } from "../src/audio/voiceChoice.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
	if (cond) console.log(`  ok   ${name}`);
	else {
		failures += 1;
		console.log(`  FAIL ${name} ${detail}`);
	}
}

function v(id: string, lang: string, local: boolean | "unknown", isVariant = false): VoiceInfo {
	return {
		id,
		name: id,
		lang,
		gender: "neutral",
		engineId: "speechd",
		isVariant,
		local,
		requiresNetwork: local === "unknown" ? "unknown" : !local,
	};
}

/** Minimal fake, only the members resolveStoredVoice actually touches. */
function fakeEngine(resolveVoiceId?: SpeechEngine["resolveVoiceId"]): SpeechEngine {
	return {
		id: "speechd" as EngineId,
		label: "Fake Engine",
		capabilities: {
			voices: true,
			timing: "none",
			rate: true,
			pitch: true,
			desktopOnly: false,
			pause: false,
			resume: false,
			sentenceBoundary: false,
			offlineStatus: false,
			ownsPlayback: true,
		},
		async isAvailable(): Promise<EngineAvailability> {
			return { available: true };
		},
		async listVoices(): Promise<VoiceInfo[]> {
			return [];
		},
		async selectVoice(): Promise<void> {},
		async synthesize(_req: SynthRequest, _signal: AbortSignal): Promise<SynthResult> {
			throw new Error("not used");
		},
		async dispose(): Promise<void> {},
		resolveVoiceId,
	};
}

console.log("pickLocaleVoice: preferOffline tiebreaks within the winning locale tier");
{
	// Same locale tier, both plain (not variants): local wins over network
	// when preferOffline is true, regardless of array order.
	const list = [v("net", "en-US", false), v("loc", "en-US", true)];
	check(
		"preferOffline true: local voice wins over network voice",
		pickLocaleVoice(list, "en-US", true)?.voice.id === "loc",
		pickLocaleVoice(list, "en-US", true)?.voice.id,
	);
}
{
	// No confirmed-local voice exists: an unknown voice is a better bet than
	// a guaranteed-network one, so it wins the tiebreak.
	const list = [v("net", "en-US", false), v("unk", "en-US", "unknown")];
	check(
		"preferOffline true: falls through to unknown over confirmed-network",
		pickLocaleVoice(list, "en-US", true)?.voice.id === "unk",
		pickLocaleVoice(list, "en-US", true)?.voice.id,
	);
}
{
	// Every candidate at the best locale tier is confirmed-network: the
	// preference must never exclude the correct-locale answer entirely
	// (R-S04's "not a guarantee" as an actual assertion). Stable sort keeps
	// the first one, but the key claim is that SOME voice at this tier is
	// still returned, not nothing and not a worse-locale voice.
	const list = [v("net1", "en-US", false), v("net2", "en-US", false), v("wrong-locale", "fr-FR", true)];
	const result = pickLocaleVoice(list, "en-US", true);
	check("preferOffline true: still returns a voice", result !== undefined);
	check(
		"preferOffline true: never excludes the correct locale entirely",
		result?.voice.lang === "en-US",
		JSON.stringify(result),
	);
}
{
	// preferOffline=false (the default) reproduces the old plain-voice-wins-
	// regardless-of-network behaviour: first non-variant hit, network status
	// irrelevant.
	const list = [v("net", "en-US", false), v("loc", "en-US", true)];
	check(
		"preferOffline false: first plain voice wins, network status ignored",
		pickLocaleVoice(list, "en-US", false)?.voice.id === "net",
		pickLocaleVoice(list, "en-US", false)?.voice.id,
	);
	check(
		"preferOffline omitted: defaults to false, same result",
		pickLocaleVoice(list, "en-US")?.voice.id === "net",
		pickLocaleVoice(list, "en-US")?.voice.id,
	);
}
{
	// isVariant is still the primary sort key: a plain network voice beats a
	// local variant even with preferOffline true.
	const list = [v("plain-net", "en-US", false, false), v("variant-local", "en-US", true, true)];
	check(
		"preferOffline true: isVariant still outranks the offline tiebreak",
		pickLocaleVoice(list, "en-US", true)?.voice.id === "plain-net",
		pickLocaleVoice(list, "en-US", true)?.voice.id,
	);
}

console.log("resolveStoredVoice: a pin is absolute, preferOffline cannot touch it");
{
	// Structural proof, not just an assertion of intent: `exact` and
	// `remapped` both `return` before pickLocaleVoice is ever called inside
	// resolveStoredVoice (see voiceChoice.ts), so preferOffline is a
	// parameter pickLocaleVoice never sees unless execution already fell
	// through both of those returns. Verified by reading the source directly
	// before writing this test, not assumed from the plan.
	const engine = fakeEngine();
	const pinned = v("pinned-network", "en-US", false);
	const localAlternative = v("local-alt", "en-US", true);
	const voices = [pinned, localAlternative];

	const resolved = resolveStoredVoice(engine, "pinned-network", voices, undefined, "en-US", true);
	check(
		"exact pin with local:false is untouched even when preferOffline=true and a local alternative exists",
		resolved.id === "pinned-network" && resolved.voice.local === false,
		JSON.stringify(resolved),
	);
	check("exact pin carries no notice", resolved.notice === null, String(resolved.notice));
}
{
	// Same proof for the remapped-old-format-id branch.
	const remapTarget = v("current-id", "en-US", false);
	const localAlternative = v("local-alt", "en-US", true);
	const voices = [remapTarget, localAlternative];
	const engine = fakeEngine((storedId, vs) => (storedId === "old-format-id" ? vs.find((x) => x.id === "current-id") : undefined));

	const resolved = resolveStoredVoice(engine, "old-format-id", voices, undefined, "en-US", true);
	check(
		"remapped id with local:false is untouched even when preferOffline=true and a local alternative exists",
		resolved.id === "current-id" && resolved.voice.local === false,
		JSON.stringify(resolved),
	);
	check("remapped id carries no notice (silent remap)", resolved.notice === null, String(resolved.notice));
}
{
	// When neither a pin nor a remap applies, preferOffline does reach
	// pickLocaleVoice via the locale-substitute path, and a notice fires -
	// this is the "substitute, not a pin" case, included for contrast.
	const engine = fakeEngine();
	const net = v("net", "en-US", false);
	const loc = v("loc", "en-US", true);
	const resolved = resolveStoredVoice(engine, "gone", [net, loc], undefined, "en-US", true);
	check(
		"no pin: preferOffline reaches the locale substitute and picks the local voice",
		resolved.id === "loc",
		JSON.stringify(resolved),
	);
	check("no pin: notice fires", resolved.notice !== null);
}
{
	// NRL-34 merge: noteLang takes priority over appLocale, and preferOffline
	// must still apply to WHICHEVER tier actually wins - the note-language
	// tier here, since it matches. Proves the two features compose rather
	// than one silently overriding the other after the manual merge.
	const engine = fakeEngine();
	const net = v("fr-net", "fr-FR", false);
	const loc = v("fr-loc", "fr-FR", true);
	const enVoice = v("en-loc", "en-US", true);
	const resolved = resolveStoredVoice(engine, "gone", [net, loc, enVoice], "fr-FR", "en-US", true);
	check(
		"noteLang matches: preferOffline still tiebreaks within the noteLang tier",
		resolved.id === "fr-loc",
		JSON.stringify(resolved),
	);
	check(
		"noteLang matches: notice names the note language, not the app locale",
		!!resolved.notice?.includes("note language"),
		String(resolved.notice),
	);
}
{
	// noteLang given but matches nothing: falls through to appLocale, and
	// preferOffline still applies there too.
	const engine = fakeEngine();
	const net = v("en-net", "en-US", false);
	const loc = v("en-loc", "en-US", true);
	const resolved = resolveStoredVoice(engine, "gone", [net, loc], "de-DE", "en-US", true);
	check(
		"noteLang misses: falls through to appLocale with preferOffline intact",
		resolved.id === "en-loc",
		JSON.stringify(resolved),
	);
	check(
		"noteLang misses: notice names the app language, not the note language",
		!!resolved.notice?.includes("app language"),
		String(resolved.notice),
	);
}

console.log("");
if (failures > 0) {
	console.log(`${failures} FAILURE(S)`);
	process.exit(1);
}
console.log("all voiceChoice tests passed");
