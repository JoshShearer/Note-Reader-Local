import type { SpeechEngine, VoiceInfo } from "./types";

/**
 * Choosing which voice to use when the stored one is not an exact match.
 *
 * Kept free of obsidian imports so it runs under the bare-Node tests. The
 * rule it enforces: a stored voice is never swapped for another one without
 * telling the user. The one silent path is an engine remapping an id whose
 * format changed, because that is the same voice under a new name.
 */

export interface LocaleVoice {
	voice: VoiceInfo;
	/** False when nothing matched the locale and this is only a fallback. */
	matched: boolean;
}

export interface StoredVoiceResolution {
	voice: VoiceInfo;
	id: string;
	/** User-facing text when a different voice was substituted, else null. */
	notice: string | null;
}

function normaliseTag(tag: string): string {
	return tag.trim().replace(/_/g, "-").toLowerCase();
}

/**
 * The region a language most likely means, from CLDR likely subtags via
 * Intl.Locale: "en" -> "us", "pt" -> "br", "en-GB" -> "gb". Undefined when
 * the runtime lacks Intl.Locale or the tag does not parse.
 */
function likelyRegion(tag: string): string | undefined {
	try {
		const region = new Intl.Locale(tag).maximize().region;
		return region ? region.toLowerCase() : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Best voice for a locale, preferring a plain voice over a variant at each
 * step: the exact tag; then the language's likely region ("en" means en-US,
 * not whichever en-* row happens to be listed first, which on
 * speech-dispatcher is English (Caribbean)); then a sub-region of it
 * (en-US-NYC); then any voice in the language. Only when nothing matches
 * does it fall back to the first voice, and `matched: false` says so.
 */
export function pickLocaleVoice(voices: VoiceInfo[], locale: string): LocaleVoice | undefined {
	if (voices.length === 0) return undefined;
	const want = normaliseTag(locale);
	const primary = want.split("-")[0] ?? "";
	const region = want ? likelyRegion(want) : undefined;
	const likely = primary && region ? `${primary}-${region}` : undefined;

	const pick = (pred: (tag: string) => boolean): VoiceInfo | undefined => {
		const hits = voices.filter((v) => pred(normaliseTag(v.lang)));
		return hits.find((v) => !v.isVariant) ?? hits[0];
	};

	const found =
		(want ? pick((tag) => tag === want) : undefined) ??
		(likely ? pick((tag) => tag === likely) : undefined) ??
		(likely ? pick((tag) => tag.startsWith(`${likely}-`)) : undefined) ??
		(primary ? pick((tag) => tag.split("-")[0] === primary) : undefined);
	if (found) return { voice: found, matched: true };
	return { voice: voices.find((v) => !v.isVariant) ?? voices[0]!, matched: false };
}

/**
 * Resolve the stored voice id against what the engine offers now.
 *
 * Order: exact id, then the engine's own remap of an old id format (silent),
 * then a locale-based substitute with a notice naming both voices.
 */
export function resolveStoredVoice(
	engine: SpeechEngine,
	storedId: string,
	voices: VoiceInfo[],
	locale: string,
): StoredVoiceResolution {
	const exact = voices.find((v) => v.id === storedId);
	if (exact) return { voice: exact, id: exact.id, notice: null };

	const remapped = storedId ? engine.resolveVoiceId?.(storedId, voices) : undefined;
	if (remapped) return { voice: remapped, id: remapped.id, notice: null };

	const choice = pickLocaleVoice(voices, locale);
	if (!choice) throw new Error("No voices to choose from");
	const { voice, matched } = choice;

	const missing = storedId ? `The voice "${storedId}" is not available in ${engine.label}.` : `No ${engine.label} voice was selected.`;
	const why = matched
		? `it matches the app language (${locale})`
		: `no voice matches the app language (${locale})`;
	const notice = `${missing} Using "${voice.name}" (${voice.lang}) instead; ${why}. Pick another in settings.`;
	return { voice, id: voice.id, notice };
}
