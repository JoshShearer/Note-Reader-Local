/**
 * User-defined skip patterns (docs/adr/0041).
 *
 * A pattern is matched against the note's raw markdown and only ever yields
 * source ranges. Extraction drops the spoken characters that came from inside
 * them, so a pattern can remove speech but cannot change how any other line is
 * parsed, and `sourceIndex` stays in lockstep (non-negotiable 8).
 *
 * No error here carries note text. `RegExp`'s message quotes the pattern, which
 * is why it is only ever shown in the settings row the user is typing in, and
 * never traced (non-negotiable 1).
 */

export interface SkipPattern {
	/** A JavaScript regular expression source, without slashes or flags. */
	pattern: string;
	enabled: boolean;
}

export type CompiledSkipPattern = { regex: RegExp } | { error: string };

/**
 * `g` for every match and `m` so `^` and `$` mean a line, which is what
 * `^Source:.*$` has to mean in a note.
 *
 * `u` first, so `.` cannot match half an emoji. Its stricter grammar rejects
 * things people type and that plain JavaScript accepts (`{{.*?}}`, `\-`), so
 * those fall back to the lenient grammar rather than being called invalid.
 */
export function compileSkipPattern(pattern: string): CompiledSkipPattern {
	try {
		return { regex: new RegExp(pattern, "gmu") };
	} catch {
		// The lenient grammar below decides whether it is really invalid.
	}
	try {
		return { regex: new RegExp(pattern, "gm") };
	} catch (err) {
		return { error: err instanceof Error ? err.message : "Invalid regular expression" };
	}
}

function splitsSurrogatePair(source: string, at: number): boolean {
	if (at <= 0 || at >= source.length) return false;
	const before = source.charCodeAt(at - 1);
	const after = source.charCodeAt(at);
	return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/**
 * Every `[start, end)` source range an enabled pattern matches, unsorted and
 * possibly overlapping. Invalid and empty patterns are ignored, so a typo in
 * one row costs that row and never the read.
 */
export function skipPatternRanges(source: string, patterns: readonly SkipPattern[]): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	for (const { pattern, enabled } of patterns) {
		if (!enabled || pattern === "") continue;
		const compiled = compileSkipPattern(pattern);
		if ("error" in compiled) continue;
		for (const match of source.matchAll(compiled.regex)) {
			let start = match.index;
			let end = start + match[0].length;
			if (end === start) continue;
			// Only the lenient grammar can land here: a lone surrogate must never
			// reach an engine.
			if (splitsSurrogatePair(source, start)) start -= 1;
			if (splitsSurrogatePair(source, end)) end += 1;
			out.push([start, end]);
		}
	}
	return out;
}
