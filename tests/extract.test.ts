import { extractChunks } from "../src/text/extract.ts";
import { rendererPercentBlocks } from "../src/text/obsidianBlocks.ts";
import {
	graphemeBoundaries,
	legacySentenceBoundaries,
	noSegmenters,
	platformSegmenters,
	sentenceBoundaries,
	uax29GraphemeBoundaries,
} from "../src/text/segment.ts";
import { findWords } from "../src/audio/words.ts";
import type { SpeechChunk } from "../src/audio/types.ts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Mirrors DEFAULT_SETTINGS, so a fixture written without overrides asserts what
// a user with untouched settings actually hears. `locale` is not a setting: it
// is the Obsidian UI language, which main.ts reads from appLocale() at the one
// call site. "en" is both the appLocale() fallback and the worst case for this
// suite's non-English fixtures, since it is what a user with an English UI
// reading a Chinese note actually gets.
const OPTS = {
	stripTags: true,
	speakUrls: false,
	skipCodeBlocks: true,
	skipInlineCode: true,
	skipTables: true,
	skipHeadings: false,
	skipFrontmatter: true,
	speakImageAlt: true,
	speakEmbeds: false,
	locale: "en",
};

let failures = 0;

function check(name: string, cond: boolean, detail = ""): void {
	if (cond) {
		console.log(`  ok   ${name}`);
	} else {
		failures += 1;
		console.log(`  FAIL ${name} ${detail}`);
	}
}

/**
 * Every spoken code UNIT is the raw code unit its sourceIndex entry claims.
 *
 * Numeric and UTF-16-based on purpose. The obvious spelling,
 * `[...text].every((ch, i) => raw[sourceIndex[i]] === ch)`, iterates code
 * POINTS, so its `i` stops matching the `sourceIndex` slot as soon as a
 * fixture holds an astral character. Measured on `"x😀yz"` with a correct
 * index: the spread form compares the two-unit `😀` against the one-unit
 * `raw[1]`, returns false on correct data, and reads only 4 of the 5
 * `sourceIndex` slots - the trailing ones are never inspected at all. It is
 * therefore unusable on astral input in either direction, which is why no
 * astral fixture could join the shared corpora before this.
 *
 * A synthesised space (32) is exempt, since it exists in neither input.
 * `allow` covers the one other exemption: a character of the synthetic word
 * "equation" maps to a `$` of the math span it replaces (ADR 0004).
 */
function unitsMatch(
	text: string,
	sourceIndex: number[],
	raw: string,
	allow?: (text: string, i: number, at: number) => boolean,
): boolean {
	if (sourceIndex.length !== text.length) return false;
	for (let i = 0; i < text.length; i++) {
		const at = sourceIndex[i]!;
		if (text.charCodeAt(i) === 32) continue;
		if (raw.charCodeAt(at) === text.charCodeAt(i)) continue;
		if (allow && allow(text, i, at)) continue;
		return false;
	}
	return true;
}

console.log("frontmatter, code fences and tables are skipped");
{
	const src = [
		"---",
		"title: My Note",
		"tags: [secret]",
		"---",
		"Real prose here.",
		"```js",
		"const secret = 1;",
		"```",
		"| a | b |",
		"| - | - |",
		"More prose.",
	].join("\n");
	const chunks = extractChunks(src, OPTS);
	const spoken = chunks.map((c) => c.text).join(" ");
	check("drops frontmatter keys", !spoken.includes("title"));
	check("drops code", !spoken.includes("secret"));
	check("drops table row", !spoken.includes("|"));
	check("keeps prose", spoken.includes("Real prose here."));
	check("keeps prose after fence", spoken.includes("More prose."));
}

console.log("inline syntax is stripped but words survive");
{
	const src = "Read **bold** and *italics* and ~~struck~~ now.";
	const chunks = extractChunks(src, OPTS);
	const spoken = chunks.map((c) => c.text).join(" ");
	check("no asterisks", !spoken.includes("*"), `got: ${spoken}`);
	check("no tildes", !spoken.includes("~"), `got: ${spoken}`);
	check("words intact", spoken === "Read bold and italics and struck now.", `got: ${spoken}`);
}

console.log("inline code content is dropped, not read aloud");
{
	const src = "Call `git commit` to save.";
	const chunks = extractChunks(src, OPTS);
	const spoken = chunks.map((c) => c.text).join(" ");
	check("no backticks", !spoken.includes("`"), `got: ${spoken}`);
	check("no code content", !spoken.includes("git commit"), `got: ${spoken}`);
	check("prose survives", spoken.includes("Call") && spoken.includes("to save"), `got: ${spoken}`);
}

console.log("links keep label, drop target");
{
	const src = "See [the docs](https://example.com/page) and https://bare.example.org/x for more.";
	const chunks = extractChunks(src, OPTS);
	const spoken = chunks.map((c) => c.text).join(" ");
	check("keeps label", spoken.includes("the docs"), `got: ${spoken}`);
	check("drops inline target", !spoken.includes("example.com/page"), `got: ${spoken}`);
	check("drops bare url", !spoken.includes("bare.example.org"), `got: ${spoken}`);
}

console.log("images follow speakImageAlt, and never speak the destination");
{
	const src = "Before ![alt text](img.png) after.";
	// The original assertions, now in the position that produces them.
	const dropped = extractChunks(src, { ...OPTS, speakImageAlt: false })
		.map((c) => c.text)
		.join(" ");
	check("speakImageAlt off: no alt text", !dropped.includes("alt text"), `got: ${dropped}`);
	check("speakImageAlt off: no image path", !dropped.includes("img.png"), `got: ${dropped}`);
	check("speakImageAlt off: whole construct gone", dropped === "Before after.", `got: ${dropped}`);

	const spokenAlt = extractChunks(src, { ...OPTS, speakImageAlt: true })
		.map((c) => c.text)
		.join(" ");
	check("speakImageAlt on: alt text spoken", spokenAlt === "Before alt text after.", `got: ${spokenAlt}`);
	check("speakImageAlt on: still no image path", !spokenAlt.includes("img.png"), `got: ${spokenAlt}`);
}

console.log("headings and list markers");
{
	const src = ["# Title Here", "- first item", "1. second item", "> quoted"].join("\n");
	const chunks = extractChunks(src, OPTS);
	const spoken = chunks.map((c) => c.text).join(" ");
	check("heading text kept", spoken.includes("Title Here"), `got: ${spoken}`);
	check("no hash", !spoken.includes("#"), `got: ${spoken}`);
	check("no dash", !spoken.startsWith("-"), `got: ${spoken}`);
	check("no ordered marker", !spoken.includes("1."), `got: ${spoken}`);
	check("no blockquote", !spoken.includes(">"), `got: ${spoken}`);
}

console.log("offsets point at the original characters");
{
	const src = "Read **bold** text now.";
	const chunks = extractChunks(src, OPTS);
	const c = chunks[0]!;
	const sliced = src.slice(c.sourceStart, c.sourceEnd);
	check(
		"slice covers the sentence",
		sliced.replace(/[*\s]/g, "") === "Readboldtextnow.",
		`got: ${JSON.stringify(sliced)}`,
	);
}

console.log("word-level offsets align with source for each chunk");
{
	const src = "Alpha beta gamma delta.";
	const chunks = extractChunks(src, OPTS);
	const c = chunks[0]!;
	for (const word of ["Alpha", "beta", "gamma", "delta."]) {
		const at = c.text.indexOf(word);
		check(`"${word}" found in chunk`, at >= 0);
		const srcOffset = c.sourceStart + at;
		check(
			`"${word}" lands on source text`,
			src.slice(srcOffset, srcOffset + word.length) === word,
			`got ${JSON.stringify(src.slice(srcOffset, srcOffset + word.length))}`,
		);
	}
}

console.log("sentences split, long ones hard-split");
{
	const src = "One two three. Four five six. " + "word ".repeat(120).trim() + ".";
	const chunks = extractChunks(src, OPTS);
	check("multiple chunks", chunks.length >= 3, `got ${chunks.length}`);
	check(
		"no chunk exceeds the cap",
		chunks.every((c) => c.text.length <= 240),
		`longest ${Math.max(...chunks.map((c) => c.text.length))}`,
	);
	check("no empty chunks", chunks.every((c) => c.text.trim().length > 0));
}

console.log("soft-wrapped paragraph lines are joined before sentence-splitting");
{
	// No blank line between these: markdown treats them as one paragraph, so
	// they should read as a single continuous passage, not pause at every
	// source line break the way the raw .md file happens to be wrapped.
	const src = ["This is the first wrapped line", "and this is the second wrapped line."].join("\n");
	const chunks = extractChunks(src, OPTS);
	check("wrapped lines merge into one chunk", chunks.length === 1, `got ${chunks.length}`);
	const spoken = chunks.map((c) => c.text).join(" ");
	check(
		"both halves present",
		spoken.includes("first wrapped line") && spoken.includes("second wrapped line"),
		`got: ${spoken}`,
	);
	for (const word of ["first", "wrapped", "second", "line."]) {
		const c = chunks[0]!;
		const at = c.text.indexOf(word);
		if (at < 0) continue; // "wrapped" appears twice; only check the ones present once is fine
		const srcOffset = c.sourceStart + at;
		check(
			`"${word}" lands on source text across the join`,
			src.slice(srcOffset, srcOffset + word.length) === word,
			`got ${JSON.stringify(src.slice(srcOffset, srcOffset + word.length))}`,
		);
	}
}

console.log("a blank line still marks a real paragraph break");
{
	const src = ["First paragraph.", "", "Second paragraph."].join("\n");
	const chunks = extractChunks(src, OPTS);
	check("blank line keeps paragraphs separate", chunks.length === 2, `got ${chunks.length}`);
}

console.log("headings and list items are not folded into surrounding prose");
{
	const src = ["Prose before.", "# A heading", "Prose after."].join("\n");
	const chunks = extractChunks(src, OPTS);
	check("three separate chunks", chunks.length === 3, `got ${chunks.length}`);
	check("heading text present", chunks.some((c) => c.text.includes("A heading")));
	check("before text present", chunks.some((c) => c.text.includes("Prose before")));
	check("after text present", chunks.some((c) => c.text.includes("Prose after")));
}

console.log("skipTables (not the code toggles) governs whether table rows are dropped");
{
	const src = ["Before table.", "| a | b |", "| - | - |", "After table."].join("\n");

	const tablesSkipped = extractChunks(src, { ...OPTS, skipCodeBlocks: false, skipInlineCode: false, skipTables: true });
	check(
		"table dropped when skipTables is true, regardless of the code toggles",
		!tablesSkipped.some((c) => c.text.includes("|")),
	);

	const tablesKept = extractChunks(src, { ...OPTS, skipCodeBlocks: true, skipInlineCode: true, skipTables: false });
	check(
		"table kept when skipTables is false, regardless of the code toggles",
		tablesKept.some((c) => c.text.includes("|")),
		`got: ${tablesKept.map((c) => c.text).join(" | ")}`,
	);
}

console.log("obsidian tags dropped, mid-sentence hashes kept");
{
	const src = "Read #project/today notes about C# and item #3 today.";
	const chunks = extractChunks(src, OPTS);
	const spoken = chunks.map((c) => c.text).join(" ");
	check("tag dropped", !spoken.includes("#project"), `got: ${spoken}`);
	check("C# kept", spoken.includes("C#"), `got: ${spoken}`);
}

console.log("frontmatter detection (NRL-7)");
{
	const texts = (src: string): string[] => extractChunks(src, OPTS).map((c) => c.text);

	// (a) A leading horizontal rule followed by prose is not frontmatter.
	const a = "---\nSome prose here.\nMore prose.";
	const aChunks = extractChunks(a, OPTS);
	const aSpoken = aChunks.map((c) => c.text).join(" ");
	check("leading HR then prose is read in full", aSpoken === "Some prose here. More prose.", `got: ${JSON.stringify(aSpoken)}`);
	check(
		"leading HR: first spoken char maps to 'Some'",
		aChunks[0]?.sourceIndex[0] === a.indexOf("Some") && aChunks[0]?.sourceStart === a.indexOf("Some"),
		`got: ${aChunks[0]?.sourceIndex[0]} / ${aChunks[0]?.sourceStart}`,
	);

	// (b) One leading blank line must not expose the frontmatter.
	const b = texts("\n---\ntitle: secret\n---\nProse follows here.");
	check("blank-line-prefixed frontmatter is skipped", !b.join(" ").includes("secret"), `got: ${JSON.stringify(b)}`);
	check("prose after blank-line-prefixed frontmatter is read", b.join(" ") === "Prose follows here.", `got: ${JSON.stringify(b)}`);

	// (c) Several blank lines, several keys; offsets must still be raw offsets.
	const c = "\n\n---\ntitle: x\ntags: [a]\n---\nProse.";
	const cChunks = extractChunks(c, OPTS);
	check("multi-key frontmatter after blank lines is skipped", cChunks.map((k) => k.text).join(" ") === "Prose.", `got: ${JSON.stringify(cChunks.map((k) => k.text))}`);
	check(
		"skipped frontmatter: first spoken char maps to 'Prose.'",
		cChunks[0]?.sourceIndex[0] === c.indexOf("Prose.") && cChunks[0]?.sourceStart === c.indexOf("Prose."),
		`got: ${cChunks[0]?.sourceIndex[0]} / ${cChunks[0]?.sourceStart}`,
	);
	check(
		"skipped frontmatter: every index entry points at the character it spoke",
		cChunks.every((k) => unitsMatch(k.text, k.sourceIndex, c)),
	);

	// (d) An unterminated opening fence must not swallow the document.
	const d = texts("---\ntitle: x\nProse never closed.");
	check("unterminated fence does not silence the note", d.length > 0, `got: ${JSON.stringify(d)}`);
	check("unterminated fence: prose is read", d.join(" ").includes("Prose never closed."), `got: ${JSON.stringify(d)}`);
	check("unterminated fence: the fence itself is silent", !d.join(" ").includes("-"), `got: ${JSON.stringify(d)}`);

	// (e) Horizontal rules in the body are silent and toggle nothing.
	for (const hr of ["---", "***", "- - -", "___"]) {
		const e = texts(`Para one.\n\n${hr}\n\nPara two.`);
		check(`body HR ${JSON.stringify(hr)} is silent`, e.join(" ") === "Para one. Para two.", `got: ${JSON.stringify(e)}`);
	}
	const fenceAfterHr = texts("Intro.\n\n---\n\n```\nconst secret = 1;\n```\n\nOutro.");
	check(
		"HR does not disturb a later code fence",
		fenceAfterHr.join(" ") === "Intro. Outro.",
		`got: ${JSON.stringify(fenceAfterHr)}`,
	);
	const twoHrs = texts("One.\n\n---\n\nTwo.\n\n---\n\nThree.");
	check("paired body HRs are not treated as a frontmatter block", twoHrs.join(" ") === "One. Two. Three.", `got: ${JSON.stringify(twoHrs)}`);

	// (f) Not valid YAML, but key-shaped: skipped (see ADR 0002).
	const f = texts("---\nnot: really: valid: yaml\n---\nProse.");
	check("key-shaped but invalid YAML is skipped", f.join(" ") === "Prose.", `got: ${JSON.stringify(f)}`);

	// (g) Block lists and comments inside frontmatter.
	const g = texts("---\ntags:\n  - a\n# c\n---\nProse.");
	check("frontmatter with list items and comments is skipped", g.join(" ") === "Prose.", `got: ${JSON.stringify(g)}`);

	// A fenced block of prose at the top is two HRs around a paragraph.
	const h = texts("---\nJust a sentence.\n---\nProse.");
	check("fenced prose at the top is read", h.join(" ") === "Just a sentence. Prose.", `got: ${JSON.stringify(h)}`);

	// Key shapes the old positional check skipped and a narrow ASCII rule would
	// have started speaking: non-English, quoted, punctuated keys, a flow list
	// wrapped over unindented lines, a BOM, an indented fence.
	const shapes: Record<string, string> = {
		"accented key": "---\ntítulo: secret\n---\nProse.",
		"CJK key": "---\n日付: secret\n---\nProse.",
		"quoted key": "---\n\"my key\": secret\n---\nProse.",
		"key with parens": "---\ncreated (date): secret\n---\nProse.",
		"wrapped flow list": "---\ntags: [a,\nsecret]\n---\nProse.",
		"leading BOM": "\uFEFF---\ntitle: secret\n---\nProse.",
		"indented fence": "  ---\ntitle: secret\n---\nProse.",
		"CRLF after blank line": "\r\n---\r\ntitle: secret\r\n---\r\nProse.",
	};
	for (const [name, src] of Object.entries(shapes)) {
		const got = texts(src);
		check(`frontmatter with ${name} is skipped`, got.join(" ") === "Prose.", `got: ${JSON.stringify(got)}`);
	}

	// Offset invariant over every fixture in this section.
	const all = [a, "\n---\ntitle: secret\n---\nProse follows here.", c, "---\ntitle: x\nProse never closed.",
		"Para one.\n\n- - -\n\nPara two.", "---\nJust a sentence.\n---\nProse.", ...Object.values(shapes)];
	check(
		"sourceIndex.length === text.length for every chunk",
		all.every((src) => extractChunks(src, OPTS).every((k) => k.sourceIndex.length === k.text.length)),
	);
}

console.log("wikilinks and embeds (NRL-6)");
{
	const spokenOf = (src: string, opts = OPTS): string => extractChunks(src, opts).map((c) => c.text).join(" ");

	// Every non-space spoken char must be the raw char it claims to come from.
	const lockstep = (src: string): boolean =>
		extractChunks(src, OPTS).every(
			(k) =>
				k.sourceIndex.length === k.text.length &&
				// Numeric UTF-16 indexing, never a spread; see unitsMatch for
				// what a spread does to an astral fixture.
				unitsMatch(k.text, k.sourceIndex, src),
		);

	const plain = "See [[Some Note]] today please.";
	check("[[Note]] speaks the target", spokenOf(plain) === "See Some Note today please.", `got: ${JSON.stringify(spokenOf(plain))}`);

	const alias = "Read [[Some Note|the alias]] now please.";
	const aliasSpoken = spokenOf(alias);
	check("[[Note|alias]] speaks the alias only", aliasSpoken === "Read the alias now please.", `got: ${JSON.stringify(aliasSpoken)}`);
	check("[[Note|alias]] target and pipe absent", !aliasSpoken.includes("Some Note") && !aliasSpoken.includes("|"), `got: ${JSON.stringify(aliasSpoken)}`);

	const emptyAlias = spokenOf("Read [[Some Note|]] now please.");
	check("[[Note|]] falls back to the target", emptyAlias === "Read Some Note now please.", `got: ${JSON.stringify(emptyAlias)}`);

	const headings: Record<string, string> = {
		"Go to [[Note#Section]] for more detail.": "Go to Note Section for more detail.",
		"Go to [[#Section]] for more detail.": "Go to Section for more detail.",
		"Go to [[Note#A#B]] for more detail.": "Go to Note A B for more detail.",
		"Go to [[Note#^abc123]] for more detail.": "Go to Note for more detail.",
		"Go to [[#^abc123]] for more detail.": "Go to for more detail.",
	};
	for (const [src, want] of Object.entries(headings)) {
		const got = spokenOf(src);
		check(`${JSON.stringify(src)} speaks ${JSON.stringify(want)}`, got === want, `got: ${JSON.stringify(got)}`);
		check(`${JSON.stringify(src)} never speaks # or ^`, !got.includes("#") && !got.includes("^"), `got: ${JSON.stringify(got)}`);
	}
	// The tag branch must not eat #Section, whatever stripTags says.
	const tagsOff = spokenOf("Go to [[Note#Section]] for more detail.", { ...OPTS, stripTags: false });
	check("[[Note#Section]] with stripTags off", tagsOff === "Go to Note Section for more detail.", `got: ${JSON.stringify(tagsOff)}`);

	const embed = "Before ![[Some Note]] after the embed.";
	const embedSpoken = spokenOf(embed, { ...OPTS, speakEmbeds: false });
	check("![[Note]] is dropped cleanly", embedSpoken === "Before after the embed.", `got: ${JSON.stringify(embedSpoken)}`);
	check("![[Note]] leaves no stray bracket or target", !embedSpoken.includes("]") && !embedSpoken.includes("Some Note"), `got: ${JSON.stringify(embedSpoken)}`);
	// The other position: the same reduction the `[[` branch uses, shared.
	const embedOn = spokenOf(embed, { ...OPTS, speakEmbeds: true });
	check("![[Note]] with speakEmbeds on speaks the target", embedOn === "Before Some Note after the embed.", `got: ${JSON.stringify(embedOn)}`);
	check("![[Note]] with speakEmbeds on leaves no bracket", !embedOn.includes("[") && !embedOn.includes("]"), `got: ${JSON.stringify(embedOn)}`);

	const unterminated = spokenOf("An open [[wikilink never closes here.");
	check("unterminated [[ drops the brackets and reads on", unterminated === "An open wikilink never closes here.", `got: ${JSON.stringify(unterminated)}`);

	// A callout marker is only a callout inside a blockquote (NRL-8). A bare
	// [!note] line is not one in Obsidian either, so it still takes the
	// single-bracket inline path.
	const callout = spokenOf("> [!note] Callout body text here.");
	check("quoted [!note] callout drops its marker", callout === "Callout body text here.", `got: ${JSON.stringify(callout)}`);
	const bareCallout = spokenOf("[!note] Callout body text here.");
	check("bare [!note] line keeps the single-bracket path", bareCallout === "!note Callout body text here.", `got: ${JSON.stringify(bareCallout)}`);

	// Offsets: a word after a wikilink maps to its true raw offset.
	const off = "See [[Some Note|alias]] today.";
	const oc = extractChunks(off, OPTS)[0]!;
	check(
		"word after a wikilink maps to its raw offset",
		oc.sourceIndex[oc.text.indexOf("today")] === off.indexOf("today"),
		`got: ${oc.sourceIndex[oc.text.indexOf("today")]} want ${off.indexOf("today")}`,
	);
	check(
		"alias chars map to the raw alias",
		oc.sourceIndex[oc.text.indexOf("alias")] === off.indexOf("alias"),
		`got: ${oc.sourceIndex[oc.text.indexOf("alias")]} want ${off.indexOf("alias")}`,
	);
	const eo = extractChunks(embed, OPTS)[0]!;
	check(
		"word after an embed maps to its raw offset",
		eo.sourceIndex[eo.text.indexOf("after")] === embed.indexOf("after"),
		`got: ${eo.sourceIndex[eo.text.indexOf("after")]} want ${embed.indexOf("after")}`,
	);

	const fixtures = [plain, alias, off, embed, "Read [[Some Note|]] now please.", "An open [[wikilink never closes here.",
		"[!note] Callout body text here.", "> [!note] Callout body text here.", "Line one [[A|b]] and\n![[img.png]] then [[C#D]] end.", ...Object.keys(headings)];
	for (const src of fixtures) {
		check(`sourceIndex lockstep for ${JSON.stringify(src)}`, lockstep(src));
	}
}

console.log("code and bare URL toggles (NRL-10)");
{
	const spokenWith = (src: string, opts: typeof OPTS): string =>
		extractChunks(src, opts).map((c) => c.text).join(" ");
	const lockstepWith = (src: string, opts: typeof OPTS): boolean =>
		extractChunks(src, opts).every(
			(k) =>
				k.sourceIndex.length === k.text.length &&
				// Numeric UTF-16 indexing, never a spread; see unitsMatch for
				// what a spread does to an astral fixture.
				unitsMatch(k.text, k.sourceIndex, src),
		);
	// Offset of the spoken `word` in the first chunk that contains it.
	const offsetOf = (src: string, opts: typeof OPTS, word: string): number | undefined => {
		const k = extractChunks(src, opts).find((c) => c.text.includes(word));
		return k ? k.sourceIndex[k.text.indexOf(word)] : undefined;
	};
	const codeOn = { ...OPTS, skipCodeBlocks: false, skipInlineCode: false };
	const urlsOn = { ...OPTS, speakUrls: true };

	// Inline code.
	const inline = "Call `git commit` to save.";
	const inlineSpoken = spokenWith(inline, { ...OPTS, skipInlineCode: false });
	check("skipInlineCode false speaks the code", inlineSpoken === "Call git commit to save.", `got: ${JSON.stringify(inlineSpoken)}`);
	const inlineDropped = spokenWith(inline, { ...OPTS, skipInlineCode: true });
	check("skipInlineCode true drops the code", inlineDropped === "Call to save.", `got: ${JSON.stringify(inlineDropped)}`);
	const inlineRepro = "Call `git commit` now to save.";
	for (const [label, opts] of [["off", { ...OPTS, skipInlineCode: false }], ["on", OPTS]] as const) {
		const got = offsetOf(inlineRepro, opts, "now");
		check(`word after inline code maps to its raw offset (skip ${label})`, got === inlineRepro.indexOf("now"), `got: ${got}`);
	}
	const codeOff = offsetOf(inlineRepro, { ...OPTS, skipInlineCode: false }, "git");
	check("inline code chars map to the raw code", codeOff === inlineRepro.indexOf("git"), `got: ${codeOff}`);
	for (const opts of [OPTS, { ...OPTS, skipInlineCode: false }]) {
		const got = spokenWith("An open ` tick here.", opts);
		check(`unterminated backtick is dropped (skipInlineCode ${opts.skipInlineCode})`, got === "An open tick here.", `got: ${JSON.stringify(got)}`);
	}

	// Fenced code.
	const fenced = ["Intro line.", "", "```js", "const answer = 42;", "", "  return   answer;", "```", "", "After."].join("\n");
	const fencedSpoken = spokenWith(fenced, { ...OPTS, skipCodeBlocks: false });
	check(
		"skipCodeBlocks false speaks the block content",
		fencedSpoken === "Intro line. const answer = 42; return answer; After.",
		`got: ${JSON.stringify(fencedSpoken)}`,
	);
	check("fence line and info string never spoken", !fencedSpoken.includes("`") && !/\bjs\b/.test(fencedSpoken), `got: ${JSON.stringify(fencedSpoken)}`);
	const tildes = spokenWith("Before.\n~~~\nlet y = 2;\n~~~\nAfter.", { ...OPTS, skipCodeBlocks: false });
	check("~~~ fences speak content too", tildes === "Before. let y = 2; After.", `got: ${JSON.stringify(tildes)}`);
	const fencedDropped = spokenWith(fenced, { ...OPTS, skipCodeBlocks: true });
	check("skipCodeBlocks true drops the block", fencedDropped === "Intro line. After.", `got: ${JSON.stringify(fencedDropped)}`);
	const retOff = offsetOf(fenced, { ...OPTS, skipCodeBlocks: false }, "return");
	check("fenced content maps to its raw offset", retOff === fenced.indexOf("return"), `got: ${retOff}`);
	for (const opts of [OPTS, { ...OPTS, skipCodeBlocks: false }]) {
		const got = offsetOf(fenced, opts, "After");
		check(`prose after a fence maps to its raw offset (skipCodeBlocks ${opts.skipCodeBlocks})`, got === fenced.indexOf("After"), `got: ${got}`);
	}

	// Bare URLs.
	const urlCases: Array<[string, string, string]> = [
		["See https://example.com/a/b?c=d now.", "See example.com now.", "See now."],
		["Visit www.example.com today.", "Visit example.com today.", "Visit today."],
		["https://www.example.com/x?y#z", "example.com", ""],
		["Go to http://localhost:8080/path now.", "Go to localhost now.", "Go to now."],
	];
	for (const [src, speak, drop] of urlCases) {
		const on = spokenWith(src, urlsOn);
		check(`speakUrls true: ${JSON.stringify(src)} -> ${JSON.stringify(speak)}`, on === speak, `got: ${JSON.stringify(on)}`);
		const off = spokenWith(src, OPTS);
		check(`speakUrls false: ${JSON.stringify(src)} -> ${JSON.stringify(drop)}`, off === drop, `got: ${JSON.stringify(off)}`);
	}
	const glued = spokenWith("Read it at https://example.com.", urlsOn);
	check("trailing period glued to a URL is not part of the host", glued === "Read it at example.com", `got: ${JSON.stringify(glued)}`);
	const urlRepro = "See https://example.com/x now please.";
	for (const opts of [OPTS, urlsOn]) {
		const got = offsetOf(urlRepro, opts, "now");
		check(`word after a URL maps to its raw offset (speakUrls ${opts.speakUrls})`, got === urlRepro.indexOf("now"), `got: ${got}`);
	}
	const hostOff = offsetOf(urlRepro, urlsOn, "example.com");
	check("host chars map to the raw host", hostOff === urlRepro.indexOf("example.com"), `got: ${hostOff}`);
	const wwwSrc = "Visit www.example.com today.";
	const wwwOff = offsetOf(wwwSrc, urlsOn, "example.com");
	check("host after www. maps to the raw host", wwwOff === wwwSrc.indexOf("example.com"), `got: ${wwwOff}`);

	// Userinfo is credentials. Speaking it would read a username, or a
	// password, aloud; only the host after the last "@" of the authority may
	// be spoken.
	const userinfoCases: Array<[string, string]> = [
		["Log in at https://user@example.com/ now.", "Log in at example.com now."],
		["Log in at https://user:secret@example.com/ now.", "Log in at example.com now."],
		["Log in at https://user:secret@www.example.com:8443/x now.", "Log in at example.com now."],
		["Log in at https://user:p@ss@example.com/ now.", "Log in at example.com now."],
	];
	for (const [src, speak] of userinfoCases) {
		const on = spokenWith(src, urlsOn);
		check(`userinfo dropped: ${JSON.stringify(src)} -> ${JSON.stringify(speak)}`, on === speak, `got: ${JSON.stringify(on)}`);
		check(`neither user nor secret spoken: ${JSON.stringify(src)}`, !/user|secret|ss/.test(on), `got: ${JSON.stringify(on)}`);
		const hostAt = offsetOf(src, urlsOn, "example.com");
		check(`host after userinfo maps to the raw host: ${JSON.stringify(src)}`, hostAt === src.lastIndexOf("example.com"), `got: ${hostAt}`);
		check(`sourceIndex lockstep with userinfo: ${JSON.stringify(src)}`, lockstepWith(src, urlsOn));
	}
	// An "@" after the authority is path or query, not userinfo.
	const atInPath = spokenWith("See https://example.com/@someone now.", urlsOn);
	check("@ in the path does not move the host", atInPath === "See example.com now.", `got: ${JSON.stringify(atInPath)}`);
	const atInQuery = spokenWith("See https://example.com?to=a@b.org now.", urlsOn);
	check("@ in the query does not move the host", atInQuery === "See example.com now.", `got: ${JSON.stringify(atInQuery)}`);

	// Markdown links and wikilinks are handled before the URL branch.
	for (const opts of [OPTS, urlsOn]) {
		const link = spokenWith("See [the docs](https://example.com/page) now.", opts);
		check(`[label](url) unchanged (speakUrls ${opts.speakUrls})`, link === "See the docs now.", `got: ${JSON.stringify(link)}`);
		const wiki = spokenWith("See [[Some Note]] today please.", opts);
		check(`wikilink unchanged (speakUrls ${opts.speakUrls})`, wiki === "See Some Note today please.", `got: ${JSON.stringify(wiki)}`);
	}

	const fixtures = [inline, inlineRepro, "An open ` tick here.", fenced, "Before.\n~~~\nlet y = 2;\n~~~\nAfter.",
		...urlCases.map(([src]) => src), "Read it at https://example.com.", urlRepro,
		"See [the docs](https://example.com/page) now."];
	for (const src of fixtures) {
		for (const opts of [OPTS, codeOn, urlsOn]) {
			check(`sourceIndex lockstep for ${JSON.stringify(src)} (${JSON.stringify({ c: opts.skipCodeBlocks, u: opts.speakUrls })})`, lockstepWith(src, opts));
		}
	}
}

console.log("inline markup (NRL-9)");
{
	const spokenOf = (src: string, opts = OPTS): string[] => extractChunks(src, opts).map((c) => c.text);
	const spoken = (src: string, opts = OPTS): string => spokenOf(src, opts).join(" ");
	const eq = (name: string, src: string, want: string, opts = OPTS): void => {
		const got = spoken(src, opts);
		check(name, got === want, `got: ${JSON.stringify(got)}`);
	};

	// As the other lockstep helpers, except a char of the synthetic word
	// "equation" maps to a `$` of the math span it replaces, not to itself.
	const lockstep = (src: string, opts = OPTS): boolean =>
		extractChunks(src, opts).every(
			(k) =>
				k.sourceIndex.length === k.text.length &&
				// Numeric UTF-16 indexing, never a spread; see unitsMatch.
				unitsMatch(k.text, k.sourceIndex, src, (text, i, at) => {
					const word = text.lastIndexOf("equation", i);
					return word !== -1 && i < word + 8 && src.charCodeAt(at) === 36;
				}),
		);
	// Raw offset of the first char of `word` in the first chunk containing it.
	const offsetOf = (src: string, word: string, opts = OPTS): number | undefined => {
		const k = extractChunks(src, opts).find((c) => c.text.includes(word));
		return k ? k.sourceIndex[k.text.indexOf(word)] : undefined;
	};
	// The editor highlight words.ts derives for the spoken word "equation".
	const equationRange = (src: string): [number, number] | undefined => {
		const k = extractChunks(src, OPTS).find((c) => c.text.includes("equation"));
		if (!k) return undefined;
		const at = k.text.indexOf("equation");
		return [k.sourceIndex[at]!, k.sourceIndex[at + 7]! + 1];
	};

	// Underscores: intraword is content, flanking is emphasis.
	eq("snake_case_name spoken intact", "The snake_case_name is important here.", "The snake_case_name is important here.");
	eq("a_b spoken intact", "Set a_b to one.", "Set a_b to one.");
	eq("_emph_ and __strong__ drop the markers", "_emph_ and __strong__", "emph and strong");
	eq("spaced underscore kept", "a _ b", "a _ b");
	eq("intraword asterisks still dropped", "a*b*c", "abc");
	eq("spaced asterisk kept", "2 * 3", "2 * 3");
	eq("~~strike~~ drops the tildes", "~~strike~~ it", "strike it");
	eq("single tilde kept", "~5 min", "~5 min");

	// Highlight.
	eq("==highlight== speaks the text only", "Some ==highlighted== text.", "Some highlighted text.");
	eq("a == b is not a highlight", "a == b", "a == b");
	eq("=== is not a highlight", "a === b", "a === b");
	eq("unclosed == is text", "x==y and more", "x==y and more");
	eq("nested markup inside ==", "Some ==**bold** hi== text.", "Some bold hi text.");

	// Inline HTML.
	eq("inline tags stripped, text kept", "Some <b>bold</b> and <br/> text.", "Some bold and text.");
	eq("<br> and <br /> are one space", "one<br>two<br />three", "one two three");
	eq("inline tag inside a word keeps the word", "un<b>bold</b>ed", "unbolded");
	eq("tag with attributes", 'A <span class="x">red</span> word.', "A red word.");
	eq("comparison with spaces is not a tag", "a < b and c > d", "a < b and c > d");
	eq("comparison without spaces is not a tag", "x<y and z>w", "x<y and z>w");
	// Prose between angle brackets that happens to start with a known element
	// name must not be eaten as a tag with bare attributes. Leaked markup is a
	// smaller cost than a lost sentence.
	eq("known element name with prose after is not a tag", "a <b and c> d", "a <b and c> d");
	eq("<i am here> is not a tag", "x <i am here> y", "x <i am here> y");
	eq("unknown bare attribute is not a tag", "a <span foo> b", "a <span foo> b");
	eq("closing tag", "a </b> b", "a b");
	eq("<br/> is a tag", "one<br/>two", "one two");
	eq("<br /> is a tag", "one<br />two", "one two");
	eq("double-quoted attribute", 'A <span class="x">red</span> word.', "A red word.");
	eq("single-quoted attribute", "A <span class='x y'>red</span> word.", "A red word.");
	eq("unquoted attribute", "A <font color=red>red</font> word.", "A red word.");
	eq("known boolean attribute", "A <details open>more</details> end.", "A more end.");
	eq("mixed attributes", '<span hidden title="t" data-x=1>ok</span>', "ok");

	// HTML comments: hidden by the author, so never read aloud.
	eq("inline comment dropped whole", "A <!-- hidden secret --> B.", "A B.");
	const multi = "A <!-- start\nsecret line\nend --> B.\nNext line.";
	const multiSpoken = spoken(multi);
	check("multi-line comment content never spoken", !/secret|start|end|<!--|-->/.test(multiSpoken), `got: ${JSON.stringify(multiSpoken)}`);
	check("multi-line comment keeps text either side", multiSpoken === "A B. Next line.", `got: ${JSON.stringify(multiSpoken)}`);
	const unterminated = spoken("Visible.\n<!-- never closed\nhidden text");
	check("unterminated comment hides to end of note", unterminated === "Visible.", `got: ${JSON.stringify(unterminated)}`);

	// Footnotes.
	eq("footnote reference dropped", "footnote[^1].", "footnote.");
	eq("named footnote reference dropped", "See this[^note] here.", "See this here.");
	eq("footnote definition marker dropped", "[^note]: Text.", "Text.");
	eq("plain link unaffected", "See [the docs](https://x.com) now.", "See the docs now.");

	// Math: currency first, since a false positive eats prose.
	eq("currency spoken verbatim", "I paid $5 and then $10 later.", "I paid $5 and then $10 later.");
	eq("currency range verbatim", "$5-$10", "$5-$10");
	eq("$5$ has no LaTeX shape, stays text", "It was $5$ total.", "It was $5$ total.");
	eq("escaped dollar kept", "Cost \\$5 today.", "Cost $5 today.");
	eq("short inline math dropped", "Let $x$ be real.", "Let be real.");
	eq("short inline math with subscript dropped", "Take $x_1$ first.", "Take first.");
	eq("short inline command dropped", "Angle $\\alpha$ here.", "Angle here.");
	eq("long inline math speaks equation", "$E=mc^2$ holds", "equation holds");
	eq("display math speaks equation", "$$\\int_0^1 f(x)dx$$", "equation");
	eq("display math with backslash", "$$\\int f$$", "equation");
	check("backslash inside math never reaches the escape branch", !/int|\\$/.test(spoken("$$\\int_0^1 f(x)dx$$")));
	const block = spokenOf("$$\na^2\n$$\nAfter.");
	check("multi-line display math is one equation chunk", JSON.stringify(block) === JSON.stringify(["equation", "After."]), `got: ${JSON.stringify(block)}`);
	const openOnly = spoken("$$\nnot closed\nMore prose.");
	check("unterminated $$ does not swallow the note", openOnly.includes("not closed") && openOnly.includes("More prose."), `got: ${JSON.stringify(openOnly)}`);
	eq("math inside a fence untouched", "```\n$$\na\n$$\n```\nAfter.", "After.");

	// Code and paths are not markdown.
	const codeOn = { ...OPTS, skipInlineCode: false };
	eq("a_b in backticks verbatim", "Use `a_b` here.", "Use a_b here.", codeOn);
	eq("$x$ in backticks verbatim", "Use `$x$` here.", "Use $x$ here.", codeOn);
	eq("wikilink target underscores kept", "See [[my_note]] now.", "See my_note now.");
	eq("url underscores untouched when speaking host", "See https://x.com/a_b now.", "See x.com now.", { ...OPTS, speakUrls: true });

	// Offsets of the word after each stripped span (non-negotiable 8).
	const after: Array<[string, string]> = [
		["The snake_case_name is here.", "is"],
		["Some ==hi== text.", "text"],
		["Some <b>x</b> text.", "text"],
		["Some <br/> text.", "text"],
		["Some <!-- c --> text.", "text"],
		["Some[^1] text.", "text"],
		["Let $x$ be real.", "be"],
		["So $E=mc^2$ holds.", "holds"],
		["So $$\\int f$$ holds.", "holds"],
		["$$\na^2\n$$\nAfter.", "After"],
		["A <!-- one\ntwo -->\nAfter.", "After"],
	];
	for (const [src, word] of after) {
		// Each word occurs once, after the span, so lastIndexOf is its raw offset.
		const got = offsetOf(src, word);
		check(`offset of "${word}" after span in ${JSON.stringify(src)}`, got === src.lastIndexOf(word), `got: ${got}, want: ${src.lastIndexOf(word)}`);
	}
	check("snake_case_name keeps its raw offsets", offsetOf("The snake_case_name x.", "snake_case_name") === 4);
	check("highlighted inner word keeps its offset", offsetOf("Some ==hi== text.", "hi") === 7);
	check("bold tag inner word keeps its offset", offsetOf("Some <b>x</b> text.", "x") === 8);

	// "equation" highlights exactly the raw math span.
	const ranges: Array<[string, number, number]> = [
		["So $E=mc^2$ holds.", 3, 11],
		["$$\\int_0^1 f(x)dx$$", 0, 19],
		["Intro.\n\n$$\na^2\n$$\nAfter.", 8, 17],
	];
	for (const [src, from, to] of ranges) {
		const r = equationRange(src);
		check(`equation highlight covers the math span in ${JSON.stringify(src)}`, r !== undefined && r[0] === from && r[1] === to, `got: ${JSON.stringify(r)}, want: [${from},${to}]`);
	}

	const fixtures = [
		"The snake_case_name is important here.", "_emph_ and __strong__", "a*b*c", "~~strike~~ it", "~5 min",
		"Some ==highlighted== text.", "Some ==**bold** hi== text.", "Some <b>bold</b> and <br/> text.", "un<b>bold</b>ed",
		'A <span class="x">red</span> word.', "A <!-- hidden secret --> B.", multi, "footnote[^1].", "[^note]: Text.",
		"I paid $5 and then $10 later.", "Let $x$ be real.", "$E=mc^2$ holds", "$$\\int_0^1 f(x)dx$$",
		"$$\na^2\n$$\nAfter.", "$$\nnot closed\nMore prose.", "Intro.\n\n$$\na^2\n$$ tail words.\nAfter.",
		...after.map(([src]) => src),
	];
	for (const src of fixtures) {
		check(`sourceIndex lockstep for ${JSON.stringify(src)}`, lockstep(src));
		check(`sourceIndex lockstep, code on, for ${JSON.stringify(src)}`, lockstep(src, codeOn));
	}
}

console.log("block markup (NRL-8)");
{
	const HEAD_OFF = { ...OPTS, skipHeadings: true };
	const codeOn = { ...OPTS, skipCodeBlocks: false };
	const texts = (src: string, opts = OPTS): string[] => extractChunks(src, opts).map((c) => c.text);
	const expect = (src: string, want: string[], opts = OPTS, label = ""): void => {
		const got = texts(src, opts);
		check(
			`${JSON.stringify(src)}${label} -> ${JSON.stringify(want)}`,
			JSON.stringify(got) === JSON.stringify(want),
			`got: ${JSON.stringify(got)}`,
		);
	};
	const lockstep = (src: string, opts = OPTS): boolean =>
		extractChunks(src, opts).every(
			(k) =>
				k.sourceIndex.length === k.text.length &&
				// Numeric UTF-16 indexing, never a spread; see unitsMatch for
				// what a spread does to an astral fixture.
				unitsMatch(k.text, k.sourceIndex, src),
		);
	const offsetOf = (src: string, word: string, opts = OPTS): number | undefined => {
		const k = extractChunks(src, opts).find((c) => c.text.includes(word));
		return k ? k.sourceIndex[k.text.indexOf(word)] : undefined;
	};
	const fixtures: string[] = [];
	const add = (src: string, want: string[], opts = OPTS, label = ""): void => {
		fixtures.push(src);
		expect(src, want, opts, label);
	};

	// The three ticket reproductions, exactly.
	add("> [!note] Title\n> Body text goes here.", ["Title", "Body text goes here."]);
	add("- [x] done item in the list", ["done item in the list"]);
	add("My Title\n========\nBody.", ["My Title", "Body."]);

	// Callouts: the type and fold marker are dropped silently (NRL-8 Decision).
	add("> [!tip]+ Expand me\n> Hidden body.", ["Expand me", "Hidden body."]);
	add("> [!warning]- Folded title", ["Folded title"]);
	add("> [!NOTE] Upper case type", ["Upper case type"]);
	add("> [!my-type] Custom type", ["Custom type"]);
	add("> [!note]\n> Only body here.", ["Only body here."]);
	add("> > [!tip]- Nested title", ["Nested title"]);
	add("> > deep quote", ["deep quote"]);
	add("> [!info] Title\n> Line one of body.\n> Line two of body.", ["Title", "Line one of body.", "Line two of body."]);
	// Guards: a quoted link or bracket is not a callout; these must match the
	// unquoted prose path before and after the fix.
	for (const inner of ["[link](x) here", "[text] y"]) {
		const quoted = `> ${inner}`;
		fixtures.push(quoted);
		const got = texts(quoted);
		const want = texts(inner);
		check(`${JSON.stringify(quoted)} is not a callout`, JSON.stringify(got) === JSON.stringify(want), `got: ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
	}

	// Task items: any single status char, state not announced (NRL-8 Decision).
	for (const marker of ["-", "*", "+", "1.", "1)"]) {
		for (const state of [" ", "x", "X", "/", "-", ">", "?"]) {
			add(`${marker} [${state}] task text here`, ["task text here"]);
		}
	}
	add("- a\n    - [ ] nested task", ["a", "nested task"]);
	add("> - [ ] quoted task", ["quoted task"]);
	add("- [ ] todo item", ["todo item"]);
	// Not a checkbox: no space after, or more than one char. Same as prose.
	for (const inner of ["[x]text", "[ab] thing"]) {
		const listed = `- ${inner}`;
		fixtures.push(listed);
		const got = texts(listed);
		const want = texts(inner);
		check(`${JSON.stringify(listed)} is not a task`, JSON.stringify(got) === JSON.stringify(want), `got: ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
	}

	// Setext headings: never speak the underline; honour skipHeadings.
	add("My Title\n========\nBody.", ["Body."], HEAD_OFF, " (skipHeadings)");
	add("Sub Title\n--------\nBody.", ["Sub Title", "Body."]);
	add("Sub Title\n--------\nBody.", ["Body."], HEAD_OFF, " (skipHeadings)");
	// NRL-120 Verify follow-up. Obsidian's setext underline is EXACT: no leading
	// or trailing whitespace and exactly one content line above it. Both notes
	// below render as one <p> that SHOWS the `===` in Obsidian 1.13.7's own
	// MarkdownRenderer (read 2026-10-01). These used to expect a heading, and
	// under skipHeadings that dropped both displayed lines.
	add("Line one\nline two\n===\nBody.", ["Line one line two === Body."]);
	add("Line one\nline two\n===\nBody.", ["Line one line two === Body."], HEAD_OFF, " (skipHeadings)");
	add("Intro.\n\nMy Title\n===   \nBody.", ["Intro.", "My Title === Body."]);
	// The exact shape is still a heading, and still dropped under skipHeadings.
	add("Intro.\n\nMy Title\n===\nBody.", ["Intro.", "My Title", "Body."]);
	add("Intro.\n\nMy Title\n===\nBody.", ["Intro.", "Body."], HEAD_OFF, " (skipHeadings)");
	add("My Title\n=\nBody.", ["My Title", "Body."]);
	// One leading space: a paragraph in Obsidian, so never dropped.
	add("Intro.\n\nMy Title\n ===\nBody.", ["Intro.", "My Title === Body."], HEAD_OFF, " (skipHeadings)");
	// A "---" with no paragraph line directly above is still a rule.
	add("Para.\n\n---\n\nNext.", ["Para.", "Next."], HEAD_OFF, " (skipHeadings)");
	add("# Head\n---\nNext.", ["Head", "Next."]);
	add("- item\n---\nNext.", ["item", "Next."]);
	add("Para.\n***\nNext.", ["Para.", "Next."], HEAD_OFF, " (skipHeadings)");
	add("Para.\n- - -\nNext.", ["Para.", "Next."], HEAD_OFF, " (skipHeadings)");
	// A lazy continuation of a list item or quote cannot take a setext
	// underline (CommonMark), so "---" there is a rule. Treating it as a
	// heading made skipHeadings silently drop the continuation line.
	add("- item one\ncontinued lazily\n---\nAfter.", ["item one", "continued lazily", "After."], HEAD_OFF, " (skipHeadings)");
	add("> quote one\nlazy line\n---\nAfter.", ["quote one", "lazy line", "After."], HEAD_OFF, " (skipHeadings)");
	add("- item\n\n  para in item\n---\nAfter.", ["item", "para in item", "After."], HEAD_OFF, " (skipHeadings)");
	// Once the list has ended, setext works again.
	add("- a\n\nTitle\n---\nAfter.", ["a", "After."], HEAD_OFF, " (skipHeadings)");

	// Indented code: CommonMark shape, governed by skipCodeBlocks.
	add("    const x = 1;\nAfter.", ["After."]);
	add("Intro.\n\n    const x = 1;", ["Intro."]);
	add("Intro.\n\n    const x = 1;\n\nAfter.", ["Intro.", "After."]);
	add("Intro.\n\n    const x = 1;\n\nAfter.", ["Intro.", "const x = 1;", "After."], codeOn, " (code on)");
	add("Intro.\n\n    a = 1;\n\n      b = 2;\nAfter.", ["Intro.", "a = 1; b = 2;", "After."], codeOn, " (code on)");
	add("Intro.\n\n\tconst y = 2;", ["Intro."]);
	add("Intro.\n\n    ```\n    secret\n\nAfter.", ["Intro.", "After."]);
	add("Intro.\n\n    | a | b |\n\nAfter.", ["Intro.", "After."], { ...OPTS, skipTables: false }, " (tables on)");
	add("---\ntitle: x\n---\n    code line\nAfter.", ["After."]);
	// Not code: no blank line before it, or inside a list item.
	add("Para\n    not code", ["Para not code"]);
	add("- item\n\n    continuation para", ["item", "continuation para"]);
	add("- a\n\nPara.\n\n    code now", ["a", "Para."]);

	// Nested list markers at any depth are stripped.
	add("- a\n    - deep item", ["a", "deep item"]);
	add("- a\n        - deeper item", ["a", "deeper item"]);
	add("- a\n\t- tab item", ["a", "tab item"]);
	add("1. a\n    1. inner", ["a", "inner"]);
	add("- a\n\n    - after blank still list", ["a", "after blank still list"]);

	// NRL-131: containerPrefix peels a quote NESTED inside a list item, and a
	// second list marker with it, so neither the `>` nor the inner `-` is spoken
	// and a `<!--` or `%%` on such a line is line-start for the predicates that
	// ask. Every expectation below is the real renderer's: executed out of
	// Obsidian 1.13.7's own parser and HTML renderer by the harness at
	// ~/.local/share/note-reader-local/obsidian-parser-harness, which gives
	// `- > Before x.` as `<ul><li><blockquote><p>Before x.</p>` with no `>`
	// shown, and `- - > Before x.` as `<ul><li><ul><li><blockquote><p>` with
	// neither marker shown. See docs/adr/0035.
	add("- > Before x.", ["Before x."]);
	add("- - nested item text", ["nested item text"]);
	add("- - > Before x.", ["Before x."]);
	add("> - > Before x.", ["Before x."]);
	add("- > - > Before x.", ["Before x."]);
	add("- - [x] done", ["done"]);
	// A callout marker is tested only after a quote was consumed in the SAME
	// round of the peel, which is why this is a callout and the guard below is
	// not. Measured: `- > [!note] Title` renders a real
	// `<div class="callout" data-callout="note">` with `[!note]` not shown, while
	// `- [!note] x` renders `<li>[!note] x</li>` with the marker shown.
	add("- > [!note] Title\n- > Body here.", ["Title", "Body here."]);
	// The ticket's two reproductions. The first is a browser comment inside the
	// quote, which Obsidian hides; the second an `<span class="internal-embed"
	// src="zdestz.png">`, whose destination is an ATTRIBUTE and so never shown.
	add("- >   \t<!-- ZHIDEZ\nmore", []);
	add("- > Before ![alt\n  > \tplain x\n  > more](zdestz.png) after.", ["Before alt", "plain x", "more after."]);

	// GUARDS. Green on both sides of NRL-131 and not evidence of it; they exist
	// so the peel cannot be widened into the un-nested shapes or into a heading.
	add("> Before x.", ["Before x."], OPTS, " (guard-nrl131-plain-quote-unchanged)");
	add("- Before x.", ["Before x."], OPTS, " (guard-nrl131-plain-list-unchanged)");
	add("> - Before x.", ["Before x."], OPTS, " (guard-nrl131-list-in-quote-unchanged)");
	add("> [!note] Title", ["Title"], OPTS, " (guard-nrl131-callout-unchanged)");
	add("- [x] done item in the list", ["done item in the list"], OPTS, " (guard-nrl131-task-unchanged)");
	// CALLOUT must stay gated on a quote peeled in the same round, or a plain
	// list item whose text opens with `[!type]` would lose it.
	add("- [!note] x", ["!note x"], OPTS, " (guard-nrl131-list-not-a-callout)");
	// `- - -` and every marker-only HR shape never reach containerPrefix at all:
	// the HR branch flushes and continues above the call. This is what makes the
	// computed fixture sweep come out at zero moved expectations.
	add("Para one.\n- - -\nPara two.", ["Para one.", "Para two."], OPTS, " (guard-nrl131-hr-still-silent)");
	// The reason containerPrefix returns `outerList` rather than letting the call
	// site read blockType: `inList` gates the indented-code opener, so without it
	// a four-space continuation of `- > item` would newly be read as code. Only
	// the continuation half is asserted, because the `>` dropping IS the fix and
	// a whole-array assertion would not be green on both sides. Measured against
	// a diagnostic arm that reads blockType instead: 3,072 cells of prose loss.
	{
		const src = "- > item\n\n    four space line";
		fixtures.push(src);
		for (const o of [OPTS, codeOn]) {
			check(
				`guard-nrl131-indented-continuation-not-code ${JSON.stringify(src)} (code ${o.skipCodeBlocks})`,
				texts(src, o).includes("four space line"),
				`got: ${JSON.stringify(texts(src, o))}`,
			);
		}
	}
	// TRIPWIRES. These pin behaviour NRL-131 moves the WRONG way, signed and
	// measured, so it can only change deliberately. Both are pre-existing classes
	// the peel brings the nested form into rather than new ones, each shown by an
	// un-nested control that behaves identically on both sides of this change.
	//
	// 1. A TAB or four-plus spaces before `<!--` on the peeled body. Obsidian's
	//    `indentedCode` tokenizer sits at blockMethods index 2 and `html` at 11,
	//    so a tab-indented line inside the quote is CODE and is DISPLAYED, while
	//    `opensHtmlBlock`'s line-start term accepts the tab and we hide it. The
	//    un-nested twin `> \t<!-- ...` already spoke nothing on base. NRL-93 and
	//    NRL-115 own this class; `opensHtmlBlock` is untouched here.
	//
	//    REPLACED IN PLACE BY NRL-115, as this tripwire asked. NRL-115's
	//    `rendererLeads` marks the peeled `\t<!--` as a fresh block inside a
	//    container led by a tab, so term 1 no longer opens a comment there.
	//    Obsidian's rendered HTML (harness, app.js sha256 8efbf581...9898) is
	//    `<ul><li><blockquote><pre><code>&#x3C;!-- ZHIDEZ</code></pre>
	//    <p>more ZPROSEZ</p></blockquote></li></ul>`: both lines are DISPLAYED,
	//    so the old `[]` was prose loss. The first line is spoken as prose rather
	//    than dropped as code even under skipCodeBlocks, and that is pre-existing
	//    and not NRL-115's: the defused twin `- > \txx ZHIDEZ` speaks
	//    `xx ZHIDEZ` on base under the same options, because no branch of ours
	//    treats indented code inside a container as code.
	add("- > \t<!-- ZHIDEZ\nmore ZPROSEZ", ["<!-- ZHIDEZ", "more ZPROSEZ"], OPTS, " (nrl115-replaces-tripwire: a nested tab-indented <!-- is displayed code)");
	// 2. Was a second TRIPWIRE, filed against NRL-118. NRL-118 relabels it a GUARD
	//    rather than moving it, because the renderer agrees with it: the
	//    unprefixed line is a LAZY continuation that stays inside both the item
	//    and its blockquote, so the block really does close at the mid-line `%%`
	//    and `ZHIDEZ b` is displayed. A container-scoped rule that ended the
	//    quote here would speak `ZHIDEZ a`, which the renderer hides.
	add("- > %%\nZHIDEZ a %% ZHIDEZ b", ["ZHIDEZ b"], OPTS, " (guard-nrl118-lazy-line-closes-in-nested-quote)");

	// NRL-131, found at Ship review: the peel must STOP where the list marker's
	// own trailing whitespace has already put the item's content into an
	// INDENTED CODE BLOCK. Measured out of Obsidian 1.13.7's real renderer, for
	// a bullet, a star and an ordered marker alike: an extra lead of four or
	// more spaces, or any lead reaching a tab, makes the item content
	// `<pre><code>`, so the `>` or the second `-` after it is NOT structural and
	// IS displayed. `LIST_BULLET`'s greedy `\s+` eats that whole lead, so
	// without a guard the loop goes round again and peels a marker the reader
	// can see - which also puts a following `%%` at offset 0 of the body, where
	// `opensObsidianBlock`'s plain line-start rule fires and `dedentedByList` is
	// never consulted. That direction SPEAKS AUTHOR-HIDDEN TEXT, so these are
	// not cosmetic.
	//
	// The guard reuses `INDENTED_CODE`, this file's own definition of the
	// threshold, applied to the consumed run past the marker's one separating
	// space. It is fail-closed: tripping it leaves the line exactly as the
	// pre-NRL-131 tree had it.
	add(
		"- \t> %%\nVISIBLE_IN_OBSIDIAN\n%%\nSECRET_HIDDEN_BY_OBSIDIAN.",
		["> %%", "VISIBLE_IN_OBSIDIAN"],
		OPTS,
		" (nrl131-tab-lead-is-indented-code-not-a-quote)",
	);
	add(
		"-     > %%\nVISIBLE_IN_OBSIDIAN\n%%\nSECRET_HIDDEN_BY_OBSIDIAN.",
		["> %%", "VISIBLE_IN_OBSIDIAN"],
		OPTS,
		" (nrl131-five-space-lead-is-indented-code-not-a-quote)",
	);
	add("-     > ZMARKZ x", ["> ZMARKZ x"], OPTS, " (nrl131-five-space-lead-marker-is-displayed)");
	add("- \t> ZMARKZ x", ["> ZMARKZ x"], OPTS, " (nrl131-tab-lead-marker-is-displayed)");
	add("-     - ZMARKZ x", ["- ZMARKZ x"], OPTS, " (nrl131-five-space-lead-second-bullet-is-displayed)");
	add("- [x] \t> ZMARKZ x", ["> ZMARKZ x"], OPTS, " (nrl131-task-tab-lead-marker-is-displayed)");
	// The other side of the same boundary, and the reason the guard is not just
	// "any extra whitespace": at four or fewer columns past the marker the
	// content is NOT code, the `>` really is a blockquote, and the peel must
	// still happen. Measured: `-    > x` renders `<li><blockquote><p>x`.
	add("-    > ZMARKZ x", ["ZMARKZ x"], OPTS, " (nrl131-four-space-lead-is-still-a-quote)");
	add("-  > ZMARKZ x", ["ZMARKZ x"], OPTS, " (nrl131-two-space-lead-is-still-a-quote)");
	// 3. Was a THIRD signed tripwire, also NRL-118's, and NRL-118 moves it ON
	//    PURPOSE. A `%%` opener repeated per list item: Obsidian scopes the block
	//    to the FIRST item and DISPLAYS the next item, which base hid because its
	//    comment state was note-scoped. The new item ends the scope (ADR 0006
	//    clause 5, NRL-118 amendment), so ZHIDEZ is now spoken, matching the
	//    reading view. The un-nested twin moves with it and is pinned beside it.
	//    The `> %%` twin does NOT move: one blockquote holds all four lines, so
	//    the block really does run to the third line's `%%`, and
	//    guard-nrl118-same-quote-per-line-opener pins that.
	add(
		"- > %%\n- > ZHIDEZ\n- > %%\n- > ZPROSEZ tail.",
		["ZHIDEZ", "ZPROSEZ tail."],
		OPTS,
		" (pin-nrl118-per-item-opener-nested, was TRIPWIRE: NRL-118 per-item %% opener)",
	);
	add(
		"- %%\n- ZHIDEZ\n- %%\n- ZPROSEZ tail.",
		["ZHIDEZ", "ZPROSEZ tail."],
		OPTS,
		" (pin-nrl118-per-item-opener-plain)",
	);

	// Offsets: the first spoken word maps to its raw offset.
	const offsets: Array<[string, string, typeof OPTS]> = [
		["> [!note] Title\n> Body text goes here.", "Title", OPTS],
		["> [!note] Title\n> Body text goes here.", "Body", OPTS],
		["> > [!tip]- Nested title", "Nested", OPTS],
		["- [x] done item in the list", "done", OPTS],
		["1. [ ] numbered task", "numbered", OPTS],
		["My Title\n========\nBody.", "My", OPTS],
		["My Title\n========\nBody.", "Body", OPTS],
		["Line one\nline two\n===\nBody.", "line", OPTS],
		["- a\n    - deep item", "deep", OPTS],
		["- a\n\t- tab item", "tab", OPTS],
		["Intro.\n\n    const x = 1;\n\nAfter.", "const", codeOn],
		["Intro.\n\n    const x = 1;\n\nAfter.", "After", OPTS],
	];
	for (const [src, word, opts] of offsets) {
		const got = offsetOf(src, word, opts);
		check(`${JSON.stringify(word)} in ${JSON.stringify(src)} maps to its raw offset`, got === src.indexOf(word), `got: ${got} want ${src.indexOf(word)}`);
	}

	for (const src of fixtures) {
		for (const opts of [OPTS, codeOn, HEAD_OFF]) {
			check(`sourceIndex lockstep for ${JSON.stringify(src)} (${JSON.stringify({ c: opts.skipCodeBlocks, h: opts.skipHeadings })})`, lockstep(src, opts));
		}
	}
}

console.log("NRL-45 link reference definitions (R-M08)");
{
	/*
	 * A CommonMark link reference definition renders as nothing, so none of it
	 * is spoken - label, colon, destination and any quoted title all go. A
	 * footnote definition is the deliberate contrast a few sections up: its
	 * body IS displayed at the foot of the note, so only the `[^1]:` marker is
	 * dropped. The rule both follow is "speak what the renderer shows" (ADR
	 * 0018).
	 *
	 * No content key governs this: it is unconditional syntax removal, like the
	 * footnote marker and the comment delimiters. The ticket's "both positions
	 * of any toggle chosen to govern it" is therefore satisfied by the
	 * 512-combination sweep below rather than by a tenth content key - the two
	 * `link-ref-def` corpus rows run every fixture here through all 512 masks.
	 */
	const texts = (src: string, opts = OPTS): string[] => extractChunks(src, opts).map((c) => c.text);
	const expect = (src: string, want: string[], opts = OPTS): void => {
		const got = texts(src, opts);
		check(
			`${JSON.stringify(src)} -> ${JSON.stringify(want)}`,
			JSON.stringify(got) === JSON.stringify(want),
			`got: ${JSON.stringify(got)}`,
		);
	};

	// Dropped whole (decision Q1). Ten shapes, each spoken in full before NRL-45.
	expect('[theref]: zdestz.png "ZTITLEZ"', []);
	expect("[theref]: zdestz.png 'ZTITLEZ'", []);
	expect("[theref]: zdestz.png (ZTITLEZ)", []);
	expect('[theref]: <zdestz one.png> "ZTITLEZ"', []);
	expect("[theref]: zdestz.png", []);
	expect('   [theref]: zdestz.png "ZTITLEZ"', []);
	// Recognised after the prefix peel, so a quoted or listed definition goes
	// too - it renders as nothing inside a container as well (decision Q6).
	expect('> [theref]: zdestz.png "ZTITLEZ"', []);
	expect('- [theref]: zdestz.png "ZTITLEZ"', []);
	// A used reference still speaks its label; only the definition disappears.
	expect('Before [label][theref] after.\n\n[theref]: zdestz.png "ZTITLEZ"', ["Before label after."]);
	expect('ZBEFOREZ para.\n\n[theref]: zdestz.png "ZTITLEZ"\n\nZAFTERZ para.', ["ZBEFOREZ para.", "ZAFTERZ para."]);

	/*
	 * pin-link-ref-def: unchanged by NRL-45, and pinned so they can only change
	 * deliberately. Recognition demands the complete one-line CommonMark shape
	 * at the start of a block; anything short of that stays spoken, because
	 * leaked markup is preferred to a swallowed sentence (ADR 0007 clause 6).
	 */
	expect("[see also]: not a definition, just a sentence", ["see also : not a definition, just a sentence"]);
	expect("[a [b] c]: x.png", ["a [b c]: x.png"]);
	expect("[]: x.png", [": x.png"]);
	expect("[theref]:", ["theref :"]);
	expect("[theref]:   ", ["theref :"]);
	// A definition may not interrupt a paragraph, so a def-shaped line directly
	// under a prose line is a paragraph continuation and stays spoken.
	expect('ZPROSEZ line here.\n[theref]: zdestz.png "ZTITLEZ"', ['ZPROSEZ line here. theref : zdestz.png "ZTITLEZ"']);
	expect("ZPROSEZ line here.\n[see also]: not a definition", ["ZPROSEZ line here. see also : not a definition"]);
	// Second line of a container: the per-line scanner keeps no per-container
	// paragraph buffer, so the lazy-continuation case is excluded by
	// !wasContainer and stays spoken (decision Q8).
	expect('> ZPROSEZ sentence.\n> [theref]: zdestz.png "ZTITLEZ"', ["ZPROSEZ sentence.", 'theref : zdestz.png "ZTITLEZ"']);
	// A leaf block cannot sit inside a heading, so this is inline content the
	// renderer shows (decision Q10).
	expect("# [theref]: x.png", ["theref : x.png"]);
	// Footnote definitions keep their own branch and their own rule (decision
	// Q2); the pins in the NRL-9 section above cover the marker itself.
	expect("[^note]: ZFOOTZ body text here.", ["ZFOOTZ body text here."]);

	/*
	 * Decision Q9, the disclosure direction. The branch sits AFTER cleanLine and
	 * after `inComment` is assigned, so a title carrying an unclosed `<!--` that
	 * a later line closes still opens the comment that hides what is between
	 * them. Dropping the line earlier would make text the author hid audible.
	 *
	 * The first of these two REPLACED an expectation of `[]` (NRL-74, D-74-12).
	 * It is the only pre-existing fixture in the suite that the HTML-comment
	 * block rule moves, and it moves SILENT -> SPOKEN. That is renderer-faithful:
	 * the `<!--` sits inside a quoted title, mid-line, with no `-->` anywhere in
	 * the note, so it opens nothing and ZSECRETZ is displayed. It also makes the
	 * shape AGREE with its `%%` sibling - '[a]: x.png "%%"' followed by the same
	 * line already spoke ZSECRETZ before this change, measured identical on both
	 * sides - and removing exactly that asymmetry is what NRL-74 is for.
	 *
	 * The SECOND of the three below was REPLACED IN PLACE a second time, by
	 * NRL-95, and it moves SILENT -> SPOKEN for the same reason: its `-->` sits
	 * two paragraphs away, and term 2 of the block rule is now bounded by the
	 * opener's own paragraph (module 4839's inline path is paragraph-scoped, so
	 * a closer in a later paragraph cannot close anything). The lone `-->` line
	 * is spoken too, and that is also renderer-faithful - `-->` matches no HTML
	 * block opener and is not a tag, so it is ordinary paragraph text. This
	 * fixture was NOT named in NRL-95's plan: the Plan sweep covered the
	 * suite's fixture ARRAYS and this one is an `expect()` call, so it was
	 * found by running the suite rather than predicted.
	 *
	 * Decision Q9's own ordering property does NOT lose its test, which is why
	 * the THIRD fixture was added rather than the second merely edited: it is
	 * the same shape with the `-->` inside the opener's OWN paragraph, so the
	 * title's `<!--` really is an opener under the new rule. It expects
	 * ["ZAFTERZ here."] and is green on both sides. Do not collapse the three.
	 */
	expect('[a]: x.png "<!--"\n\nZSECRETZ sentence here.', ["ZSECRETZ sentence here."]);
	expect('[a]: x.png "<!--"\n\nZSECRETZ sentence here.\n\n-->\n\nZAFTERZ here.', ["ZSECRETZ sentence here.", "-->", "ZAFTERZ here."]);
	expect('[a]: x.png "<!--"\nZSECRETZ sentence here.\n-->\nZAFTERZ here.', ["ZAFTERZ here."]);

	/*
	 * sourceIndex across a dropped line (AGENTS.md rule 8). The drop is
	 * block-level - the branch continues before appendToParagraph - so the line
	 * contributes zero index entries, and offsets must stay monotonic ACROSS the
	 * chunk boundary that now spans it. mergeShort's gap space derives from the
	 * previous chunk's sourceEnd, which sits before the dropped line while the
	 * next chunk's first offset sits after it.
	 */
	{
		const keys = [
			"skipFrontmatter", "skipCodeBlocks", "skipInlineCode", "speakUrls", "speakImageAlt",
			"speakEmbeds", "stripTags", "skipTables", "skipHeadings",
		] as const;
		const src = 'ZBEFOREZ para.\n\n[theref]: zdestz.png "ZTITLEZ"\n\nZAFTERZ para.';
		const defStart = src.indexOf("[theref]:");
		const defEnd = defStart + '[theref]: zdestz.png "ZTITLEZ"'.length;
		let bad = "";
		let runs = 0;
		for (let mask = 0; mask < 512; mask++) {
			const over: Partial<typeof OPTS> = {};
			for (let b = 0; b < keys.length; b++) over[keys[b]!] = (mask & (1 << b)) !== 0;
			runs += 1;
			let prevEnd = -1;
			for (const c of extractChunks(src, { ...OPTS, ...over })) {
				if (c.sourceIndex.length !== c.text.length && bad === "") bad = `mask=${mask} length`;
				if (c.sourceStart < prevEnd && bad === "") bad = `mask=${mask} chunk order`;
				prevEnd = c.sourceEnd;
				for (let i = 0; i < c.text.length; i++) {
					const at = c.sourceIndex[i]!;
					if (at >= defStart && at < defEnd && bad === "") bad = `mask=${mask} offset ${at} inside the dropped line`;
					if (i > 0 && at < c.sourceIndex[i - 1]! && bad === "") bad = `mask=${mask} non-monotonic at ${i}`;
				}
			}
		}
		check("NRL-45 no offset lands inside the dropped definition line, over 512 combinations", bad === "" && runs === 512, `${bad} runs=${runs}`);
	}
}

console.log("angle-bracket autolinks (NRL-39)");
{
	const urlsOn = { ...OPTS, speakUrls: true };
	const spokenWith = (src: string, opts: typeof OPTS): string =>
		extractChunks(src, opts).map((c) => c.text).join(" ");
	const lockstepWith = (src: string, opts: typeof OPTS): boolean =>
		extractChunks(src, opts).every(
			(k) =>
				k.sourceIndex.length === k.text.length &&
				// Numeric UTF-16 indexing, never a spread; see unitsMatch for
				// what a spread does to an astral fixture.
				unitsMatch(k.text, k.sourceIndex, src),
		);
	const offsetOf = (src: string, opts: typeof OPTS, word: string): number | undefined => {
		const k = extractChunks(src, opts).find((c) => c.text.includes(word));
		return k ? k.sourceIndex[k.text.indexOf(word)] : undefined;
	};

	// [source, spoken with speakUrls off, spoken with speakUrls on].
	// `secretbox`, `user` and `secret` are sentinels: an autolink must never
	// speak a mailbox or credentials in either position (docs/adr/0007).
	const autolinks: Array<[string, string, string]> = [
		// The two ticket reproductions.
		["See <https://x.com> ok.", "See ok.", "See x.com ok."],
		["Mail <me@example.com> now.", "Mail now.", "Mail example.com now."],
		["Mail <secretbox@example.com> now.", "Mail now.", "Mail example.com now."],
		["Mail <mailto:secretbox@example.com> now.", "Mail now.", "Mail example.com now."],
		// A generic scheme reduces to its host exactly as https does.
		["Get <ftp://files.example.com/x> now.", "Get now.", "Get files.example.com now."],
		// CommonMark allows a scheme of 2 to 32 characters, so both ends of
		// that range are autolinks.
		["Get <ab://x.com> now.", "Get now.", "Get x.com now."],
		[`Get <${"a".repeat(32)}://x.com> now.`, "Get now.", "Get x.com now."],
		["Log in at <https://user:secret@example.com/x> now.", "Log in at now.", "Log in at example.com now."],
		// Consumption stops at ">", so the sentence period is prose and is
		// still spoken. A bare URL swallows it, because its extent is only
		// known by whitespace; an autolink's extent is delimited.
		["See <https://x.com>.", "See .", "See x.com ."],
		// Alone on a line.
		["<https://x.com>", "", "x.com"],
		["<secretbox@example.com>", "", "example.com"],
		// Case is not significant in a scheme or a domain, and the host keeps
		// the author's own casing: it is raw characters, not a synthetic word.
		["Go <HTTPS://X.COM> ok.", "Go ok.", "Go X.COM ok."],
		["Go <MAILTO:SECRETBOX@EXAMPLE.COM> ok.", "Go ok.", "Go EXAMPLE.COM ok."],
		// More than one on a line, and two with nothing between them.
		["Two <https://a.com> and <https://b.com> here.", "Two and here.", "Two a.com and b.com here."],
		["Two <https://a.com><https://b.com> here.", "Two here.", "Two a.com b.com here."],
		// Nested markup: a link label and a highlight are both re-cleaned.
		["See [a <https://x.com> b](t) now.", "See a b now.", "See a x.com b now."],
		["Some ==hi <https://x.com> there== ok.", "Some hi there ok.", "Some hi x.com there ok."],
		// Port, query and fragment are not the host; a trailing dot is trimmed
		// (ADR 0003 clause 3).
		["Go <http://localhost:8080/p> ok.", "Go ok.", "Go localhost ok."],
		["Go <https://x.com/a?b=1#c> ok.", "Go ok.", "Go x.com ok."],
		["Go <https://x.com.> ok.", "Go ok.", "Go x.com ok."],
		// A non-ASCII host is letters, so it survives the host walk intact.
		["Go <https://пример.рф/x> ok.", "Go ok.", "Go пример.рф ok."],
		// Block contexts still reach the inline scanner.
		["# <https://x.com> title", "title", "x.com title"],
		["- <secretbox@example.com> item", "item", "example.com item"],
		["> quoted <https://x.com> here", "quoted here", "quoted x.com here"],
	];
	for (const [src, off, on] of autolinks) {
		const gotOff = spokenWith(src, OPTS);
		check(`speakUrls false: ${JSON.stringify(src)} -> ${JSON.stringify(off)}`, gotOff === off, `got: ${JSON.stringify(gotOff)}`);
		const gotOn = spokenWith(src, urlsOn);
		check(`speakUrls true: ${JSON.stringify(src)} -> ${JSON.stringify(on)}`, gotOn === on, `got: ${JSON.stringify(gotOn)}`);
		for (const [label, got] of [["false", gotOff], ["true", gotOn]] as const) {
			check(`no angle bracket spoken (speakUrls ${label}): ${JSON.stringify(src)}`, !/[<>]/.test(got), `got: ${JSON.stringify(got)}`);
			check(`no mailbox or credentials spoken (speakUrls ${label}): ${JSON.stringify(src)}`, !/secretbox|user|secret/.test(got), `got: ${JSON.stringify(got)}`);
			check(`no scheme or mailto spoken (speakUrls ${label}): ${JSON.stringify(src)}`, !/:\/\/|mailto/.test(got), `got: ${JSON.stringify(got)}`);
		}
	}

	// Raw offsets: the word after an autolink, and the host itself.
	const urlRepro = "See <https://x.com> ok.";
	const mailRepro = "Mail <me@example.com> now.";
	for (const opts of [OPTS, urlsOn]) {
		const afterUrl = offsetOf(urlRepro, opts, "ok");
		check(`word after a URL autolink maps to its raw offset (speakUrls ${opts.speakUrls})`, afterUrl === urlRepro.indexOf("ok"), `got: ${afterUrl} want ${urlRepro.indexOf("ok")}`);
		const afterMail = offsetOf(mailRepro, opts, "now");
		check(`word after an email autolink maps to its raw offset (speakUrls ${opts.speakUrls})`, afterMail === mailRepro.indexOf("now"), `got: ${afterMail} want ${mailRepro.indexOf("now")}`);
	}
	const hostOffsets: Array<[string, string]> = [
		["See <https://x.com> ok.", "x.com"],
		["Mail <me@example.com> now.", "example.com"],
		["Mail <mailto:secretbox@example.com> now.", "example.com"],
		["Get <ftp://files.example.com/x> now.", "files.example.com"],
		["Log in at <https://user:secret@example.com/x> now.", "example.com"],
	];
	for (const [src, host] of hostOffsets) {
		// Each host occurs once, after any userinfo, so lastIndexOf is its raw offset.
		const got = offsetOf(src, urlsOn, host);
		check(`host of ${JSON.stringify(src)} maps to its raw host`, got === src.lastIndexOf(host), `got: ${got} want ${src.lastIndexOf(host)}`);
	}

	// Guards: nothing that is not a complete autolink changes. These hold
	// before and after the fix; they pin what must not regress.
	const unchanged: Array<[string, string]> = [
		["a < b and c > d", "a < b and c > d"],
		["x<y and z>w", "x<y and z>w"],
		["a <b and c> d", "a <b and c> d"],
		["x <i am here> y", "x <i am here> y"],
		["a <span foo> b", "a <span foo> b"],
		// A dotless domain is not positive evidence of an address, so it stays
		// text rather than risk swallowing a word (docs/adr/0007).
		["Ping <a@b> soon.", "Ping <a@b> soon."],
		// A scheme of one character, or of more than 32, is not an autolink:
		// CommonMark requires 2 to 32. Obsidian renders these literally, so
		// consuming one would silently delete text the reader can see, and
		// `x<y://z>w` would lose the join between `x` and `w` as well.
		["ratio a<b://c> d", "ratio a<b://c> d"],
		["x<y://z>w", "x<y://z>w"],
		[`See <${"a".repeat(33)}://x.com> ok.`, `See <${"a".repeat(33)}://x.com> ok.`],
		// Known HTML tags still win, and NRL-9's handling is untouched.
		["Some <b>bold</b> and <br/> text.", "Some bold and text."],
		["un<b>bold</b>ed", "unbolded"],
		["a </b> b", "a b"],
		// The HTML comment branch runs first and still hides its content.
		["A <!-- hidden secret --> B.", "A B."],
		// An href inside a tag is not an autolink.
		['A <a href="https://x.com/p">link</a> here.', "A link here."],
	];
	for (const [src, want] of unchanged) {
		for (const opts of [OPTS, urlsOn]) {
			const got = spokenWith(src, opts);
			check(`unchanged (speakUrls ${opts.speakUrls}): ${JSON.stringify(src)} -> ${JSON.stringify(want)}`, got === want, `got: ${JSON.stringify(got)}`);
		}
	}

	// Inline code is not markdown, so an autolink inside it is literal when the
	// code is spoken and silent when it is not.
	const inCode = "Use `<https://x.com>` now.";
	const codeSpoken = spokenWith(inCode, { ...urlsOn, skipInlineCode: false });
	check("autolink inside spoken inline code is literal", codeSpoken === "Use <https://x.com> now.", `got: ${JSON.stringify(codeSpoken)}`);
	check("autolink inside skipped inline code is silent", spokenWith(inCode, urlsOn) === "Use now.", `got: ${JSON.stringify(spokenWith(inCode, urlsOn))}`);
	const inFence = "```\n<https://x.com>\n```\nAfter.";
	const fenceSpoken = spokenWith(inFence, { ...urlsOn, skipCodeBlocks: false });
	check("autolink inside a spoken fence is literal", fenceSpoken === "<https://x.com> After.", `got: ${JSON.stringify(fenceSpoken)}`);

	// Scope boundaries. These three are unchanged from before the fix: an
	// incomplete or escaped autolink is not recognised, so the bare-URL branch
	// keeps its NRL-10 behaviour and the stray "<" stays text. Recognising a
	// half-open bracket would risk eating the rest of the line, which is the
	// same trade the HTML element whitelist makes. Pinned so the boundary is a
	// decision rather than drift; moving it is a separate ticket.
	const boundaries: Array<[string, string, string]> = [
		["See <https://x.com and more here.", "See < and more here.", "See < x.com and more here."],
		["See <https://x.com y> now.", "See < y> now.", "See < x.com y> now."],
		["A \\<https://x.com> b.", "A < b.", "A < x.com b."],
	];
	for (const [src, off, on] of boundaries) {
		const gotOff = spokenWith(src, OPTS);
		check(`scope boundary unchanged (speakUrls false): ${JSON.stringify(src)}`, gotOff === off, `got: ${JSON.stringify(gotOff)}`);
		const gotOn = spokenWith(src, urlsOn);
		check(`scope boundary unchanged (speakUrls true): ${JSON.stringify(src)}`, gotOn === on, `got: ${JSON.stringify(gotOn)}`);
	}

	for (const src of [...autolinks.map(([s]) => s), ...unchanged.map(([s]) => s), ...boundaries.map(([s]) => s), inCode, inFence]) {
		for (const opts of [OPTS, urlsOn]) {
			check(`sourceIndex lockstep for ${JSON.stringify(src)} (speakUrls ${opts.speakUrls})`, lockstepWith(src, opts));
		}
	}
}

console.log("Obsidian comment exclusion (NRL-38)");
{
	// Exercise the public extraction seam; diagnostics contain fixture IDs only.
	const cases: Array<[string, string, string, Partial<typeof OPTS>?]> = [
		["inline-repro", "Before %%my secret%% after.", "Before after."],
		["block-repro", "%%\nhidden block\nline two\n%%\nVisible.", "Visible."],
		["inline-adjacent", "Before%%one%%%%two%%after.", "Before after."],
		["inline-multiple", "Before %%one%% middle %%two%% after.", "Before middle after."],
		["empty", "Before %%%% after.", "Before after."],
		["block-tail", "Before.\n%% hidden\nstill hidden\n%% after.", "Before. after."],
		["block-only", "%%\nhidden\n%%", ""],
		["block-unclosed", "Before.\n%% hidden\nnot visible", "Before."],
		["block-unclosed-standalone", "Before.\n%%\nnot visible", "Before."],
		["inline-unmatched", "Before %% visible\nStill visible.", "Before %% visible Still visible."],
		["percent", "Save 50% off today.", "Save 50% off today."],
		["escaped-opener", "Before \\%%literal after.", "Before %%literal after."],
		["escaped-first-of-pair", "Before \\%%literal%% after.", "Before %%literal%% after."],
		["first-closer", "Before %%one %%middle%% two%% after.", "Before middle after."],
		["html-inside-inline", "Before %%<!-- hidden%% after.", "Before after."],
		["obsidian-inside-html", "Before <!-- %% hidden --> after.", "Before after."],
		["html-inside-block", "Before.\n%%\n<!--\n```\n$$\n\n%% after.\nVisible.", "Before. after. Visible."],
		// REPLACED IN PLACE by NRL-95, per the NRL-66/NRL-67 convention: same name,
		// same fixture, new expectation. It used to say "Before after. Visible.",
		// and that was wrong in BOTH halves, one of them a DISCLOSURE rather than
		// prose loss. Three independent evidence lines converge on "Before <!--":
		// (i) the asar read - module 8776 returns early unless `<` is the first
		// non-tab/space character, so this MID-LINE `<!--` never reaches the HTML
		// BLOCK tokenizer at all and routes to module 7648's paragraph-scoped 4839
		// `.T`, which finds no `-->` inside the one-line paragraph `Before <!--`
		// and leaves it displayed; line 2's `%%` is line-start with no lone `%`, so
		// the `%%` block tokenizer opens a comment that never closes and hides
		// lines 2-6; (ii) the paragraph-bounded arm independently produces exactly
		// this string; (iii) NRL-74's own self-tested oracle says `Before` is
		// DISPLAYED while `after.` and `Visible` are HIDDEN, so the old expectation
		// SPOKE two sentinels Obsidian hides.
		//
		// This pin was NRL-74's only stated justification for term 2 scanning to
		// EOF. It is now the evidence AGAINST that scope, not for it. Read off the
		// installed obsidian.asar 1.13.7, NOT observed in Obsidian.
		["obsidian-inside-html-block", "Before <!--\n%%\n```\n$$\n--> after.\nVisible.", "Before <!--"],
		["wrong-html-closer", "%%\n--> hidden\n%% after.", "after."],
		["wrong-obsidian-closer", "<!--\n%% hidden\n--> after.", "after."],
		["tail-comments", "%%\nhidden\n%% after %%more%% tail <!--gone--> end.", "after tail end."],
		["tail-html-continuation", "%%\nhidden\n%% after <!--more\nhidden\n--> tail.", "after tail."],
		["tail-obsidian-continuation", "<!--hidden\n--> %%more\nhidden\n%% after.", "after."],
		["link-label", "Before [label %%hidden%% end](target) after.", "Before label end after."],
		["wiki-alias", "Before [[target|label %%hidden%% end]] after.", "Before label end after."],
		["highlight", "Before ==label %%hidden%% end== after.", "Before label end after."],
		["local-label-state", "[%%literal](target) after.\nVisible.", "%%literal after. Visible."],
		["local-html-state", "[label <!--hidden](target) after.\nVisible.", "label after. Visible."],
		["heading-tracking", "# %%hidden\nhidden\n%% after.", "after.", { skipHeadings: true }],
		["heading-html-tracking", "# Heading <!--hidden\nhidden\n--> after.", "after.", { skipHeadings: true }],
		["table-tracking", "| cell <!--hidden\nhidden\n--> after.", "after."],
		["table-inline", "| %%hidden%% visible |\nafter.", "| visible | after.", { skipTables: false }],
		["inline-code-spoken", "Before `%%literal%%` after.", "Before %%literal%% after.", { skipInlineCode: false }],
		["inline-code-skipped", "Before `%%literal%%` after.", "Before after."],
		["double-tick-code-spoken", "Before ``%%literal%%`` after.", "Before %%literal%% after.", { skipInlineCode: false }],
		["double-tick-code-skipped", "Before ``%%literal%%`` after.", "Before after."],
		["code-inner-tick", "Before ``one ` %%literal%% two`` after.", "Before one ` %%literal%% two after.", { skipInlineCode: false }],
		["code-inner-tick-skipped", "Before ``one ` %%literal%% two`` after.", "Before after."],
		["label-comment-bracket", "Before [label %%hidden] private%% end](target) after.", "Before label end after."],
		["alias-comment-brackets", "Before [[target|label %%hidden]] private%% end]] after.", "Before label end after."],
		// NRL-21 made these two constructs configurable, so each keeps its
		// original expectation in the position that produces it and gains a
		// counterpart proving the comment inside the label is still suppressed
		// when the label itself is spoken.
		["image-comment-bracket", "Before ![label %%hidden] private%% end](target) after.", "Before after.", { speakImageAlt: false }],
		["image-comment-bracket-spoken", "Before ![label %%hidden] private%% end](target) after.", "Before label end after.", { speakImageAlt: true }],
		["embed-comment-brackets", "Before ![[target|label %%hidden]] private%% end]] after.", "Before after.", { speakEmbeds: false }],
		["embed-comment-brackets-spoken", "Before ![[target|label %%hidden]] private%% end]] after.", "Before label end after.", { speakEmbeds: true }],
		["image-html-bracket", "Before ![label <!--hidden] private--> end](target) after.", "Before after.", { speakImageAlt: false }],
		["image-html-bracket-spoken", "Before ![label <!--hidden] private--> end](target) after.", "Before label end after.", { speakImageAlt: true }],
		["embed-html-brackets", "Before ![[target|label <!--hidden]] private--> end]] after.", "Before after.", { speakEmbeds: false }],
		["embed-html-brackets-spoken", "Before ![[target|label <!--hidden]] private--> end]] after.", "Before label end after.", { speakEmbeds: true }],
		["highlight-comment-equals", "Before ==label %%hidden== private%% end== after.", "Before label end after."],
		["label-html-bracket", "Before [label <!--hidden] private--> end](target) after.", "Before label end after."],
		["highlight-html-equals", "Before ==label <!--hidden== private--> end== after.", "Before label end after."],
		["label-code-delimiter", "Before [label `] %%literal%%` end](target) after.", "Before label ] %%literal%% end after.", { skipInlineCode: false }],
		["highlight-code-delimiter", "Before ==label `== %%literal%%` end== after.", "Before label == %%literal%% end after.", { skipInlineCode: false }],
		["fenced-spoken", "```\n%%literal\n```\nafter.", "%%literal after.", { skipCodeBlocks: false }],
		["fenced-skipped", "```\n%%literal\n```\nafter.", "after."],
		["indented-spoken", "    %%literal\nafter.", "%%literal after.", { skipCodeBlocks: false }],
		["indented-skipped", "    %%literal\nafter.", "after."],
		["hidden-blanks", "Before\n%%\n\n%%\n    after.", "Before after."],
		["paragraphs", "Before.\n\n%%\nhidden\n%%\n\nafter.", "Before. after."],
		["crlf", "Before.\r\n%%\r\nhidden\r\n%% after.", "Before. after."],
		["utf16", "𐐀lpha %%hidden%% élan after.", "𐐀lpha élan after."],
		["unconditional", "Before %%hidden%% after.", "Before after.", { stripTags: false, skipCodeBlocks: false, skipInlineCode: false, skipTables: false, skipHeadings: true, speakUrls: true, skipFrontmatter: false, speakImageAlt: true, speakEmbeds: true }],
		// NRL-73. Obsidian's %% block tokenizer aborts on ANY '%' before the
		// newline (`if (37 === a) return`, read out of the installed
		// obsidian.asar - ADR 0006 clause 2), so a line-start %% carrying a lone
		// percent is not a comment opener there at all and the renderer displays
		// it. We used to set openComment anyway and silence the note to EOF,
		// which is prose loss rather than leaked markup. These six are the defect
		// reproduction: each spoke "" or worse before the fix.
		["pin-nrl73-lone-percent-is-literal", "%% 50% off\nVISIBLE PROSE AFTER", "%% 50% off VISIBLE PROSE AFTER"],
		// The disqualifier is a byte scan with no escape awareness, exactly like
		// the tokenizer's charCodeAt comparison, so an escaped \% disqualifies
		// too. The spoken form is `%` and not `\%` because the existing emission
		// path consumes the backslash; pinned so that stays deliberate.
		["pin-nrl73-escaped-percent-disqualifies", "%% 50\\% off\nVISIBLE PROSE AFTER", "%% 50% off VISIBLE PROSE AFTER"],
		["pin-nrl73-indented-opener-with-percent", "  %% 50% off\nVISIBLE", "%% 50% off VISIBLE"],
		// These three move SILENT -> SPOKEN and are renderer-faithful, not leaks.
		// The lone % disqualifies line 1, so Obsidian displays it; the later bare
		// %% (next char is a newline, the tokenizer's `10 === a` break) is a
		// genuine opener with no closer, so Obsidian hides the tail. The old
		// output was wrong in BOTH directions at once - it hid the displayed
		// opener line and spoke the hidden tail. Do not "fix" these back.
		["pin-nrl73-disqualified-then-real-opener", "%% 50% off\nSECRETC\n%%\ntail.", "%% 50% off SECRETC"],
		["pin-nrl73-disqualified-beside-code-run", "Before `a\n%% 50% off\nSECRETB\n%%\nb` after.", "Before a %% 50% off SECRETB"],
		["pin-nrl73-disqualified-beside-code-run-spoken", "Before `a\n%% 50% off\nSECRETB\n%%\nb` after.", "Before a %% 50% off SECRETB", { skipInlineCode: false }],
		// GUARDS. Green on both sides of the fix, so they are not evidence of
		// anything; they exist so the narrowing cannot be widened by accident.
		// The ticket's own control: no % after the opener, so it really is an
		// unclosed block opener and really does hide through EOF.
		["guard-nrl73-no-percent-still-hides", "%% 50 off\nVISIBLE PROSE AFTER", ""],
		// The disclosure direction. Narrowing the predicate widens
		// codeSpanClosesLater, so a GENUINE hidden block beside an unmatched
		// backtick run must still be silent.
		["guard-nrl73-genuine-opener-beside-code-run", "Before `a\n%%\nHIDEME\nb` after.", "Before a", { skipInlineCode: false }],
		// The lone-% rule is %%-only (NRL-73 D-73-4). Obsidian has no equivalent
		// rule for an HTML comment, so the lone % does not disqualify this
		// opener. Still green after NRL-74, but for a reason that did not exist
		// when this was written: the <!-- is at a LINE START, which is now the
		// first term of opensHtmlBlock rather than unconditional (ADR 0025).
		["guard-nrl73-html-opener-unaffected", "<!-- 50% off\nHIDEME", ""],
		// A closed inline pair takes the `close !== -1` path, which this change
		// does not touch, so a % inside one is still hidden.
		["guard-nrl73-inline-pair-with-percent", "Before %%a 5% b%% after.", "Before after."],
		// A soft-wrapped code span whose interior holds ONLY disqualified `%%`
		// lines - no genuine opener anywhere inside it. Found at ship review, and
		// red against base in BOTH positions, which is the point: base spoke
		// "Before a 2% w b after." either way, half-recognising the span. It said
		// the span's two ends (`a`, `b`) and one interior line as prose while
		// dropping the rest, so it agreed with neither the skipped form nor the
		// spoken one. That happened because `opensHiddenComment` called
		// "%% 50% off" an opener, `interruptsParagraph` therefore stopped
		// `codeSpanClosesLater`, and the span was never confirmed. Narrowing the
		// predicate confirms it, and the span is now governed by skipInlineCode
		// exactly as a single-line span is (ADR 0019, R-M08): silent when code is
		// skipped, verbatim when it is spoken. Neither of these is a leak - every
		// line here is displayed by Obsidian, as code.
		["pin-nrl73-span-of-only-disqualified-openers", "Before `a\n%% 50% off\nSPANPROSE\n%% 2% w\nb` after.", "Before after."],
		["pin-nrl73-span-of-only-disqualified-openers-spoken", "Before `a\n%% 50% off\nSPANPROSE\n%% 2% w\nb` after.", "Before a %% 50% off SPANPROSE %% 2% w b after.", { skipInlineCode: false }],
		// NRL-74. An HTML comment block opener is `<!--` with no `-->` on the
		// line AND either only whitespace before it or a `-->` on some LATER
		// line (ADR 0025). Anything else is literal text CommonMark renders, so
		// a mid-line `<!--` with no closer anywhere is spoken, delimiters
		// included, exactly as an unmatched mid-line `%%` already is. We used to
		// open a block on any mid-line `<!--`, silencing the note to EOF, which
		// is prose loss rather than leaked markup. These are the defect
		// reproduction: each was measured red against base 8635ed2.
		["pin-nrl74-midline-html-is-literal", "Plain prose <!--\nSECRETA\nmore", "Plain prose <!-- SECRETA more"],
		// The prefix-peel path, so the rule is applied to the peeled `body` and
		// not to the physical line: a `> ` before the prose must not make the
		// `<!--` look line-start, and must not stop it being literal either.
		["pin-nrl74-midline-html-in-quote", "> Plain prose <!--\n> more", "Plain prose <!-- more"],
		// D-74-9. THE ONLY FIXTURE STOPPING A DESTINATION LEAK. Narrowing
		// cleanLine alone, leaving opensHiddenComment wide, is NOT a safe subset
		// of this fix: the now-literal `<!--` stops the label line truncating, so
		// the unmatched `![` survives to the carry site, but bracketClosesLater
		// still refuses to confirm it, the label is never recognised, and the
		// whole construct including `(zdestz.png)` falls through as prose.
		// Measured in Plan: 1,024 of 2,560 destination-bearing cells leak under
		// that variant against 0 on base and 0 here. So this pair, and the link
		// twin below, are what a later "simplification" of the opensHiddenComment
		// narrowing would trip over - nothing else in the suite would.
		// SCOPE, measured at correction: "0 here" is true of the PLAIN-paragraph
		// shape these three use, and of that shape only. A container prefix on the
		// same construct used to speak the destination; NRL-98 closed that, and
		// pin-nrl74-container-label-still-leaks-destination below now holds the
		// same expectation these do.
		//
		// NRL-95 RE-MEASURED all three rather than assuming, because bounding
		// term 2 of the `<!--` rule WIDENS bracketClosesLater: it narrows
		// opensHtmlBlock -> opensHiddenComment -> interruptsParagraph, so the
		// carry returns false LESS often and confirms MORE often. (ADR 0025 and
		// AGENTS.md both stated that direction backwards until NRL-95 corrected
		// them.) None of the three carries a `-->` at all, so all three are
		// UNMOVED: byte-identical output on both arms in 0 of 512 differing
		// cells each, over every content-key combination. Their cross-paragraph
		// twins, which DO move, are pinned separately as
		// pin-nrl95-label-dest-closer-later-para and its link form. Re-measured
		// again when NRL-98 was rebased onto NRL-95: still unmoved.
		["pin-nrl74-label-destination-not-spoken", "Before ![alt <!--x\nmore](zdestz.png) after.", "Before after.", { speakImageAlt: false }],
		["pin-nrl74-label-destination-not-spoken-alt", "Before ![alt <!--x\nmore](zdestz.png) after.", "Before alt more after.", { speakImageAlt: true }],
		["pin-nrl74-link-label-destination-not-spoken", "Before [lab <!--x\nmore](zdestz.png) after.", "Before lab more after."],
		// REPLACED IN PLACE by NRL-98, keeping the name, per the NRL-66/NRL-67
		// convention. NRL-74 pinned this as a KNOWN LEAK it had unmasked, with a
		// comment saying in as many words that the expectation must change when
		// root 1 closes. Root 1 is closed here, so it changed. The attribution in
		// that comment was wrong and is corrected: root 1 is NRL-98's, not
		// NRL-88's - NRL-88 closed root 4 only, by its own D-88-1.
		//
		// What it pins now is that a container prefix no longer changes the
		// answer: this is byte-for-byte what its plain twin
		// pin-nrl74-label-destination-not-spoken-alt says, so the `<!--x` is
		// still label content and still not spoken, the destination is gone, and
		// the `>` is never spoken either because bracketClosesLater peels the
		// SAME prefix the consumption site strips.
		//
		// The 5,120-of-6,144 figure the old comment carried was a pre-NRL-74
		// baseline over a mixed population and is superseded by ADR 0029's
		// breakdown, which separates the defect rows from the renderer-faithful
		// ones. NRL-95's own re-measurement of it ("UNMOVED, 0 of 512 differing
		// cells") was taken while this pin still carried its leaking value and is
		// superseded too; the shape is now fixed, not unmoved. Measured on the
		// REBASE onto ff34b21, which puts NRL-95 underneath this change: this
		// exact fixture said "Before [alt <!--x more](zdestz.png) after." on that
		// base and says the expectation below on the rebased tree.
		["pin-nrl74-container-label-still-leaks-destination", "> Before ![alt <!--x\n> more](zdestz.png) after.", "Before alt more after."],
		// GUARDS. Green on both sides of the fix, so none is evidence of
		// anything; they exist so the two-term rule cannot be half-adopted.
		// AC 2: the line-start term alone still hides through EOF.
		["guard-nrl74-linestart-html-still-hides", "<!--\nSECRETA\nmore", ""],
		// AC 3: a complete mid-line pair closes on its own line and is dropped.
		["guard-nrl74-complete-midline-pair", "Before <!-- x --> after.", "Before after."],
		// The second term. A mid-line `<!--` whose `-->` is three lines down and
		// in the SAME paragraph IS an opener, so HIDSENT stays silent. Green on
		// both sides of NRL-95 as well, which bounded that lookahead to the
		// opener's paragraph: nothing here ends the paragraph, so the closer is
		// still reached. It was never evidence for the old EOF scope - NRL-74
		// cited obsidian-inside-html-block for that, and NRL-95 showed that pin's
		// own expectation was wrong.
		["guard-nrl74-midline-later-closer-hides", "Before x.\nProse <!--\nHIDSENT\n--> tail.", "Before x. Prose tail."],
		// D-74-10, and what it guards is specific: the line-start-only narrowing
		// of opensHiddenComment. That half-rule answers false for a mid-line
		// `<!--` a later `-->` genuinely closes, so codeSpanClosesLater confirms
		// a carry across a line that really does open a hidden block and HIDDENX
		// becomes code content. Measured: base and this fix both say
		// "Before a Prose b after."; the half-rule says
		// "Before a Prose <!-- HIDDENX --> b after.". Both terms or neither.
		// RE-MEASURED at NRL-95, which widens codeSpanClosesLater: UNMOVED, 0 of
		// 512 differing cells, because this `-->` is inside the opener's own
		// paragraph and the new bound never reaches it. The cross-paragraph twin
		// that does move is pin-nrl95-codespan-closer-later-para.
		["guard-nrl74-variant-C-disclosure", "Before `a\nProse <!--\nHIDDENX\n--> b` after.", "Before a Prose b after.", { skipInlineCode: false }],
		// D-74-11. Duplicates local-html-state above under a name that says WHY:
		// the new literal escape gates on `blockComments` POSITIVELY, where the
		// `%%` escape negates it, so a recursively cleaned label never takes it
		// and its unmatched `<!--` goes on truncating locally. srs.md's
		// non-nesting bullet requires that; the symmetric form breaks it.
		["guard-nrl74-recursive-label-stays-local", "[label <!--hidden](target) after.\nVisible.", "label after. Visible."],
		// NRL-88 ROOT 4 (ADR 0023's residual-roots section, R-M09). A line
		// between a soft-wrapped label's opener and its closer that carries a
		// bracket of its own used to abort the confirmation, because
		// bracketClosesLater stopped at the FIRST `]` on the first line that had
		// one and tested only that. The label was then never recognised and the
		// whole construct, `](zdestz.png)` included, fell through as prose. Both
		// the confirmation and the CONSUMPTION site now scan through `labelClose`
		// with bracket depth, so they cannot disagree about where the label ends.
		// Each of these was measured RED against base df12262.
		["pin-nrl88-root4-stray-bracket", "A ![alt\nsome [bracket] here\nwords](zdestz.png) B", "A B", { speakImageAlt: false }],
		// The same note in the other toggle position, so the fix is shown to
		// restore speakImageAlt's governance of the alt text rather than to
		// silence the construct wholesale.
		["pin-nrl88-root4-stray-bracket-alt", "A ![alt\nsome [bracket] here\nwords](zdestz.png) B", "A alt some bracket here words B", { speakImageAlt: true }],
		// Five more bracket-bearing interior lines. They are not variations for
		// their own sake: each is a different construct a real note carries, and
		// the point of the set is that NONE of them is a label closer, so the
		// depth scan must walk past all five.
		["pin-nrl88-root4-footnote", "A ![alt\n[^1] here\nwords](zdestz.png) B", "A B", { speakImageAlt: false }],
		["pin-nrl88-root4-wikilink", "A ![alt\n[[wk]] here\nwords](zdestz.png) B", "A B", { speakImageAlt: false }],
		["pin-nrl88-root4-checkbox", "A ![alt\n[x] here\nwords](zdestz.png) B", "A B", { speakImageAlt: false }],
		["pin-nrl88-root4-linkrefdef", "A ![alt\n[a]: /u \"t\"\nwords](zdestz.png) B", "A B", { speakImageAlt: false }],
		["pin-nrl88-root4-embed", "A ![alt\n![[embed]] here\nwords](zdestz.png) B", "A B", { speakImageAlt: false }],
		// The link twin. The ticket counted the image form only; the link form is
		// the same defect through the same two sites, and leaving it unpinned
		// would let half the fix be reverted silently.
		["pin-nrl88-root4-link-twin", "A [lab\nsome [bracket] here\nwords](zdestz.png) B", "A lab some bracket here words B"],
		// The stray and the real closer on ONE line. Not one of the ticket's
		// seven, and it is the case that proves the scan advances WITHIN a line
		// and not merely from line to line - a per-line "does this line hold a
		// non-closing bracket" test would pass every fixture above and fail this.
		["pin-nrl88-root4-same-line-stray", "A ![alt\nsome [bracket] and words](zdestz.png) B", "A B", { speakImageAlt: false }],
		// THE CONTROL, and the fail-first evidence for the nine above: the same
		// shape with no stray bracket never leaked, on base or here. Green on
		// both sides by design - it is what makes "the stray bracket is the
		// cause" a measurement rather than an assertion.
		["control-nrl88-no-stray", "A ![alt\nsome plain here\nwords](zdestz.png) B", "A B", { speakImageAlt: false }],
		// GUARDS. Green on BOTH sides of this fix, so none of them is evidence
		// that anything was fixed. They exist so the three measured-wrong
		// alternatives cannot be reintroduced by a later tidy-up.
		//
		// D-88-13. A BARE unmatched `]` is NOT root 4 and must keep leaking.
		// CommonMark ends a label at an unmatched `]`, so this is a shortcut
		// reference with no definition: the image never forms and
		// `](zdestz.png)` is literal text the renderer shows. Silencing it would
		// be the silence-visible-prose trade ADR 0007 clause 6 refuses. Read from
		// the CommonMark spec text, NOT run against a reference implementation
		// and NOT observed in Obsidian. A tripwire, so a later "finish root 4"
		// pass has to change this on purpose.
		["guard-nrl88-bare-close-still-leaks", "A ![alt\nfoo ] bar\nwords](zdestz.png) B", "A [alt foo ] bar words](zdestz.png) B", { speakImageAlt: false }],
		// D-88-11, THE PROSE-LOSS PIN, and the single most important guard here.
		// Measured RED against the naive-skip arm, which said "A here": skipping
		// a shortcut label's own closer lets the scan run on and adopt an
		// unrelated later `](`, swallowing every word between. Depth is what
		// stops that - this `]` is reached at depth 0, so it is ours, it fails
		// the `](`/`][` test, and the scan returns false. Nothing else in the
		// suite would catch a regression to the naive skip.
		["guard-nrl88-shortcut-not-confirmed", "A ![shortcut\nmore] text\nand [link](dest) here", "A [shortcut more] text and link here", { speakImageAlt: false }],
		// D-88-12. labelClose returns at the first line with no `]` left and does
		// NOT count a trailing unmatched `[`, so this shape still leaks. That
		// early return looks like an oversight and is load-bearing: completing
		// the accounting was built and measured, and it newly leaked in 10 of
		// 4,000 fuzz notes and moved guard-nrl63-nested-label, because our carry
		// takes the FIRST unmatched opener where CommonMark takes the LAST.
		["guard-nrl88-unbalanced-open-residual", "A ![alt [inner\nx] words](zdestz.png) B", "A [alt [inner x] words](zdestz.png) B", { speakImageAlt: false }],
		// The SAME residual in its other two positions, added at ship review
		// because the first draft of ADR 0027 recorded the clause-3 residual as
		// one shape when it is one MECHANISM in three positions, and only the
		// opener-line one above was pinned. Both are green on base and on the fix
		// (measured 1,024 of 1,024 cells each, both kinds, both sides), so they
		// are GUARDS and are evidence of nothing except that this diff did not
		// move them. They come off together when the early return is revisited,
		// not one at a time.
		["guard-nrl88-unbalanced-interior-residual", "A ![alt\n[a [b] c\nwords](zdestz.png) B", "A [alt a [b c words](zdestz.png) B", { speakImageAlt: false }],
		["guard-nrl88-straddling-pair-residual", "A ![alt\nsome [strad\ndle] here\nwords](zdestz.png) B", "A [alt some [strad dle] here words](zdestz.png) B", { speakImageAlt: false }],
		// The three fail-closed stops, each with a stray bracket in front of it,
		// so the widened scan is shown still to give up where NRL-63 made it give
		// up. Roots 1, 2 and 3 are out of scope and must not move.
		["guard-nrl88-stray-then-blank", "A ![alt\nsome [b] here\n\nwords](zdestz.png) B", "A [alt some b here words](zdestz.png) B", { speakImageAlt: false }],
		["guard-nrl88-stray-then-heading", "A ![alt\nsome [b] here\n# H\nwords](zdestz.png) B", "A [alt some b here H words](zdestz.png) B", { speakImageAlt: false }],
		["guard-nrl88-stray-then-never-closes", "A ![alt\nsome [b] here\nno closer\n\ntail.", "A [alt some b here no closer tail.", { speakImageAlt: false }],
		// NRL-95. Term 2 of the `<!--` block rule - "some later line carries
		// `-->`" - is now bounded by the end of the OPENER'S PARAGRAPH, where it
		// used to scan to end of document. Term 1 (line-start) keeps its EOF scan:
		// that half IS module 8776's own rule and is correct. Term 2 has no block
		// tokenizer at all - a mid-line `<!--` reaches module 4839's `.T`
		// (`<!---->|<!--(?:-?[^>-])(?:-?[^-])*-->`), applied to ONE paragraph's
		// inline text, so it cannot see a `-->` in a later paragraph. We hid text
		// the renderer displays, which is prose loss rather than leaked markup.
		// Each of the eleven below was measured RED against base 4dcb753.
		//
		// The paragraph bound is blank / FENCE / HEADING / HR / SETEXT / TERM2_LIST,
		// and its three departures from interruptsParagraph's own term list are
		// pinned as guards further down.
		["pin-nrl95-closer-in-later-paragraph", "Before x.\nProse <!--\nHIDDENP\n\nNew paragraph -->\nTail.", "Before x. Prose <!-- HIDDENP New paragraph --> Tail."],
		// A blank line ends the paragraph even inside a blockquote, so the `-->`
		// three lines down is in a DIFFERENT paragraph and cannot close the opener.
		// Contrast guard-nrl95-container-closer-in-quote below, where there is no
		// blank line and the container re-offers all three lines as one paragraph.
		["pin-nrl95-container-closer-past-blank", "> Prose <!--\n> HIDDENQ2\n\n> more -->", "Prose <!-- HIDDENQ2 more -->"],
		// The four non-container stops, one fixture each, so no single term can be
		// dropped from endsTerm2Scan without a red check.
		["pin-nrl95-heading-between", "Prose <!--\n# H\nHIDDENH\n--> t.", "Prose <!-- H HIDDENH --> t."],
		// NRL-95's C5. KEPT EXACTLY AS IT WAS, and it is the other half of NRL-111:
		// the `===` here IS the block's second line, so module 8671's setextHeading
		// BLOCK tokenizer takes it, the paragraph really does end, and the renderer
		// really does display HIDDENE. Measured against real rendered HTML from the
		// installed obsidian.asar 1.13.7 in NRL-111's Implement session:
		// `<h1 data-heading="Prose <!--">Prose &#x3C;!--</h1><p>HIDDENE<br>--> t.</p>`.
		// The NRL-111 pins immediately below must hold AT THE SAME TIME as this one;
		// deleting `SETEXT.test(line)` makes them pass and this one fail.
		["pin-nrl95-setext-between", "Prose <!--\n===\nHIDDENE\n--> t.", "Prose <!-- HIDDENE --> t."],
		["pin-nrl95-hr-between", "Prose <!--\n***\nHIDDENR\n--> t.", "Prose <!-- HIDDENR --> t."],
		// NRL-111. The `=` setext underline is a stop ONLY on the block's second
		// line. `setextHeading` is in `u.interruptParagraph` but carries
		// `{commonmark:!1}`, and module 6047 gates an entry on
		// `o.commonmark === n.options.commonmark` with `options.commonmark === true`
		// (`VT.globalOptions = {breaks:!0, commonmark:!0}`), so it is DISABLED as an
		// interrupter; the only route left is the setextHeading BLOCK tokenizer,
		// module 8671, which takes exactly ONE content line. On any later line the
		// `===` is paragraph prose, module 4839's inline `.T` regex crosses it, and
		// Obsidian HIDES the text after it. NRL-95 stopped there and spoke it: a
		// live 2,048-cell disclosure in `main`.
		//
		// All four shapes measured against real rendered HTML: each renders as ONE
		// `<p>` holding the whole raw comment, so HIDDENE is inside it. Each was
		// measured RED against base 874410d.
		["pin-nrl111-eq-underline-third-line", "Prose <!--\nmore\n===\nHIDDENE\n--> t.", "Prose t."],
		["pin-nrl111-eq-single-third-line", "Prose <!--\nmore\n=\nHIDDENE\n--> t.", "Prose t."],
		["pin-nrl111-eq-underline-fourth-line", "Prose <!--\na\nb\n===\nHIDDENE\n--> t.", "Prose t."],
		["pin-nrl111-eq-underline-midline-opener", "Before x. Prose <!--\nmore\n===\nHIDDENE\n--> t.", "Before x. Prose t."],
		// The SHAPE half, which `SETEXT`'s `^ {0,3}...\s*$` also got wrong and which
		// is why `TERM2_SETEXT_EQ` is a separate pattern rather than a reuse. The
		// renderer's setextHeading tokenizer accepts NO leading and NO trailing
		// whitespace: measured, `Title` / `===` is `<h1>` while `Title` / ` ===` and
		// `Title` / `===  ` are each one `<p>` with the `===` as prose. So these two
		// are second-line underlines for CommonMark and NOT for Obsidian, it hides
		// HIDDENE in both, and base spoke it in both. RED against 874410d.
		["pin-nrl111-eq-indented-not-an-underline", "Prose <!--\n ===\nHIDDENE\n--> t.", "Prose t."],
		["pin-nrl111-eq-trailing-space-not-an-underline", "Prose <!--\n===  \nHIDDENE\n--> t.", "Prose t."],
		// The reason `endsTerm2Block` is split out from `endsTerm2Scan`. A `--` line
		// stops the scan - module 4839's regex body cannot consume two consecutive
		// dashes, so the construct fails to match and the `<!--` is literal - but it
		// is NOT a block end: measured, `--` / `Prose` renders as one `<p>`. So the
		// `===` here has TWO content lines above it, is not an underline, and the
		// renderer hides HIDDENE. An arm that reset the content-line count on the
		// `--` calls it a second line, stops, and speaks HIDDENE. RED against
		// 874410d, and RED against that arm too.
		["pin-nrl111-dash-pair-is-not-a-block-end", "--\nProse <!--\n===\nHIDDENE\n--> t.", "-- Prose t."],
		// REPLACED IN PLACE by NRL-119, per the NRL-66/NRL-67 convention: same name,
		// new expectation. This was a TRIPWIRE expecting `"Prose t."`, recording the
		// one place NRL-111 made something worse. The bare `1)` line is a real
		// paragraph interrupter - module 745 accepts a marker with nothing after it,
		// and the renderer puts HIDDENE in an `<ol><li>` and DISPLAYS it - while
		// `TERM2_LIST`'s old `[ \t]` tail missed it. Base's wrong `===  ` stop had
		// masked that until NRL-111 removed it. NRL-119 widened the tail to
		// `(?:[ \t]|\r?$)`, so the scan now stops at the bare `1)` and HIDDENE is
		// spoken. Re-measured against real rendered HTML out of the installed
		// obsidian.asar 1.13.7 (app.js sha256 8efbf581...9898) in NRL-119's session:
		// `<p>Prose &#x3C;!--<br>more<br>===  </p><ol><li>HIDDENE<br>--> t.</li></ol>`.
		// RED against base faf55a3, which said `"Prose t."`.
		//
		// The `1)` GLYPH is still spoken, and the renderer does not show it (it is the
		// list marker). That is a separate residual and deliberately not closed here:
		// `LIST_BULLET`'s `\s+` is the block-level strip that would drop it, and it
		// feeds `containerPrefix` and `blockType` and accepts any `\d+`, so widening it
		// needs its own position-gated measurement. No word is lost or leaked by it.
		// NRL-154, the bare-marker glyph follow-up filed from NRL-119, owns it; when
		// that lands, this expectation must change on purpose.
		["pin-nrl111-bare-ordered-marker-unmasked", "Prose <!--\nmore\n===  \n1)\nHIDDENE\n--> t.", "Prose <!-- more === 1) HIDDENE --> t."],
		// NRL-119: a list marker ALONE on its line ends the paragraph, so the term-2
		// scan must stop there. Module 745's silent path accepts a marker followed by
		// a newline or end of input (`if (next!==" " && next!=="\t" && (pedantic ||
		// next!=="\n" && next!=="")) return;`), and `list` is unconditionally in
		// `u.interruptParagraph`. Measured against real rendered HTML in this session:
		// each of these renders `<p>Prose &#x3C;!--</p>` followed by a `<ul>` or `<ol>`
		// whose item holds `HIDDENE<br>--> t.`, so HIDDENE is DISPLAYED. All six were
		// RED against base faf55a3 (each said `"Prose t."`, prose loss). The glyph is
		// spoken in the first five for the `LIST_BULLET` reason given above; the CRLF
		// twin drops it because `\s+` matches the `\r`.
		["pin-nrl119-bare-star-interrupts", "Prose <!--\n*\nHIDDENE\n--> t.", "Prose <!-- * HIDDENE --> t."],
		["pin-nrl119-bare-plus-interrupts", "Prose <!--\n+\nHIDDENE\n--> t.", "Prose <!-- + HIDDENE --> t."],
		["pin-nrl119-bare-one-dot-interrupts", "Prose <!--\n1.\nHIDDENE\n--> t.", "Prose <!-- 1. HIDDENE --> t."],
		["pin-nrl119-bare-one-paren-interrupts", "Prose <!--\n1)\nHIDDENE\n--> t.", "Prose <!-- 1) HIDDENE --> t."],
		["pin-nrl119-bare-star-three-space-indent-interrupts", "Prose <!--\n   *\nHIDDENE\n--> t.", "Prose <!-- * HIDDENE --> t."],
		// `extractChunks` splits on `\n` alone, so a CRLF note hands the marker line a
		// trailing `\r`, which the renderer treats as a line ending. Hence `\r?$`.
		["pin-nrl119-bare-star-crlf-interrupts", "Prose <!--\n*\r\nHIDDENE\n--> t.", "Prose <!-- HIDDENE --> t."],
		// GUARD, green on base and on the fix, so not counted as evidence: a marker
		// followed by trailing whitespace already matched the old `[ \t]` tail. The
		// plan expected it red; measured green on base faf55a3, so relabelled.
		["guard-nrl119-bare-star-trailing-space-interrupts", "Prose <!--\n* \nHIDDENE\n--> t.", "Prose <!-- HIDDENE --> t."],
		// GUARDS, green on base and on the fix: the widening must keep the digit rule
		// and the indent cap. Module 745's silent path returns unless the digit string
		// is exactly `"1"` (`7.`, `7)`, `01.`), and past three columns of indent (four
		// spaces, or a tab) the marker line is a lazy paragraph continuation. Measured:
		// all five render as ONE `<p>` with HIDDENE inside the raw comment, so the
		// renderer HIDES it and speaking it would be a disclosure. Each is RED against
		// a deliberately wrong arm: `\d+[.)]` with `$` for the first three, `^[ \t]*`
		// with `$` for the last two.
		["guard-nrl119-bare-seven-dot-hidden", "Prose <!--\n7.\nHIDDENE\n--> t.", "Prose t."],
		["guard-nrl119-bare-seven-paren-hidden", "Prose <!--\n7)\nHIDDENE\n--> t.", "Prose t."],
		["guard-nrl119-bare-zero-padded-one-hidden", "Prose <!--\n01.\nHIDDENE\n--> t.", "Prose t."],
		["guard-nrl119-bare-four-space-star-hidden", "Prose <!--\n    *\nHIDDENE\n--> t.", "Prose t."],
		["guard-nrl119-bare-tab-star-hidden", "Prose <!--\n\t*\nHIDDENE\n--> t.", "Prose t."],
		// NRL-119 FIX ROUND 1. Independent Verify found that widening `TERM2_LIST`
		// alone newly LOST displayed prose: a soft-wrapped code span or link/image
		// label whose opener line carries a mid-line `<!--` was carried ACROSS a bare
		// marker line. Narrowing the term-2 scan made `opensHtmlBlock` answer false on
		// the opener, so `codeSpanClosesLater` / `bracketClosesLater` went on to ask
		// `interruptsParagraph` about the `*` line, and that predicate did not see a
		// bare marker (`LIST_BULLET` needs `\s+`). Base's wider `<!--` block had
		// masked it. The renderer ends the paragraph at the bare marker, so no span
		// and no label forms: `A `xx <!--` / `*` / `HIDDENE` / `--> yy` B.` renders
		// `<p>A `xx &#x3C;!--</p><ul><li>HIDDENE<br>--> yy` B.</li></ul>` (Obsidian
		// 1.13.7 WT/GT out of obsidian.asar, app.js sha256 8efbf581...9898), so every
		// word is DISPLAYED. On the pre-round PR head these spoke `"A B."` (code) and
		// `"a xx * HIDDENE --> zz b"` (label, dropping the displayed `](dest.png)`);
		// on base `"A xx yy B."` and `"a [xx zz](dest.png) b"`. All RED on the
		// pre-round head. The fix gives `interruptsParagraph` the same bare-marker
		// rule as `TERM2_LIST` (`BARE_LIST_MARKER`). The glyph is still spoken, and
		// the backticks and the image `!` are dropped as they always were: NRL-154
		// owns the glyph.
		["pin-nrl119-code-span-across-bare-star", "A `xx <!--\n*\nHIDDENE\n--> yy` B.", "A xx <!-- * HIDDENE --> yy B."],
		["pin-nrl119-code-span-across-bare-plus", "A `xx <!--\n+\nHIDDENE\n--> yy` B.", "A xx <!-- + HIDDENE --> yy B."],
		["pin-nrl119-code-span-across-bare-one-dot", "A `xx <!--\n1.\nHIDDENE\n--> yy` B.", "A xx <!-- 1. HIDDENE --> yy B."],
		["pin-nrl119-code-span-across-bare-one-paren", "A `xx <!--\n1)\nHIDDENE\n--> yy` B.", "A xx <!-- 1) HIDDENE --> yy B."],
		["pin-nrl119-code-span-across-bare-star-three-space", "A `xx <!--\n   *\nHIDDENE\n--> yy` B.", "A xx <!-- * HIDDENE --> yy B."],
		["pin-nrl119-link-label-across-bare-star", "a [xx <!--\n*\nHIDDENE --> zz](dest.png) b", "a [xx <!-- * HIDDENE --> zz](dest.png) b"],
		["pin-nrl119-link-label-across-bare-plus", "a [xx <!--\n+\nHIDDENE --> zz](dest.png) b", "a [xx <!-- + HIDDENE --> zz](dest.png) b"],
		["pin-nrl119-link-label-across-bare-one-dot", "a [xx <!--\n1.\nHIDDENE --> zz](dest.png) b", "a [xx <!-- 1. HIDDENE --> zz](dest.png) b"],
		["pin-nrl119-link-label-across-bare-one-paren", "a [xx <!--\n1)\nHIDDENE --> zz](dest.png) b", "a [xx <!-- 1) HIDDENE --> zz](dest.png) b"],
		["pin-nrl119-link-label-across-bare-star-three-space", "a [xx <!--\n   *\nHIDDENE --> zz](dest.png) b", "a [xx <!-- * HIDDENE --> zz](dest.png) b"],
		["pin-nrl119-image-label-across-bare-star", "a ![xx <!--\n*\nHIDDENE --> zz](dest.png) b", "a [xx <!-- * HIDDENE --> zz](dest.png) b"],
		["pin-nrl119-image-label-across-bare-plus", "a ![xx <!--\n+\nHIDDENE --> zz](dest.png) b", "a [xx <!-- + HIDDENE --> zz](dest.png) b"],
		["pin-nrl119-image-label-across-bare-one-dot", "a ![xx <!--\n1.\nHIDDENE --> zz](dest.png) b", "a [xx <!-- 1. HIDDENE --> zz](dest.png) b"],
		["pin-nrl119-image-label-across-bare-one-paren", "a ![xx <!--\n1)\nHIDDENE --> zz](dest.png) b", "a [xx <!-- 1) HIDDENE --> zz](dest.png) b"],
		["pin-nrl119-image-label-across-bare-star-three-space", "a ![xx <!--\n   *\nHIDDENE --> zz](dest.png) b", "a [xx <!-- * HIDDENE --> zz](dest.png) b"],
		// The same root WITHOUT a `<!--`: NRL-154's symptom 2, pre-existing on base
		// and on the pre-round head alike (each spoke `"A B."`, `"a x * HIDDENE b"`
		// and `"a x 1. HIDDENE b"`, silencing the displayed `xx`/`yy` and the
		// displayed literal `](dest.png)`). It is folded in here because it is the
		// identical predicate gap and closing one without the other is not possible.
		["pin-nrl119-code-span-across-bare-star-no-comment", "A `xx\n*\nHIDDENE\nyy` B.", "A xx * HIDDENE yy B."],
		["pin-nrl119-image-label-across-bare-star-no-comment", "a ![x\n*\nHIDDENE](dest.png) b", "a [x * HIDDENE](dest.png) b"],
		["pin-nrl119-link-label-across-bare-one-dot-no-comment", "a [x\n1.\nHIDDENE](dest.png) b", "a [x 1. HIDDENE](dest.png) b"],
		// GUARDS, green on base, on the pre-round head and on the fix, so not counted
		// as evidence. A trailing `\r` already matched `LIST_BULLET`'s `\s+`, and a
		// lone `-` was already `SETEXT`, so both always stopped the carry.
		["guard-nrl119-code-span-across-bare-star-crlf", "A `xx <!--\n*\r\nHIDDENE\n--> yy` B.", "A xx <!-- HIDDENE --> yy B."],
		["guard-nrl119-link-label-across-lone-dash", "a [xx <!--\n-\nHIDDENE --> zz](dest.png) b", "a [xx <!-- HIDDENE --> zz](dest.png) b"],
		// GUARDS, same status, and these are the disclosure side. Past three columns
		// of indent, or with a digit string other than `1`, the marker line is a
		// lazy paragraph continuation and the renderer DOES form the image or link:
		// `a ![x` / `7.` / `HIDDENE](dest.png) b` renders one `<p>` holding an
		// `internal-embed` with `src="dest.png"`, so the destination is an attribute
		// and must not be spoken. The carry must still cross these lines. Each is
		// RED against a deliberately wrong `BARE_LIST_MARKER` arm, measured: the
		// `\d+[.)]` arm stops at the three digit rows and speaks `](dest.png)`, the
		// `^[ \t]*` arm does the same at the two indent rows.
		["guard-nrl119-image-label-across-bare-seven-dot", "a ![x\n7.\nHIDDENE](dest.png) b", "a x 7. HIDDENE b"],
		["guard-nrl119-image-label-across-bare-zero-padded-one", "a ![x\n01.\nHIDDENE](dest.png) b", "a x 01. HIDDENE b"],
		["guard-nrl119-link-label-across-bare-seven-paren", "a [x\n7)\nHIDDENE](dest.png) b", "a x 7) HIDDENE b"],
		["guard-nrl119-image-label-across-bare-four-space-star", "a ![x\n    *\nHIDDENE](dest.png) b", "a x * HIDDENE b"],
		["guard-nrl119-image-label-across-bare-tab-star", "a ![x\n\t*\nHIDDENE](dest.png) b", "a x * HIDDENE b"],
		// NRL-119 FIX ROUND 2. Round 1's `BARE_LIST_MARKER` newly SPOKE an image or
		// link DESTINATION (and image alt text) that base kept silent, when the bare
		// marker sat on a quote continuation whose `>` is followed by a TAB: the label
		// lookahead tested it on `peelQuotes`' output, whose `>\s?` eats the tab, while
		// Obsidian's blockquote tokenizer strips ONE optional space after `>` and keeps
		// `\t*` as tab-led lazy prose, so the image forms across it. Measured with
		// Obsidian 1.13.7's WT/GT out of obsidian.asar (app.js sha256 8efbf581...9898):
		// `> A ![xx` / `>\t*` / `> yy](zdestz.png) B.` renders `<blockquote><p>A <span
		// class="internal-embed" src="zdestz.png" alt="xx\t*yy"></span> B.</p>`. On
		// 9522c11 these spoke `"A [xx * yy](zdestz.png) B."`. The fix tests that ONE
		// arm on the renderer's reading of the line (`quoteContent`) and leaves every
		// other arm on the legacy peel, so a line with a tab, NBSP or CR after a `>`
		// behaves exactly as on base. All eight RED on 9522c11 only.
		["pin-nrl119-r2-quoted-image-across-tab-star", "> A ![xx\n>\t*\n> yy](zdestz.png) B.", "A xx * yy B."],
		["pin-nrl119-r2-quoted-link-across-tab-star", "> A [xx\n>\t*\n> yy](zdestz.png) B.", "A xx * yy B."],
		["pin-nrl119-r2-quoted-image-across-tab-plus", "> A ![xx\n>\t+\n> yy](zdestz.png) B.", "A xx + yy B."],
		["pin-nrl119-r2-quoted-image-across-tab-one-dot", "> A ![xx\n>\t1.\n> yy](zdestz.png) B.", "A xx 1. yy B."],
		["pin-nrl119-r2-quoted-link-across-tab-one-paren", "> A [xx\n>\t1)\n> yy](zdestz.png) B.", "A xx 1) yy B."],
		["pin-nrl119-r2-nested-quote-image-across-tab-star", "> > A ![xx\n> >\t*\n> > yy](zdestz.png) B.", "A xx * yy B."],
		["pin-nrl119-r2-indented-quote-image-across-tab-star", " > A ![xx\n >\t*\n > yy](zdestz.png) B.", "A xx * yy B."],
		["pin-nrl119-r2-quoted-link-across-tab-one-dot-lazy-closer", "> A [xx\n>\t1.\nyy](zdestz.png) B.", "A xx 1. yy B."],
		// Round 1's win that must survive: `>    *` (four spaces) leaves a three-space
		// bare marker under the renderer's one-space peel, which really does interrupt
		// (`<blockquote><p>A ![xx</p><ul><li>yy](zdestz.png) B.</li></ul>`). RED on base
		// and on an arm whose content peel strips no space after `>`.
		["pin-nrl119-r2-quoted-image-across-four-space-star", "> A ![xx\n>    *\n> yy](zdestz.png) B.", "A [xx * yy](zdestz.png) B."],
		// GUARDS, every one with the fix's output EQUAL TO BASE, most of them RED on
		// at least one rejected arm of this round: 9522c11 (r1), the
		// first draft e3684fb (d1, the renderer's peel applied to every arm plus a
		// partial-laziness rule, a lazy-line list stop, a per-line quoted-list
		// de-indent and a code-opener refusal), or the second draft 40302f6 (d2, d1
		// minus the de-indent, with an "old reading" for some openers). Two /critique
		// passes and the round's census found the shapes; each draft newly spoke a
		// destination or newly silenced displayed text in them.
		// `> \t*`: the space is the optional one under every peel. RED on an arm that
		// strips all whitespace after `>`.
		["guard-nrl119-r2-quoted-image-across-space-tab-star", "> A ![xx\n> \t*\n> yy](zdestz.png) B.", "A xx * yy B."],
		// Tab-after-`>` OPENERS (/critique 2, F1 and F3): RED on r1 and d2, or d1 and d2.
		["guard-nrl119-r2-tab-after-quote-opener-across-tab-star", "> ZPZ\n>\tZAZ ![ZXZ\n>\t*\n> ZYZ](zdestz.png) ZBZ.", "ZPZ ZAZ ZXZ * ZYZ ZBZ."],
		["guard-nrl119-r2-tab-nested-opener-across-tab-one-dot", "> ZPZ\n>\t> ZAZ ![ZXZ\n>\t1.\n> > ZYZ](zdestz.png) ZBZ.", "ZPZ ZAZ ZXZ 1. ZYZ ZBZ."],
		["guard-nrl119-r2-space-tab-opener-across-tab-dash", ">\n> \tZAZ ![ZXZ\n>\t-\n> ZYZ](zdestz.png) ZBZ.", "ZAZ [ZXZ - ZYZ](zdestz.png) ZBZ."],
		["guard-nrl119-r2-tab-nested-opener-tab-tab-closer", "> ZPZ\n>\t> ZAZ [ZXZ\n>\t\tZYZ](zdestz.png) ZBZ.", "ZPZ ZAZ ZXZ ZYZ ZBZ."],
		// NRL-166 (NRL-114 fix round 1's `crAbove`): REPLACED IN PLACE, name kept.
		// From a note's first lone CR on, a line keeps the pre-NRL-114 answer, and
		// here that is the renderer's: `<blockquote><p>A <span class="internal-embed"
		// src="zdestz.png" alt="xx\n\t\nyy"></span> B.` displays the alt and never
		// the destination. The old expectation was "equal to base" against a base
		// that already carried NRL-114's head f0c52a2, and it spoke `zdestz.png`.
		// Green on 9132c3b; RED on e2afbfe. Containment only: NRL-164 stays open.
		["guard-nrl119-r2-opener-with-lone-cr", ">\t\rA ![xx\n>\t\ryy](zdestz.png) B.", "A xx yy B."],
		["guard-nrl119-r2-quoted-code-opener-across-tab-dash", ">\tA ![ZXZ\n>\t-\n>\tZYZ](zdestz.png) ZBZ.", "A [ZXZ - ZYZ](zdestz.png) ZBZ."],
		["guard-nrl119-r2-quoted-tab-continuation-still-carried", "> P\n>\tA ![ZXZ\n> ZYZ](zdestz.png) ZBZ.", "P A ZXZ ZYZ ZBZ."],
		// A list inside a quote, and a quote inside a list (/critique 1 and 2): RED on
		// d1, or d1 and d2.
		["guard-nrl119-r2-quoted-task-item-equals-run-carried", "> - [ ] ZAZ [ZXZ\n>       ===\n>   ZYZ](zdestz.png) ZBZ.", "ZAZ ZXZ === ZYZ ZBZ."],
		["guard-nrl119-r2-quoted-ordered-item-deep-star-carried", "> 1. ZAZ ![ZXZ\n>       *\n>   ZYZ](zdestz.png) ZBZ.", "ZAZ ZXZ * ZYZ ZBZ."],
		["guard-nrl119-r2-quoted-item-min-indent-equals-run-carried", ">  - ZAZ ![ZXZ\n>     ===\n>     ZYZ](zdestz.png) ZBZ.", "ZAZ ZXZ === ZYZ ZBZ."],
		["guard-nrl119-r2-quote-list-quote-chain-carried", "> - > ZAZ [ZXZ\n>   > ZQZ\n>     ZYZ](zdestz.png) ZBZ.", "ZAZ ZXZ ZQZ ZYZ ZBZ."],
		["guard-nrl119-r2-list-quote-list-opener-across-tab-dash", "- > - ZAZ ![ZXZ\n  >\t-\n  > ZYZ](zdestz.png) ZBZ.", "ZAZ ZXZ - ZYZ ZBZ."],
		["guard-nrl119-r2-quoted-list-tab-dash", "> - A ![ZXZ\n>\t   -\n>\t  ZYZ](zdestz.png) ZBZ.", "A ZXZ - ZYZ ZBZ."],
		["guard-nrl119-r2-nbsp-after-quote-in-quoted-ordered-item", "> 10. ZAZ [ZXZ\n   >\u00a0*\n  >      ZYZ](zdestz.png) ZBZ.", "ZAZ ZXZ * ZYZ ZBZ."],
		// Lazy and partially lazy lines, NBSP and lone CR (/critique 1, the census): RED
		// on r1, d1 or d2 as recorded in ADR 0025; the NBSP-led lazy line was a
		// round-1 leak against base that Verify's corpora never generated.
		// NRL-166 fix round 1: the tab-led `>\t=` ENDS the inner quote as indented
		// code of the outer one (the walker now records it as fresh code), so the
		// label never closes and the renderer displays `](zdestz.png)` as text:
		// `A ![ZXZ = ZYZ](zdestz.png) ZBZ.`. Expectation moved to that text.
		["guard-nrl119-r2-partially-lazy-tab-equals", "> > A ![ZXZ\n>\t=\n> > ZYZ](zdestz.png) ZBZ.", "A [ZXZ = ZYZ](zdestz.png) ZBZ."],
		["guard-nrl119-r2-lazy-space-tab-star-percent-closer", "> A ![ZXZ %%\n \t*\n>\t%% ZYZ](zdestz.png) ZBZ.", "A ZXZ %% * %% ZYZ ZBZ."],
		["guard-nrl119-r2-lazy-space-tab-seven-dot-is-text", "> A [ZXZ\n \t7.\n> ZYZ](zdestz.png) ZBZ.", "A ZXZ 7. ZYZ ZBZ."],
		["guard-nrl119-r2-nbsp-led-lazy-line-is-text", "> > ZPZ A ![xx\n\u00a0>*\n> > yy](zdestz.png) B.", "ZPZ A xx * yy B."],
		["guard-nrl119-r2-lone-cr-after-quote-is-a-line-ending", "> ZPZ A ![xx\n>\r-\n> yy](zdestz.png) B.", "ZPZ A [xx - yy](zdestz.png) B."],
		["guard-nrl119-r2-lazy-mixed-lead-inline-tag", "> ZAZ [ZXZ\n \t<em>ZQZ</em>\n> ZYZ](zdestz.png) ZBZ.", "ZAZ ZXZ ZQZ ZYZ ZBZ."],
		// RESIDUALS, identical on base and the fix, where the renderer disagrees.
		// Each was CLOSED by d1 or d2 and is given up here, because closing it needs
		// the renderer's peel on the pre-existing arms and that, measured three times
		// this round, unmasks other base defects (NRL-153, NRL-114). Change these on
		// purpose when that work lands.
		// REBASED onto NRL-114 (#212): that work landed, and on the rebased tree every
		// expectation below that moved, and five guards above (lone-cr opener, the two
		// quoted-list tab-dash shapes, partially-lazy tab-equals, lazy space-tab star),
		// now equals NRL-114's main output exactly (fix === base on all 13, measured by
		// bundling both). The equal-to-base property each row pins is unchanged.
		// Destination spoken although the renderer forms the image or link:
		["pin-nrl119-r2-quoted-image-across-tab-dash-residual", "> A ![xx\n>\t-\n> yy](zdestz.png) B.", "A xx - yy B."],
		["pin-nrl119-r2-quoted-link-across-tab-dash-residual", "> A [xx\n>\t-\n> yy](zdestz.png) B.", "A xx - yy B."],
		["pin-nrl119-r2-quoted-link-across-tab-equals-run-residual", "> A [xx\n>\t===\n> yy](zdestz.png) B.", "A xx === yy B."],
		["pin-nrl119-r2-quoted-link-across-tab-div-residual", "> A [xx\n>\t<div>\n> yy](zdestz.png) B.", "A xx yy B."],
		["pin-nrl119-r2-quoted-tab-continuation-across-tab-equals-residual", "> P\n>\tA [ZXZ\n>\t=\n> ZYZ](zdestz.png) ZBZ.", "P A ZXZ = ZYZ ZBZ."],
		["pin-nrl119-r2-nbsp-after-quote-dash-residual", "> ZPZ A ![xx\n>\u00a0-\n> yy](zdestz.png) B.", "ZPZ A xx - yy B."],
		["pin-nrl119-r2-deep-indented-inner-marker-glyph-residual", "> > A [ZXZ\n>     > foo\n> > ZYZ](zdestz.png) ZBZ.", "A ZXZ > foo ZYZ ZBZ."],
		// Displayed text silenced (the label is carried where the renderer ends it):
		// the code opener, the inner quote ended by a lazy tab line, a lazy mixed-lead
		// marker, and a quoted list item's de-indented marker (the last was right on
		// 9522c11, whose tab-eating peel stood in for the item's de-indent).
		["pin-nrl119-r2-quoted-code-opener-residual", ">\tA ![ZXZ\n>\tZYZ](zdestz.png) ZBZ.", "A [ZXZ ZYZ](zdestz.png) ZBZ."],
		["pin-nrl119-r2-quoted-code-opener-after-blank-quote-line-residual", ">\n>\tA [ZXZ\n>\tZYZ](zdestz.png) ZBZ.", "A [ZXZ ZYZ](zdestz.png) ZBZ."],
		// CLOSED by NRL-166 fix round 1 (the walker records `>\tfoo` as fresh code
		// of the outer quote): now the renderer's `A [ZXZ foo ZYZ](zdestz.png) ZBZ.`.
		["pin-nrl119-r2-partially-lazy-indented-line-residual", "> > A [ZXZ\n>\tfoo\n> > ZYZ](zdestz.png) ZBZ.", "A [ZXZ foo ZYZ](zdestz.png) ZBZ."],
		["pin-nrl119-r2-lazy-space-tab-star-residual", "> A [ZXZ\n \t*\n> ZYZ](zdestz.png) ZBZ.", "A ZXZ * ZYZ ZBZ."],
		["pin-nrl119-r2-quoted-list-tab-star-residual", "> - A [ZXZ\n>\t*\n>  ZYZ](zdestz.png) ZBZ.", "A ZXZ * ZYZ ZBZ."],
		["pin-nrl119-r2-quoted-list-five-space-dash-residual", "> - A [ZXZ\n>     -\n>   ZYZ](zdestz.png) ZBZ.", "A ZXZ - ZYZ ZBZ."],
		// TRIPWIRE, identical on base, 9522c11 and the fix, and a KNOWN LEAK: a quote
		// continuation `>\t* x` (marker WITH content). `LIST_BULLET`'s any-indent
		// `^\s*` stops on it where the renderer keeps it as tab-led lazy prose, so the
		// destination is spoken. That arm is shared with the `listDedented` pass and
		// NRL-93 measured a regression from touching it, so it is its own ticket,
		// NRL-161. Change this on purpose when it closes.
		["pin-nrl119-r2-quoted-image-across-tab-star-with-content-still-leaks", "> A ![xx\n>\t* x\n> yy](zdestz.png) B.", "A [xx x yy](zdestz.png) B."],
		// TRIPWIRE, green on base, on the pre-round head and on the fix. A quoted
		// code span whose closer sits on a LAZY continuation line (no `>`) is not
		// carried, because `codeSpanClosesLater` tests the raw opener line and
		// `BLOCKQUOTE` stops it there (the code-span twin of NRL-88 root 1, which
		// NRL-98 closed for labels only). The renderer makes `xx --> yy` one inline
		// code span, so under `skipInlineCode` it should go silent and we speak it.
		// Nothing hidden is spoken: the text is displayed, as code. Recorded because
		// NRL-119's term-2 change UNMASKS it inside a `<!--` opener's paragraph, where
		// base's wider comment hid it: the fix round's carry fuzz found
		// `A `xx <!--` / `*` / `> A `zz` / `--> yy` B.`, base `"A xx yy B."`, PR
		// `"A xx <!-- * A zz --> yy B."`, renderer `<code>zz --> yy</code>`. Change this
		// on purpose when the code-span container class is closed.
		["pin-nrl119-quoted-code-span-lazy-closer-not-carried", "> A `xx\n--> yy` B.", "A xx --> yy B."],
		// MUST NOT WIDEN, three controls, all three green on BOTH sides of NRL-111.
		// Each dash shape keeps the stop NRL-95 gave it, for three different reasons
		// and none of them setext: `---` and longer are `thematicBreak`, which is in
		// `u.interruptParagraph` unconditionally; `--` cannot be crossed by the
		// inline regex; a lone `-` is a bare list marker, which module 745 accepts
		// with nothing after it (`next!=="\n" && next!==""` passes) and `list` is
		// also unconditionally in the list. Measured: all three render with HIDDENE
		// VISIBLE, so speaking it is correct in all three.
		//
		// Room to fail, measured arm by arm rather than assumed. The `--` guard is
		// RED on the arm whose content-line count resets at a dash run, and the lone
		// `-` guard is RED on the delete-the-term arm. The `---` guard below is RED on
		// NEITHER: `---` is matched by `HR` and by `TERM2_DASH_RUN` both, so no
		// single-term arm reaches it (an HR-removed arm was built and it stays green,
		// while `pin-nrl95-hr-between`'s `***` goes red). It is kept as a record of
		// the `---` shape's renderer verdict and is NOT evidence for this fix.
		["guard-nrl111-hr-dashes-third-line", "Prose <!--\nmore\n---\nHIDDENE\n--> t.", "Prose <!-- more HIDDENE --> t."],
		// The `--` is spoken. It used not to be: `extractChunks`' own heading
		// tracking took `more` / `--` as a setext heading and dropped the underline,
		// where the renderer keeps both as prose in one paragraph. That divergence
		// closed with NRL-120's exact-shape setext rule (two content lines above,
		// so no heading), re-read on Obsidian 1.13.7's MarkdownRenderer 2026-10-01.
		["guard-nrl111-dash-pair-third-line", "Prose <!--\nmore\n--\nHIDDENE\n--> t.", "Prose <!-- more -- HIDDENE --> t."],
		// TRIPWIRE. Obsidian renders the lone `-` as an EMPTY LIST BULLET
		// (`<p>Prose &lt;!-- more</p><ul><li>HIDDENE --&gt; t.</li></ul>`), so the
		// `-` is markup and should not be spoken. Since NRL-120's exact-shape setext
		// rule stopped swallowing it as an underline, it is spoken as a glyph. No
		// word is lost or leaked; under skipHeadings the old rule dropped
		// `Prose <!-- more` with it. NRL-119 closed the term-2 STOP for a bare marker
		// and deliberately left this expectation alone: the stop was already right
		// here (`TERM2_LONE_DASH`), and what is wrong is the GLYPH, which only
		// `LIST_BULLET`'s block-level `\s+` strip could drop. That strip feeds
		// `containerPrefix` and `blockType` and accepts any `\d+`, so it needs its
		// own position-gated measurement; NRL-154, the bare-marker glyph follow-up
		// filed from NRL-119, owns it. Change this on purpose when NRL-154 closes.
		["guard-nrl111-lone-dash-third-line", "Prose <!--\nmore\n-\nHIDDENE\n--> t.", "Prose <!-- more - HIDDENE --> t."],
		// The content-line count must RESET at a block end, or an opener that is not
		// on line 0 never sees its own `===` as a second line and the fix hides text
		// the renderer shows. The blank line here is the reset. Measured RED against
		// an arm whose count never resets (it says `"Lead. Prose t."`) and green on
		// base and on the fix, so it is a guard with REAL room to fail rather than a
		// decorative one.
		["guard-nrl111-count-resets-at-a-block-end", "Lead.\n\nProse <!--\n===\nHIDDENE\n--> t.", "Lead. Prose <!-- HIDDENE --> t."],
		// The shape that caught a bug in the PROBE rather than in the code, kept
		// because it is worth not rediscovering: Obsidian's heading handler emits
		// `data-heading="<raw heading text>"`, so this note's HTML carries a literal
		// `<!--` inside an ATTRIBUTE. An oracle that scans the rendered HTML for
		// `<!--` with `indexOf` takes that as a comment opener and reports HIDDENE as
		// hidden when a reader plainly sees it. Measured: the real HTML is
		// `<h1 data-heading="Prose <!--">Prose &#x3C;!--</h1><h1 ...>more</h1><p>HIDDENE<br>--> t.</p>`.
		// HONEST LABEL: this fixture has NO room to fail against any of the four
		// alternate implementations NRL-111 built except the delete-the-term one -
		// the scan stops at line 1 in every arm - so it is a record of the shape, not
		// evidence for the fix.
		["guard-nrl111-double-setext-attribute-shape", "Prose <!--\n===\nmore\n===\nHIDDENE\n--> t.", "Prose <!-- more HIDDENE --> t."],
		// NRL-111's SECOND PASS, F4. The first draft gated the `=` run on block
		// position and left the dash run unconditionally not-a-block-end, which
		// repeats for dashes the exact position-independent error it had just fixed
		// for `=`. A dash run that IS its block's second line is a setext `<h2>` and
		// therefore a real block end, so the `===` below has ONE content line above
		// it, is an underline, and the renderer DISPLAYS HIDDENE. Measured:
		// `Lead.` / `--` renders `<h2 data-heading="Lead.">Lead.</h2>`. The `--`
		// itself is not spoken because `extractChunks`' own heading tracking drops a
		// setext underline, which is unchanged and not what this pins. GREEN on base
		// 874410d and RED against NRL-111's first draft, so it is a regression pin
		// with real room to fail rather than a record. 512 cells.
		["pin-nrl111-dash-run-on-a-second-line-is-an-h2", "Lead.\n--\nProse <!--\n===\nHIDDENE\n--> t.", "Lead. Prose <!-- HIDDENE --> t."],
		// The gate's other direction, and the reason `TERM2_DASH_RUN` keeps its
		// ungated SCAN stop while only `TERM2_SETEXT_DASH` is a block end. Here the
		// `--` has TWO content lines above it, so it is paragraph prose rather than
		// an `<h2>`, the `===` has three, and the renderer HIDES HIDDENE - measured.
		// RED against base 874410d, which spoke it. The `--` is spoken since NRL-120's
		// exact-shape setext rule: the renderer displays it (`<p>L1. L2. -- Prose
		// t.</p>`, read 2026-10-01), and HIDDENE stays hidden, which is the point.
		["guard-nrl111-dash-run-off-a-second-line-is-not-an-h2", "L1.\nL2.\n--\nProse <!--\n===\nHIDDENE\n--> t.", "L1. L2. -- Prose t."],
		// THREE TRIPWIRES for three roots NRL-111 deliberately does NOT fix. Each is
		// PROSE LOSS: the renderer DISPLAYS the sentinel and we drop it. None of
		// them leaks IN ITS MEASURED CORPUS (F1 0 of 7,680 room). Do NOT restate the
		// stronger claim an earlier revision made here - that a narrow stop set used
		// as a block-end COUNTER "can only OVER-count", so none CAN leak. NRL-111's
		// second Verify falsified it: the counter also UNDER-counts, because
		// `TERM2_LIST` matches a container-OPENING marker line (a block start, not a
		// block end) and `line.trim() === ""` reads a tab-only line as blank, and
		// under-counting to exactly 1 turns the gate on where the renderer has no
		// underline. Measured 55,296 and 12,288 class-A cells, both saturated, 0
		// newly leaking and cell-for-cell identical on base and on an uncapped arm,
		// so shipped behaviour is untouched and only the claim was wrong. Each count
		// below was measured on its own corpus with the real parser and renderer.
		//
		// LABEL THEM HONESTLY: all three are RED against base 874410d, so they are
		// prose this pass stops speaking. Base spoke the sentinel, and base was
		// accidentally RIGHT on these three shapes, because it stopped at an `=` run
		// unconditionally - the same unconditional stop that was a 26,880-cell
		// disclosure elsewhere in the same corpus. The gate removes the disclosure
		// and exposes this residue in the same move; the trade is 25,344 class-A
		// cells closed against 1,536 class-B cells lost on NRL-111's main two-class
		// corpus, all of the loss being these three roots. Linear tickets are being
		// filed; do not fix one of them by widening the gate.
		//
		// F1, 6,144 cells over 12 of 17 shapes (room 7,680): the forward pass uses
		// the term-2 STOP set as a BLOCK-END set, and that set omits real renderer
		// block ends - blockquote, nested quote, table, `$$`, indented code, footnote
		// definition, link reference definition, a bare `* + 1. 1)` marker, a comment
		// block - so `paraLinesAbove` over-counts and a correct second-line stop is
		// suppressed. The blockquote shape below is the smallest member.
		["tripwire-nrl111-f1-blockquote-above-is-not-a-counted-block-end", "> Lead.\nProse <!--\n===\nHIDDENE\n--> t.", "Lead. Prose t."],
		// F2, 3,584 cells over 7 of 9 shapes (room 4,608): module 4839's inline regex
		// body cannot consume two consecutive dashes, so ANY mid-line `--` between
		// opener and closer makes the construct literal and the renderer shows
		// everything. We detect dash-ONLY lines. Declared out of scope by NRL-111's
		// own PR before Verify measured it.
		// NRL-166 fix round 1: the first `<!--`'s body holds the second `<!--`, so
		// it is no inline comment; the second one is, and hides only `more2`. Now
		// the renderer's text, `A <!-- more === HIDDENE B t.`.
		["tripwire-nrl111-f2-midline-dashes-between-opener-and-closer", "A <!--\nmore\n===\nHIDDENE\nB <!--\nmore2\n--> t.", "A <!-- more === HIDDENE B t."],
		// F3, 3,072 cells over 6 of 21 shapes (room 3,072, saturated):
		// `TERM2_SETEXT_EQ` is anchored at column 0 and the renderer peels the
		// container prefix first, so an `=` run inside a list item or an ordered item
		// is a real underline to it and prose to us. The quote-prefixed members of
		// that corpus are lost on base too and are not part of the 3,072.
		["tripwire-nrl111-f3-container-indented-eq-run", "- Prose <!--\n  ===\n  HIDDENE\n  --> t.", "Prose t."],
		// HIDDENF is dropped by skipCodeBlocks, correctly and for a different
		// reason: the fence stops the term-2 scan, so the `<!--` is literal, and
		// the fenced body is then excluded as content rather than hidden as comment.
		["pin-nrl95-fence-between", "Prose <!--\n```\nHIDDENF\n```\n--> t.", "Prose <!-- --> t."],
		// The D-74-9 destination class extended across a paragraph break. Base both
		// LOSES prose and speaks `[alt`/`[lab`, because the document-scoped term 2
		// saw the `-->` in the next paragraph and opened a block on the label line.
		// With the bound in place the label carry is confirmed and the destination
		// is dropped, exactly as the single-paragraph twins at
		// pin-nrl74-label-destination-not-spoken already do.
		["pin-nrl95-label-dest-closer-later-para", "Before ![alt <!--x\nmore](zdestz.png) after.\n\nnew para -->", "Before after. new para -->", { speakImageAlt: false }],
		["pin-nrl95-link-label-dest-closer-later", "Before [lab <!--x\nmore](zdestz.png) after.\n\nnew para -->", "Before lab more after. new para -->"],
		// The WIDENING, shown on a fixture. Narrowing term 2 narrows
		// opensHtmlBlock -> opensHiddenComment -> interruptsParagraph, so BOTH
		// carries return false LESS often and confirm MORE often. A code span now
		// survives a break its own paragraph never ended at. This is the opposite
		// direction to NRL-74, and ADR 0025 and AGENTS.md both stated it backwards
		// until this ticket corrected them.
		["pin-nrl95-codespan-closer-later-para", "Before `a\nProse <!--\nHIDDENX\nb` after.\n\nnew -->", "Before a Prose <!-- HIDDENX b after. new -->", { skipInlineCode: false }],
		// NRL-45's leftover in its `<!--` HALF ONLY. An unmatched comment opener
		// inside a link reference definition's quoted title used to hide every
		// following line, because a `-->` anywhere later in the note counted. The
		// `%%` half of that leftover is UNTOUCHED and stays open, so do NOT record
		// NRL-45 as closed on the strength of this fixture.
		["pin-nrl95-linkrefdef-title-closer-later", "[a]: x.png \"<!--\"\n\nZS here.\n\n-->\n\nZAFTERZ here.", "ZS here. --> ZAFTERZ here."],
		// The stop set's DEPARTURES from interruptsParagraph's own term list, and
		// they are three different reasons rather than one. BLOCKQUOTE and
		// TABLE_ROW are dropped; LIST_BULLET is REPLACED by TERM2_LIST. Each guard
		// below was MEASURED RED against the arm that puts the dropped term back,
		// and each such red is a NEW DISCLOSURE that would be taken to close a
		// prose-loss defect, which ADR 0006 and ADR 0007 clause 6 forbid. Without
		// them nothing in the suite would catch a later "simplify endsTerm2Scan to
		// interruptsParagraph's own term list" pass. The `pin-` entries in the same
		// block are the opposite: they are the prose loss the corrected list half
		// CLOSES, plus two tripwires for the container blindness it does not.
		//
		// G1-G3: a blockquote re-offers its stripped lines as ONE paragraph inside
		// the container, so module 4839's inline regex DOES find the closer and
		// Obsidian hides that text. The renderer's blockquote tokenizer PEELS the
		// `>` and re-runs the paragraph tokenizer on the stripped content, so a
		// continuation line of the same quote is not a quote STARTING -
		// `blockquote` being in `u.interruptParagraph` is about the other case and
		// does not contradict this. RED on the arm that stops at BLOCKQUOTE.
		["guard-nrl95-container-closer-in-quote", "> Prose <!--\n> HIDDENQ\n> more -->\nTail.", "Prose Tail."],
		["guard-nrl95-container-closer-nested-quote", "> > Prose <!--\n> > HIDDENN\n> > more -->", "Prose"],
		// The blockquote exclusion's COST, pinned as a tripwire rather than as
		// evidence of anything: here the quote STARTS after the opener, so the
		// renderer's paragraph really does end at line 2 and it displays every
		// line. We hide HIDDENQ3. Fail-closed, identical on base, and only fixable
		// with container-prefix awareness (the NRL-88 root-1 class). When that
		// lands this expectation must change ON PURPOSE.
		["pin-nrl95-quote-starting-after-opener-still-hidden", "Prose <!--\n> HIDDENQ3\nmore -->", "Prose"],
		// G4: TABLE_ROW is dropped because NO table row can interrupt a paragraph
		// in Obsidian at all - `table` appears nowhere in `u.interruptParagraph`
		// (read from app.js this session) and the only terms ever inserted into
		// that list are `math` and `comment`. So a `| a |` line is a paragraph
		// continuation for the renderer whether or not a delimiter row follows,
		// which is why the third fixture below - a REAL GFM table - is here: the
		// weaker "GFM needs a delimiter row" reading of this exclusion would not
		// cover it, and a later pass that "fixes" TABLE_ROW to require a
		// delimiter row and then adds it to endsTerm2Scan reopens the disclosure
		// on exactly that shape. RED on the arm that stops at TABLE_ROW, in both
		// skipTables positions.
		["guard-nrl95-table-row-closer", "Prose <!--\n| a |\nHIDDENT\n--> t.", "Prose t."],
		["guard-nrl95-table-row-closer-spoken", "Prose <!--\n| a |\nHIDDENT\n--> t.", "Prose t.", { skipTables: false }],
		// NRL-166 fix round 1: `| --- | --- |` puts `--` in the comment's body, so the
		// renderer has no comment and displays HIDDENT (`Prose <!-- | a | b | |
		// --- | --- | HIDDENT --> t.`). The table-shaped lines stay silent under
		// skipTables, a pre-existing loss.
		["guard-nrl95-real-gfm-table-closer", "Prose <!--\n| a | b |\n| --- | --- |\nHIDDENT\n--> t.", "Prose <!-- HIDDENT --> t."],
		// THE LIST HALF, corrected at ship review. `LIST_BULLET` is REPLACED by
		// `TERM2_LIST`, not dropped, because it is right for bullets and wrong for
		// ordered markers, and the earlier "a list re-offers its lines as one
		// paragraph" reading of this exclusion was FALSE: a `- x` / `- y` / `- z`
		// list is three items with three paragraphs, so the closer is NOT in the
		// opener's paragraph and Obsidian displays every line. The two fixtures
		// below were `"Prose Tail."` and `"Prose t."` - hiding HIDDENL and HIDDENB -
		// and both were measured RED against that staged behaviour before the
		// TERM2_LIST stop was added. Module 745's silent entry is the authority for
		// a bullet AT A VALID INDENT; NRL-95's gloss "any bullet at any indent
		// interrupts" was false and the two fixtures below used to encode it, see
		// their own comment.
		["pin-nrl95-bullet-items-are-three-paragraphs", "- Prose <!--\n- HIDDENL\n- more -->\nTail.", "Prose <!-- HIDDENL more --> Tail."],
		["pin-nrl95-bullet-line-between", "Prose <!--\n- item\nHIDDENB\n--> t.", "Prose <!-- item HIDDENB --> t."],
		// REPLACED IN PLACE per the NRL-66/NRL-67 convention, and renamed because
		// the old names (`pin-nrl95-bullet-any-indent`, `pin-nrl95-bullet-tab-indent`)
		// asserted the opposite of the renderer's own answer. Both used to expect
		// `"Prose <!-- HIDDENL more -->"`, i.e. they pinned a LIVE DISCLOSURE as
		// expected behaviour, inherited from NRL-95 and widened by NRL-111's first
		// draft before this pass capped it.
		//
		// Module 745's list tokenizer gives up past three columns of indent, and a
		// tab reaches column four on its own, so at four spaces or at a tab the
		// marker line is a lazy paragraph continuation and the inline comment regex
		// crosses it. Measured against real rendered HTML out of the installed
		// obsidian.asar 1.13.7 in NRL-111's fix-forward session: both of these notes
		// render as ONE `<p>` holding the whole raw comment
		// (`<p>Prose <!--\n    - HIDDENL\nmore --></p>`), so the renderer HIDES
		// HIDDENL and speaking it is a disclosure. Both are RED against base
		// 874410d AND against the first draft of NRL-111.
		//
		// A tab is Obsidian's own default indent for a nested list item, so this is
		// the ordinary shape and not an exotic one.
		["pin-nrl111-bullet-four-space-indent-is-not-a-marker", "Prose <!--\n    - HIDDENL\nmore -->", "Prose"],
		["pin-nrl111-bullet-tab-indent-is-not-a-marker", "Prose <!--\n\t- HIDDENL\nmore -->", "Prose"],
		["pin-nrl95-ordered-one-dot-interrupts", "Prose <!--\n1. HIDDENL\nmore -->", "Prose <!-- HIDDENL more -->"],
		// `1)` DOES interrupt, and NRL-95 had this one backwards. REPLACED IN PLACE
		// per the NRL-66/NRL-67 convention, renamed because the old name
		// (`guard-nrl95-ordered-paren-not-an-interrupter`) asserted the opposite of
		// the truth and would read as a tripwire rather than a corrected pin.
		// Module 745's marker test is `y === h || z && y === v` with
		// `z = options.commonmark` and `v = ")"`; `commonmark` is TRUE, so `)` is a
		// delimiter. Measured against real rendered HTML in NRL-111's Implement
		// session: `Prose <!--` / `1) HIDDENL` / `more -->` renders
		// `<p>Prose &#x3C;!--</p><ol><li>HIDDENL<br>more --></li></ol>`, so the
		// paragraph ends at the marker and HIDDENL is DISPLAYED. Base hid it.
		//
		// CORRECTED BY NRL-111's SECOND PASS. The first draft called this half
		// "prose loss rather than disclosure" and that was true of THIS shape and
		// false of the pattern change that produced it. `TERM2_LIST` was `^[ \t]*`
		// with no indent cap, so adding `1)` to it also added `\t1) `, `    1) ` and
		// every other over-indented form - all of which the renderer HIDES - and the
		// widening therefore shipped 7,168 newly leaking cells of its own. The
		// exhaustive direction argument had identified the class correctly and
		// MIS-SIGNED it: it proved every widening was a `1)` and then assumed a
		// `1)` was benign. The indent cap, landed in the same pattern, is what makes
		// the sentence above true. RED against base 874410d.
		["pin-nrl111-ordered-paren-interrupts", "Prose <!--\n1) HIDDENL\nmore -->", "Prose <!-- HIDDENL more -->"],
		// And the ordered half that must NOT stop the scan. Each of these is a line
		// module 745's SILENT path refuses because its digit string is not exactly
		// `"1"` (`if (silent && o !== "1") return`), so the renderer keeps one
		// paragraph and HIDES the sentinel. Measured: `7.`, `7)`, `01.` and `01)`
		// all render as one `<p>` with the sentinel inside the raw comment. The
		// first TWO are lines `LIST_BULLET` matches, and both were measured RED
		// against the arm that puts the whole of `LIST_BULLET` in the stop set -
		// i.e. they are the disclosure that arm would ship, and they are the real
		// justification for the digit-string exclusion. The THIRD is green on that
		// arm too (`LIST_BULLET` needs `\s+` after the marker, so it misses `-x` as
		// well): it guards TERM2_LIST's own `[ \t]` requirement instead, and is
		// labelled a guard rather than counted. All three are green on both sides of
		// NRL-111's `1[.)]` widening.
		["guard-nrl95-ordered-seven-not-an-interrupter", "Prose <!--\n7. HIDDENL\nmore -->", "Prose"],
		["guard-nrl95-ordered-zero-padded-not-an-interrupter", "Prose <!--\n01. HIDDENL\nmore -->", "Prose"],
		// The `)` twin of each, added by NRL-111 so the widening to `1[.)]` cannot be
		// loosened to `\d+[.)]` or `\d[.)]` without a red check.
		["guard-nrl111-ordered-seven-paren-not-an-interrupter", "Prose <!--\n7) HIDDENL\nmore -->", "Prose"],
		["guard-nrl111-ordered-zero-padded-paren-not-an-interrupter", "Prose <!--\n01) HIDDENL\nmore -->", "Prose"],
		["guard-nrl95-bullet-needs-a-space", "Prose <!--\n-x HIDDENL\nmore -->", "Prose"],
		// CLOSED BY NRL-114, replaced in place keeping its name (the NRL-66 / NRL-67
		// convention), so the name now reads backwards. This tripwire said a bullet
		// INSIDE the quote was invisible to the term-2 scan because the scan read the
		// raw line and never peeled the `>`. NRL-114's `term2QuotedStop` hands the
		// unchanged `endsTerm2Scan` the line with its quote levels peeled, so `> - `
		// now ends the opener's paragraph exactly as the renderer's peeled list does.
		// Measured with Obsidian 1.13.7's parser run in Node: `<blockquote><p>Prose
		// &#x3C;!--</p><ul><li>HIDDENL<br>more --></li></ul></blockquote>`, every word
		// displayed. RED on base 9132c3b (`Prose`) and on 7cdc7b7 alone.
		["pin-nrl95-bullet-inside-quote-still-hidden", "> Prose <!--\n> - HIDDENL\n> more -->", "Prose <!-- HIDDENL more -->"],
		// A single list item whose paragraph continues on indented lines IS one
		// paragraph, so the closer is reached and the sentinel is correctly hidden.
		// Green on both sides; it exists so TERM2_LIST is not widened to match a
		// continuation line.
		["guard-nrl95-one-item-continuation-hides", "- Prose <!--\n  HIDDENL\n  more -->", "Prose"],
		// The residual this ticket does NOT close, pinned so it is not rediscovered
		// as new. The scan is forward-only FROM the opener line and does not bound
		// the opener's OWN block, so an ATX heading's mid-line `<!--` still reaches
		// a closer that module 4839's paragraph-scoped path could not. Over-hiding,
		// so fail-closed; pre-existing; the same class as the already-pinned
		// `heading-tracking` `%%` divergence above. Identical to
		// heading-html-tracking and out of scope here.
		["guard-nrl95-atx-opener-not-bounded", "# Heading <!--hidden\nhidden\n--> after.", "after.", { skipHeadings: true }],
		// NRL-98 ROOTS 1 AND 2 (ADR 0023's residual-roots list, ADR 0029, R-M09).
		// A soft-wrapped label whose opener line, or any line between opener and
		// closer, carried a container prefix was never confirmed, so the whole
		// construct fell through as prose and the destination was read aloud.
		// `bracketClosesLater` now peels at most the OPENER's own quote levels
		// from each continuation line before running the UNCHANGED
		// `interruptsParagraph` and `labelClose` on it, and the bracket arming
		// guard accepts a "quote" or "list" opener as well as a "paragraph" one.
		//
		// Obsidian renders every one of these as an image or a link: module 6234
		// (blockquote) strips one `>` per line and calls tokenizeBlock on the
		// JOINED remainder, module 745 (list) strips the marker and up to four
		// leading spaces per line and does the same, and module 9405's label scan
		// has no newline exclusion at all. So the destination is an attribute the
		// renderer does not display and speaking it is a genuine R-M09 leak.
		// Read out of the installed obsidian.asar 1.13.7, app.js sha256
		// 8efbf581e259cabef4f9c9a34814cfe3c02863757377e56b3603933c50e89898.
		// NOT OBSERVED IN OBSIDIAN - CDP 9222 was not listening for this work.
		//
		// Each row's expectation is its plain-paragraph twin's, which is the fix:
		// `pin-nrl63-softwrapped-image` says "A alt words B" / "A B", and a
		// container prefix must not change that. The `>` and the bullet are never
		// spoken, because the peel is the SAME prefix the consumption site uses.
		["pin-nrl98-root1-blockquote", "> A ![alt\n> words](zdestz.png) B", "A B", { speakImageAlt: false }],
		["pin-nrl98-root1-blockquote-alt", "> A ![alt\n> words](zdestz.png) B", "A alt words B", { speakImageAlt: true }],
		["pin-nrl98-root1-nested-blockquote", "> > A ![alt\n> > words](zdestz.png) B", "A B", { speakImageAlt: false }],
		["pin-nrl98-root1-nested-blockquote-alt", "> > A ![alt\n> > words](zdestz.png) B", "A alt words B", { speakImageAlt: true }],
		// A continuation with NO prefix is a lazy continuation, which the renderer
		// accepts (interruptBlockquote holds no `paragraph` entry), so the empty
		// prefix is inside the peel budget rather than a mismatch.
		["pin-nrl98-root1-lazy-continuation", "> A ![alt\nwords](zdestz.png) B", "A B", { speakImageAlt: false }],
		["pin-nrl98-root1-lazy-continuation-alt", "> A ![alt\nwords](zdestz.png) B", "A alt words B", { speakImageAlt: true }],
		["pin-nrl98-root1-bullet-unindented", "- A ![alt\nwords](zdestz.png) B", "A B", { speakImageAlt: false }],
		["pin-nrl98-root1-bullet-unindented-alt", "- A ![alt\nwords](zdestz.png) B", "A alt words B", { speakImageAlt: true }],
		["pin-nrl98-root1-ordered", "1. A ![alt\n   words](zdestz.png) B", "A B", { speakImageAlt: false }],
		["pin-nrl98-root1-ordered-alt", "1. A ![alt\n   words](zdestz.png) B", "A alt words B", { speakImageAlt: true }],
		["pin-nrl98-root1-task", "- [ ] A ![alt\n  words](zdestz.png) B", "A B", { speakImageAlt: false }],
		["pin-nrl98-root1-task-alt", "- [ ] A ![alt\n  words](zdestz.png) B", "A alt words B", { speakImageAlt: true }],
		// The indent-only continuation at 4+ spaces inside a list item. `inList`
		// already shields it from being read as indented code, so the only thing
		// that stopped the carry was the opener line's own bullet.
		["pin-nrl98-root1-indent-only", "- A ![alt\n      words](zdestz.png) B", "A B", { speakImageAlt: false }],
		["pin-nrl98-root1-indent-only-alt", "- A ![alt\n      words](zdestz.png) B", "A alt words B", { speakImageAlt: true }],
		// Root 2: the container marker is on a line BETWEEN opener and closer.
		["pin-nrl98-root2-bq-interior", "> A ![alt\n> mid\n> words](zdestz.png) B", "A B", { speakImageAlt: false }],
		["pin-nrl98-root2-bq-interior-alt", "> A ![alt\n> mid\n> words](zdestz.png) B", "A alt mid words B", { speakImageAlt: true }],
		["pin-nrl98-root2-bq-lazy-interior", "> A ![alt\nmid\n> words](zdestz.png) B", "A B", { speakImageAlt: false }],
		["pin-nrl98-root2-list-interior", "- A ![alt\n  mid\n  words](zdestz.png) B", "A B", { speakImageAlt: false }],
		["pin-nrl98-root2-list-interior-alt", "- A ![alt\n  mid\n  words](zdestz.png) B", "A alt mid words B", { speakImageAlt: true }],
		// A SHALLOWER continuation is carried, matching the renderer's inner-level
		// lazy continuation. The plan filed this as a guard; it is a REGRESSION
		// case, measured leaking at e4c9c1d.
		["pin-nrl98-shallower-quote-carried", "> > A ![alt\n> words](zdestz.png) B", "A B", { speakImageAlt: false }],
		["pin-nrl98-shallower-quote-carried-alt", "> > A ![alt\n> words](zdestz.png) B", "A alt words B", { speakImageAlt: true }],
		// The same scanner covers a soft-wrapped LINK in a container, whose label
		// is spoken in both speakUrls positions and whose destination is not.
		["pin-nrl98-link-in-quote", "> A [lab\n> words](zdestz.png) B", "A lab words B"],
		["pin-nrl98-link-in-quote-urls-on", "> A [lab\n> words](zdestz.png) B", "A lab words B", { speakUrls: true }],
		// And the reference form's `[ref]` tail, exactly as on one line.
		["pin-nrl98-reference-form-in-quote", "> A ![alt\n> words][zrefz] B", "A B", { speakImageAlt: false }],
		["pin-nrl98-reference-form-in-quote-alt", "> A ![alt\n> words][zrefz] B", "A alt words B", { speakImageAlt: true }],
		// GUARDS from here down. Green on BOTH sides of the fix, so none is
		// evidence of anything; they exist so the peel budget cannot be
		// half-adopted into a blind peel, which is what the measured blind-peel
		// diagnostic arm did - it silenced G2, G3, G4, G5 and G6 below, every one
		// of which Obsidian DISPLAYS.
		//
		// A container marker on a continuation of a paragraph that started
		// OUTSIDE that container really does end the paragraph in Obsidian:
		// `interruptParagraph` holds a `blockquote` and a `list` entry. So the
		// destination here is DISPLAYED and speaking it is renderer-faithful.
		["guard-nrl98-outside-bq-continuation", "A ![alt\n> words](zdestz.png) B", "A [alt words](zdestz.png) B", { speakImageAlt: false }],
		["guard-nrl98-outside-bq-interior", "A ![alt\n> mid\nwords](zdestz.png) B", "A [alt mid words](zdestz.png) B", { speakImageAlt: false }],
		["guard-nrl98-outside-list-interior", "A ![alt\n- mid\nwords](zdestz.png) B", "A [alt mid words](zdestz.png) B", { speakImageAlt: false }],
		// DEEPER than the opener opens a new container, so it ends the paragraph.
		// The budget spends the opener's one quote level and the UNCHANGED
		// BLOCKQUOTE arm then rejects the `>` that is left.
		["guard-nrl98-deeper-quote", "> A ![alt\n> > words](zdestz.png) B", "A [alt words](zdestz.png) B", { speakImageAlt: false }],
		// A list marker on a continuation always starts a NEW item (module 745's
		// `M` branch), so the UNCHANGED LIST_BULLET arm must keep rejecting it.
		["guard-nrl98-deeper-list", "- A ![alt\n  - words](zdestz.png) B", "A [alt words](zdestz.png) B", { speakImageAlt: false }],
		["guard-nrl98-same-list-marker", "- A ![alt\n- words](zdestz.png) B", "A [alt words](zdestz.png) B", { speakImageAlt: false }],
		// Mixed containers, both ways round: the budget peels quotes only, so
		// neither crossing is accepted.
		["guard-nrl98-quote-then-list", "> A ![alt\n- words](zdestz.png) B", "A [alt words](zdestz.png) B", { speakImageAlt: false }],
		["guard-nrl98-list-then-quote", "- A ![alt\n> words](zdestz.png) B", "A [alt words](zdestz.png) B", { speakImageAlt: false }],
		// A CALLOUT TITLE line as the opener fails closed. Module 6234 matches
		// /^\[!([^\]]+)\]([+\-]?)(?:\s|$)/ only at `f===0` and then runs
		// tokenizeBlock on that first stripped line ALONE, so a callout title can
		// never join the paragraph below it and Obsidian displays the
		// destination. A callout BODY line as the opener is unaffected.
		["guard-nrl98-callout-title-opener", "> [!note] A ![alt\n> words](zdestz.png) B", "A [alt words](zdestz.png) B", { speakImageAlt: false }],
		// The four fail-closed stops inside a container, so the widened
		// confirmation is shown still to give up where NRL-63 made it give up.
		["guard-nrl98-blank-in-quote", "> A ![alt\n>\n> words](zdestz.png) B", "A [alt words](zdestz.png) B", { speakImageAlt: false }],
		["guard-nrl98-fence-in-quote", "> A ![alt\n> ```\n> words](zdestz.png) B", "A [alt words](zdestz.png) B", { speakImageAlt: false }],
		["guard-nrl98-comment-in-quote", "> A ![alt\n> %%\n> words](zdestz.png) B", "A [alt", { speakImageAlt: false }],
		// The DISPLAY-MATH stop is root 3 (ADR 0023 clause 7a) and the ONLY one of
		// the four that is not in `interruptsParagraph`, so the peel does not
		// reach it: `opensMathBlock` tests `raw.trimStart().startsWith("$$")`,
		// which a `>`-prefixed line fails. Measured during critique: without the
		// quote budget threaded into it, this shape CARRIED where its plain twin
		// `A ![alt / $$ / words](zdestz.png) B / $$` aborts and says
		// "A [alt equation", so a container prefix changed the answer in the
		// prose-loss direction - Obsidian renders `$$` inside a blockquote as a
		// display-math block, which ends the paragraph, so `words](zdestz.png) B`
		// is displayed as math source and silencing it loses it. The stop is now
		// container-aware and this shape stays in root 3: destination spoken,
		// fail-closed, nothing silenced. An indented `$$` under a bullet already
		// stopped, `trimStart` covering it, and is unchanged.
		["guard-nrl98-quoted-math-block-fails-closed", "> A ![alt\n> $$\n> words](zdestz.png) B\n> $$", "A [alt $$ words](zdestz.png) B $$", { speakImageAlt: false }],
		["guard-nrl98-quoted-math-block-fails-closed-alt", "> A ![alt\n> $$\n> words](zdestz.png) B\n> $$", "A [alt $$ words](zdestz.png) B $$", { speakImageAlt: true }],
		// A COMPLETE `$$x$$` on the interior line is not a block opener (the
		// second `$$` disqualifies it), so it is carried, exactly as its plain
		// twin `A ![alt / $$x$$ / words](zdestz.png) B` is. The two rows together
		// pin that the budget narrows nothing but the block form. The indented
		// `- A ![alt / \u0020 $$ / \u0020 words](...) / \u0020 $$` form cannot be pinned
		// HERE, and that is a property of this table rather than of the fix: a
		// display-math block becomes a synthesised "equation" chunk whose text is
		// in no source offset, so this table's character-identity assertion fails
		// on it for the PLAIN twin too (measured). It is unchanged by this diff.
		["guard-nrl98-quoted-complete-math-span-carried", "> A ![alt\n> $$x$$\n> words](zdestz.png) B", "A B", { speakImageAlt: false }],
		// TWO MORE STOPS the peel exposes, both found at ship review by EXECUTING
		// Obsidian's own remark parser out of the asar rather than reading it, and
		// both prose loss before the correction. Once a `>` is peeled, correctness
		// needs `interruptBlockquote` modelled and not only `interruptParagraph`,
		// and the two sets differ:
		//
		//   `u.interruptBlockquote` holds ["indentedCode",{commonmark:true}], which
		//   `interruptParagraph` does NOT, so a LAZY continuation (no `>` at all)
		//   indented four spaces or led by a tab ENDS the blockquote and becomes an
		//   indented CODE block, displayed verbatim. A continuation that KEEPS its
		//   `>` is the opposite case and must stay carried: indented code cannot
		//   interrupt a paragraph, so `>     words](...)` really is one paragraph
		//   with an image. Both directions are pinned below.
		//
		//   `interruptParagraph` holds "html" and our `interruptsParagraph` covers
		//   html only through `opensHiddenComment`, i.e. `%%` and `<!--`. A
		//   block-level tag on a continuation line ends the paragraph and swallows
		//   the rest into raw HTML, which Obsidian displays. The PLAIN form of that
		//   shape is already carried at base, so it is PRE-EXISTING and is NOT
		//   fixed here (filed as a leftover); only the cells the container peel
		//   newly reaches are stopped, which is why the stop is gated on a
		//   container being in play.
		["guard-nrl98-lazy-indented-continuation-fails-closed", "> A ![alt\n    words](zdestz.png) B", "A [alt words](zdestz.png) B", { speakImageAlt: false }],
		["guard-nrl98-lazy-tab-continuation-fails-closed", "> A ![alt\n\twords](zdestz.png) B", "A [alt words](zdestz.png) B", { speakImageAlt: false }],
		["guard-nrl98-lazy-indented-interior-fails-closed", "> A ![alt\n    mid\n> words](zdestz.png) B", "A [alt mid words](zdestz.png) B", { speakImageAlt: false }],
		["guard-nrl98-nested-lazy-indented-fails-closed", "> > A ![alt\n    words](zdestz.png) B", "A [alt words](zdestz.png) B", { speakImageAlt: false }],
		// The counter-direction: a continuation that KEEPS its quote prefix and is
		// then indented is a paragraph continuation, so it stays carried. These two
		// are what stops the stop above being widened into a blind indent test.
		["guard-nrl98-quoted-indented-continuation-carried", "> A ![alt\n>     words](zdestz.png) B", "A B", { speakImageAlt: false }],
		["guard-nrl98-quoted-tab-continuation-carried", "> A ![alt\n>\twords](zdestz.png) B", "A B", { speakImageAlt: false }],
		["guard-nrl98-quote-html-block-interior-fails-closed", "> A ![alt\n> <div>\n> words](zdestz.png) B", "A [alt words](zdestz.png) B", { speakImageAlt: false }],
		["guard-nrl98-lazy-html-block-interior-fails-closed", "> A ![alt\n<p>\n> words](zdestz.png) B", "A [alt words](zdestz.png) B", { speakImageAlt: false }],
		["guard-nrl98-list-html-block-interior-fails-closed", "- A ![alt\n<div>\n  words](zdestz.png) B", "A [alt words](zdestz.png) B", { speakImageAlt: false }],
		// An AUTOLINK at the start of a continuation line is not a tag, so the html
		// stop must not match it and the label stays carried.
		["guard-nrl98-autolink-continuation-carried", "> A ![alt\n> <https://x.example> words](zdestz.png) B", "A B", { speakImageAlt: false }],
		// A shortcut label in a container still carries no destination, so the
		// `](`/`][` requirement keeps it unconfirmed and visible (ADR 0023).
		["guard-nrl98-quote-shortcut-no-tail", "> A ![shortcut\n> more] text", "A [shortcut more] text", { speakImageAlt: false }],
		["guard-nrl98-quote-never-closes", "> A ![alt\n> no closer here", "A [alt no closer here", { speakImageAlt: false }],
		// NRL-64's code-span carry inside a container, unchanged. Beside the four
		// function-body hashes this is the behavioural half of "the code carry did
		// not move".
		["guard-nrl98-code-carry-in-quote", "> A `code\n> more` B", "A code more B", { skipInlineCode: false }],
		// NOT DEFECTS, pinned so they are not "fixed". A setext underline after
		// ONE content line really is a heading in Obsidian: module 8671 eats
		// content to the FIRST newline only and is tried before `paragraph`
		// (8607) at every block start, so `A ![alt` is an h1 with a literal `![`
		// and `words](zdestz.png) B` is a DISPLAYED paragraph.
		["guard-nrl98-setext-one-content-line", "A ![alt\n===\nwords](zdestz.png) B", "A [alt words](zdestz.png) B", { speakImageAlt: false }],
		// The out-of-scope nested-bracket family (`![a [[N|l]] b](dest.png)`),
		// pinned in a container so this ticket is not credited with it.
		["guard-nrl98-nested-bracket-in-quote", "> A ![al [x] t\n> words](zdestz.png) B", "A t words](zdestz.png) B", { speakImageAlt: false }],
		// THE FOLLOW-UP's THREE SHAPES, pinned at their CURRENT values so the
		// residue is recorded rather than lost. None is a container problem and
		// none is fixed here: `table` is absent from Obsidian's
		// `interruptParagraph` entirely and `setextHeading` is gated out of it by
		// `commonmark: true` (module 6047), so all three are genuine leaks whose
		// fix direction is NARROWING interruptsParagraph - which collides with
		// ADR 0019's F5 guard below and must be scoped the way this peel was.
		// Tracked as NRL-109; when it closes these three expectations must change
		// on purpose, and guard-nrl98-setext-one-content-line must NOT.
		["guard-nrl98-residual-table-opener", "| A ![alt |\nwords](zdestz.png) B", "words](zdestz.png) B", { speakImageAlt: false }],
		["guard-nrl98-residual-table-interior", "A ![alt\n| a |\nwords](zdestz.png) B", "A [alt words](zdestz.png) B", { speakImageAlt: false }],
		// Since NRL-120 the `===` is spoken with the rest: two content lines above it
		// is not a setext heading in Obsidian, so it is not dropped as an underline.
		// Still the root 2d destination leak, unchanged in kind.
		["guard-nrl98-residual-setext-two-lines", "A ![alt\nmore\n===\nwords](zdestz.png) B", "A [alt more === words](zdestz.png) B", { speakImageAlt: false }],
		// NRL-93. `opensObsidianBlock`'s line-start half is no longer `.trim() === ""`.
		// It is "at most three SPACES", and the predicate takes a third argument saying
		// whether a list item has already DEDENTED this line. Read the whole comment
		// before touching any expectation below: eight of these moved on purpose, six
		// are tripwires on divergences this fix does NOT close, and the rest are guards
		// on shapes it must not move.
		//
		// Everything cited here was read verbatim out of the installed obsidian.asar's
		// app.js, sha256
		// 8efbf581e259cabef4f9c9a34814cfe3c02863757377e56b3603933c50e89898
		// (3,876,459 bytes), and transcribed and RUN rather than reasoned about.
		// NOTHING was observed in a running Obsidian.
		//
		// THE RULE, in three terms. (1) The `%%` BLOCK tokenizer skips charCode 32 and
		// nothing else: `for(var i=t.length,r=0;r<i&&32===t.charCodeAt(r);)r++;` then
		// `if(37===t.charCodeAt(r)&&37===t.charCodeAt(r+1))`. (2) It never sees a line
		// indented four or more columns, because module 8607's paragraph tokenizer
		// skips the whole `interruptParagraph` check for such a continuation line -
		// `if((h=t.charAt(c))===o){p=l;break}` then
		// `if(p>=l&&h!==a){y=t.indexOf(a,y+1);continue}` with o = "\t", s = " ",
		// a = "\n", l = 4 - so the line is absorbed as lazy prose and its `%%` falls to
		// module 4839's ANCHORED `/^%%(.*?)%%/`, which finds no closer and is
		// DISPLAYED. (3) But a list item's content is dedented first: module 745's `M`
		// calls module 5540's remove-indentation with the item's own content indent and
		// module 6058 counts a tab as four columns, so `- item` / `<TAB>%%` / `SECRET`
		// reaches the tokenizer as `item` / `%%` / `SECRET` and the block really does
		// open there.
		//
		// THE EIGHT BELOW MOVED, and each now matches what the renderer displays. They
		// used to be pinned at the silenced value with a "must change on purpose" note;
		// this is that change, and they were replaced in place rather than added beside
		// the old ones (the NRL-66 / NRL-67 convention).
		["pin-nrl93-tab-opener-continuation", "Para line.\n	%%\nSECRET\nVISIBLE", "Para line. %% SECRET VISIBLE"],
		// `BLOCKQUOTE` peels `>` plus at most one whitespace character and module 6234
		// consumes `>` plus at most one SPACE, so a `> <TAB>%%` line keeps its tab in
		// the body in both trees and is refused by the skip loop in both.
		["pin-nrl93-tab-opener-in-quote", "> Plain prose\n> 	%%\n> SECRET\n> VISIBLE", "Plain prose %% SECRET VISIBLE"],
		["pin-nrl93-tab-opener-nested-quote", ">> Plain prose\n>> 	%%\n>> SECRET\n>> VISIBLE", "Plain prose %% SECRET VISIBLE"],
		// Any non-space whitespace in the leading run stops the skip loop, in either
		// order, and both leads are at least four columns once module 6058 snaps the
		// tab to the next multiple of four.
		["pin-nrl93-space-tab", "Para line.\n 	%%\nSECRET\nVISIBLE", "Para line. %% SECRET VISIBLE"],
		["pin-nrl93-tab-space", "Para line.\n	 %%\nSECRET\nVISIBLE", "Para line. %% SECRET VISIBLE"],
		// A soft-wrapped code span whose interior holds only TAB-LED `%%` lines.
		// Exactly pin-nrl73-span-of-only-disqualified-openers' shape and for the same
		// reason: the tab-led line is no longer an opener, so `interruptsParagraph`
		// stops stopping `codeSpanClosesLater`, the span is confirmed, and the two
		// toggle positions stop agreeing with each other. Every line in it is
		// displayed by Obsidian, as code, so neither position is a leak.
		["pin-nrl93-tab-span-of-tab-openers", "Before `a\n	%%\nSPANPROSE\n	%% w\nb` after.", "Before after."],
		["pin-nrl93-tab-span-of-tab-openers-spoken", "Before `a\n	%%\nSPANPROSE\n	%% w\nb` after.", "Before a %% SPANPROSE %% w b after.", { skipInlineCode: false }],
		// The FOUR-SPACE divergence, found alongside the tab one and in the same
		// prose-loss direction. Term 2 above is the whole of it: Obsidian absorbs this
		// line into the paragraph and displays `%%` and SECRET. It is a different
		// character class and the same mechanism, which is why one cap closes both.
		["pin-nrl93-four-space-opener", "Para line.\n    %%\nSECRET", "Para line. %% SECRET"],
		// WHAT IS ALREADY RIGHT, pinned so the fix cannot have broken it. A FRESH-BLOCK
		// tab-led or four-space line never reaches the opener test at all, and that
		// matches the renderer: `blockMethods` is [frontmatter, blankLine,
		// indentedCode, ..., comment, fencedCode, ...] because `FE` splices before its
		// anchor (`a.splice(a.indexOf(n),0,t)`) and `indentedCode` already precedes
		// `fencedCode`, and module 134 opens indented code on ONE tab
		// (`else if(l===o)` with o = "\t"). So it is code there too, never a comment.
		["guard-nrl93-fresh-block-tab-is-indented-code", "	%%\nSECRET_TAB\nVISIBLE", "SECRET_TAB VISIBLE"],
		["guard-nrl93-fresh-block-4sp-is-indented-code", "    %% secret\nVISIBLE AFTER 4SP", "VISIBLE AFTER 4SP"],
		["guard-nrl93-fresh-block-tab-code-spoken", "	%%\nSECRET_TAB\nVISIBLE", "%% SECRET_TAB VISIBLE", { skipCodeBlocks: false }],
		// A `%%` on a list MARKER line. THREE OF THESE FOUR MOVED WITH NRL-116, and the
		// three that moved are REPLACED IN PLACE keeping their NRL-93 names so every
		// citation of them in `srs.md`, `docs/adr/0006` and `AGENTS.md` still resolves
		// (the NRL-66 / NRL-67 convention). THE NAMES NOW READ BACKWARDS - nothing is
		// "still silenced" in the first three - and that wart is deliberate and
		// preferred to a rename that would orphan those citations.
		//
		// What NRL-93 recorded, and which still stands as the DIAGNOSIS: module 745's
		// third group, /^([ \t]*)([*+-]|\d+[.)])( {1,4}(?! )| |\t|$|(?=\n))([^\n]*)/,
		// takes at most four spaces not followed by a fifth, or one space, or one tab,
		// and leaves the rest as the item's CONTENT INDENT - so `- ` + tab + `%%` is
		// indented CODE inside the item and the next item is DISPLAYED, while our
		// `LIST_BULLET` ended in `\s+` and ate both. (NRL-93's own comment said group 3
		// "takes the SINGLE SPACE"; that wording is the outlier and `srs.md`'s "at most
		// four spaces or one tab" is right. Corrected by NRL-116, Q10, re-read out of
		// the same `app.js`.) `containerPrefix` now peels the marker and that lead
		// SEPARATELY, so the tab stays in the body where `opensObsidianBlock`'s
		// charCode-32-only rule correctly refuses it.
		//
		// The `%%` ITSELF is still spoken, which the renderer shows as code rather than
		// as prose. Our extractor does not model an item's content indent as indented
		// code, so `skipCodeBlocks` cannot reach it; that is NRL-117's row, named here
		// so the expectation is not read as a claim that we classify it correctly.
		["pin-nrl93-tab-after-bullet-marker-still-silenced", "- Plain prose\n- 	%%\n- SECRET", "Plain prose %% SECRET"],
		["pin-nrl93-tab-after-ordered-marker-still-silenced", "1. Plain prose\n1. 	%%\n1. SECRET", "Plain prose %% SECRET"],
		["pin-nrl93-tab-after-task-marker-still-silenced", "- [ ] Plain prose\n- [ ] 	%%\n- [ ] SECRET", "Plain prose %% SECRET"],
		// THE FOURTH DID NOT MOVE, deliberately (NRL-116 Q12). A BARE `- %%` really does
		// reduce to `%%` at the item's block start, so the opener is correctly
		// recognised; what diverges is the SCOPE, module 745 tokenizing each item's
		// value on its own where our block state is note-scoped and container-blind.
		// That root is NRL-118, not this one, and NRL-116's peel deliberately omits
		// group 3's `$` and `(?=\n)` alternatives so the bare form behaves exactly as
		// it did. NRL-118 MOVED IT ON PURPOSE, in place: the renderer ends a `%%`
		// comment at the end of the item that holds it, so the next item's SECRET is
		// DISPLAYED and is now spoken. Was "Plain prose".
		["pin-nrl93-bare-marker-opener-still-silenced", "- Plain prose\n- %%\n- SECRET", "Plain prose SECRET"],
		// A tab, or any other indent, used as a list item's CONTINUATION indentation.
		// Term 3 is the whole reason the predicate takes a third argument: the renderer
		// dedents these away and opens a comment, so hiding SECRET is CORRECT and a
		// bare character-class narrowing broke every one of them. Nothing in the suite
		// caught that before these existed.
		["guard-nrl93-tab-list-continuation-correctly-hides", "- item\n	%%\nSECRET", "item"],
		["guard-nrl93-tab-list-continuation-after-blank-correctly-hides", "- item\n\n	%%\nSECRET", "item"],
		["guard-nrl93-four-space-list-continuation-correctly-hides", "- item\n    %%\nSECRET", "item"],
		["guard-nrl93-five-space-list-continuation-correctly-hides", "- item\n     %%\nSECRET", "item"],
		["guard-nrl93-nested-list-continuation-correctly-hides", "- a\n  - b\n	%%\nSECRET", "a b"],
		["guard-nrl93-ordered-list-continuation-correctly-hides", "1. item\n	%%\nSECRET", "item"],
		["guard-nrl93-task-list-continuation-correctly-hides", "- [ ] item\n	%%\nSECRET", "item"],
		// The `listDedented` pass tracks its run on the QUOTE-PEELED view, and this is
		// the shape that makes that load-bearing rather than tidy: `containerPrefix`
		// calls `> - item` a quote, not a list, so without the peel this line would
		// lose its dedent and newly speak SECRET. Module 745 runs inside the quote's
		// stripped content and dedents exactly as it does at the top level.
		["guard-nrl93-quoted-list-continuation-correctly-hides", "> - item\n> 	%%\n> SECRET", "item"],
		// The run has to END, or nothing after the first list in a note would ever be
		// fixed. Both of these DID move, and the ender is the same condition the
		// per-line loop already uses for `inList`.
		["pin-nrl93-after-list-ends-at-blank", "- item\n\npara\n\nother\n	%%\nSECRET", "item para other %% SECRET"],
		["pin-nrl93-after-list-ends-at-heading", "- item\n\n# Head\nPara.\n	%%\nSECRET", "item Head Para. %% SECRET"],
		// A SPACE-led opener, one to three of them, which the skip loop accepts and the
		// cap keeps. Nothing pinned a genuine space-indented opener before this ticket
		// - pin-nrl73-indented-opener-with-percent is a space-indented DISQUALIFIED
		// one.
		["guard-nrl93-one-space-opener", "Para line.\n %%\nSECRET\nVISIBLE", "Para line."],
		["guard-nrl93-three-space-opener", "Para line.\n   %%\nSECRET", "Para line."],
		["guard-nrl93-space-opener-in-quote", "> Plain\n>  %%\n> SECRET", "Plain"],
		// SIX MORE TRIPWIRES on divergences this fix does NOT close, each measured as
		// IDENTICAL on both sides of it and each in the prose-loss direction, never
		// disclosure. They must change on purpose if any of the three roots is ever
		// picked up.
		//
		// 1. CLOSED BY NRL-117 for the deep-indent half, and the first two are
		// REPLACED IN PLACE keeping their names, which now read BACKWARDS - they say
		// "still-silenced" and assert the opposite. The NRL-66/NRL-67 convention keeps
		// the name so every citation of it still resolves; read the expectation, not
		// the name. NRL-93's own wording is kept below as the history that explains
		// what moved: `listDedented` was a BOOLEAN, so a list item's content kept the
		// old any-whitespace rule rather than having the item's dedent applied. `- item`
		// dedents by two columns, so eight spaces leaves six and two tabs leave one -
		// both four or more columns, both absorbed as lazy prose by the renderer, both
		// hidden here until NRL-117 built the indent-amount stack. The third stays
		// EXACTLY as it was: a blockquote nested inside a list item needs NRL-114's
		// quote-peel narrowing, because `BLOCKQUOTE` eats the tab before any dedent
		// model can see it, and NRL-117 scoped it out rather than duplicating blocked
		// work (Q42). 4 cells of that class closed anyway, as the 8sp twin below shows,
		// and 8 stay divergent.
		// The third is now ALSO replaced in place: CLOSED BY NRL-114's fix round 1,
		// which makes the `listDedented` pass give a line quoted deeper than its
		// item's marker line the spaces-only rule, since the renderer dedents the
		// item first and then peels the quote, leaving `\t%%` in a quote body
		// (`<ul><li>item<blockquote><p>Plain<br>%%<br>SECRET</p></blockquote></li></ul>`,
		// executed renderer). RED on base and on the PR head f0c52a2.
		["pin-nrl93-deep-indent-in-list-still-silenced", "- item\n        %%\nSECRET", "item %% SECRET"],
		["pin-nrl93-double-tab-in-list-still-silenced", "- item\n		%%\nSECRET", "item %% SECRET"],
		["pin-nrl93-quote-inside-list-still-silenced", "- item\n  > Plain\n  > 	%%\n  > SECRET", "item Plain %% SECRET"],
		// 2. CLOSED BY NRL-114, and these two are the SAME SHAPES with the
		// expectation flipped on purpose (the NRL-66 / NRL-67 replace-in-place
		// convention), so the names still resolve from every citation. The sentence
		// this comment used to carry - "no `%%` predicate can see the difference. Not
		// opened by this fix. Two cells of the census" - is falsified in both halves.
		// The divergence was never in a `%%` predicate at all: it was the blockquote
		// PREFIX PEEL, whose `\s?` ate the tab before any predicate ran, so narrowing
		// the peel is what fixes it and `opensObsidianBlock` is byte-identical across
		// NRL-114's diff. And it is far more than two cells: `\s` is the JS class, so
		// the same divergence covers a tab, a tab-then-space, an NBSP, a vertical tab
		// and an ideographic space, at every quote depth, inside a callout body, inside
		// a list item and under a three-space indent. Measured with Obsidian 1.13.7's
		// own parser run in Node: the renderer DISPLAYS the hidden text in every one of
		// them, because module 6234 advances over at most one character after the `>`
		// and that character must be a SPACE, so the tab survives into the quote body
		// and a tab-led line is never a `%%` opener there.
		["pin-nrl93-quote-tab-eaten-by-prefix-still-silenced", "> Plain prose\n>	%%\n> SECRET", "Plain prose %% SECRET"],
		["pin-nrl93-quote-tab-space-eaten-by-prefix-still-silenced", "> Plain prose\n>	 %%\n> SECRET", "Plain prose %% SECRET"],
		// NRL-114's own rows. FIVE further contexts in the identical character
		// position, each found by asking the real parser rather than by reading the
		// ticket, each displayed by the renderer and silenced on base.
		["pin-nrl114-nested-quote-tab-now-spoken", ">> Plain prose\n>>	%%\n>> SECRET", "Plain prose %% SECRET"],
		["pin-nrl114-indented-quote-tab-now-spoken", "   > Plain prose\n   >	%%\n   > SECRET", "Plain prose %% SECRET"],
		["pin-nrl114-callout-body-tab-now-spoken", "> [!note] Title\n>	%%\n> SECRET", "Title %% SECRET"],
		["pin-nrl114-quote-in-list-tab-now-spoken", "- > Plain prose\n- >	%%\n- > SECRET", "Plain prose %% SECRET"],
		// The three non-space, non-tab members of `\s` that the narrowing also moves.
		// They are pinned individually because "a tab" is how the ticket described the
		// divergence and it is the narrowest possible reading of it.
		["pin-nrl114-nbsp-after-marker-now-spoken", "> Plain prose\n>\u00a0%%\n> SECRET", "Plain prose %% SECRET"],
		["pin-nrl114-vtab-after-marker-now-spoken", "> Plain prose\n>\v%%\n> SECRET", "Plain prose %% SECRET"],
		["pin-nrl114-ideographic-space-after-marker-now-spoken", "> Plain prose\n>\u3000%%\n> SECRET", "Plain prose %% SECRET"],
		// THE CONTROLS. One space is the renderer's own allowance and two spaces leave
		// a one-space body, so both really are `%%` openers there; the renderer HIDES
		// the text in both and so must we. These are what stop the narrowing being
		// widened into "peel no whitespace at all".
		["guard-nrl114-one-space-still-hides", "> Plain prose\n> %%\n> SECRET", "Plain prose"],
		["guard-nrl114-two-spaces-still-hide", "> Plain prose\n>  %%\n> SECRET", "Plain prose"],
		// THE BUDGET INVARIANT, behaviourally. 7cdc7b7 recorded this shape as the one
		// that told the CONSISTENT narrowing apart from the half-fix that narrows the
		// counter and leaves the all-levels gate wide. RE-MEASURED on 9132c3b by
		// NRL-114's continuation, that is no longer true of THIS row: the half-fix arm
		// (gate `^(?:\s{0,3}>\s?)+`, counter narrow) speaks it correctly, so it is kept
		// as a GUARD only. The half-fix is still caught behaviourally, and more widely:
		// on that arm NINE fixtures in this table go red (both pin-nrl93-quote-tab-*,
		// pin-nrl114-nested-quote-tab-now-spoken, -indented-quote-tab-, -nbsp-, -vtab-,
		// -ideographic-space-, pin-nrl114-quoted-tab-hr-is-not-a-stop and
		// pin-nrl114-quoted-setext-keeps-inline-comment-hidden) plus checks (a) and (d)
		// of the NRL-114 section, and over the 3,150-shape x 512-mask census
		// reconstruction it newly loses 98,304 and newly discloses 27,136 of 5,160,960
		// sentinel-cells against the fix.
		["pin-nrl114-nested-tab-space-budget-invariant", ">>	 Plain prose\n>>	%%\n>>	 SECRET", "Plain prose %% SECRET"],
		// THREE RESIDUALS IN THE SAME CHARACTER POSITION that NRL-114 does NOT close,
		// each measured IDENTICAL on base and on the fix and each pinned as a TRIPWIRE
		// rather than as evidence of anything. The renderer displays the hidden text in
		// all three. They are not folded in because each needs a DIFFERENT predicate,
		// and folding any of them would make the diff unattributable.
		//
		// (a) a tab BETWEEN levels. The narrowing cannot reach it: the next level's own
		// `\s{0,3}` re-absorbs the tab, so the peel is byte-identical on both arms.
		// That is the indent BEFORE a `>`, which is a recorded NRL-98 decision
		// (`BLOCKQUOTE`'s `\s{0,3}` cap against `ANY_QUOTE_MARKER`'s unbounded skip)
		// rather than an open defect.
		["pin-nrl114-tab-between-levels-still-silenced", "> Plain prose\n>	> %%\n> SECRET", "Plain prose"],
		// (b) RENAMED from pin-nrl114-quote-tab-html-comment-still-silenced, because its
		// meaning inverted and the old name was never on `main`. When 7cdc7b7 was
		// written this shape stayed silenced: the tab-led line is a lazy continuation
		// of `Plain prose` for the renderer, and `opensHtmlBlock` opened on it. NRL-115
		// (9cca242) has since made base speak it, and 7cdc7b7 alone speaks it too, so
		// the old expectation was stale on every arm. Renderer: `<blockquote><p>Plain
		// prose<br>&#x3C;!--<br>SECRET</p></blockquote>`. A GUARD: green on base, on
		// 7cdc7b7 alone and on the fix. Not counted as evidence.
		["guard-nrl114-quote-tab-html-comment-spoken", "> Plain prose\n>	<!--\n> SECRET", "Plain prose <!-- SECRET"],
		// (c) `opensObsidianBlock`'s `dedentedByList` term C kept the any-whitespace
		// rule, so the peel was irrelevant here. Same root as
		// pin-nrl93-quote-inside-list-still-silenced, and CLOSED with it by NRL-114's
		// fix round 1, replaced in place keeping the name (which now reads
		// backwards): a quote nested in the item is not dedented by it. RED on base
		// and on the PR head f0c52a2.
		["pin-nrl114-quote-tab-in-list-item-still-silenced", "- item\n  > Plain\n  >	%%\n  > SECRET", "item Plain %% SECRET"],
		// A LONE CR after the marker is still consumed, and that is one measured
		// character rather than an oversight. The renderer breaks the line AT the CR
		// (measured: this note renders as `<blockquote><p>Plain prose</p></blockquote>`
		// with SECRET hidden), so the `%%` after it is at a line start for the renderer
		// and consuming the CR puts it at offset 0 of our body, which is the same
		// place. Peeling a space ONLY makes this line a non-opener for us: re-measured
		// on 9132c3b, that arm newly SPEAKS author-hidden text in 32,256 (and newly
		// loses 6,144) of the 3,150-shape x 512-mask census reconstruction's 5,160,960
		// sentinel-cells against the fix - the disclosure direction, which is the one
		// this change must not move. (7cdc7b7 recorded 17,920 of 1,612,800 CELLS on its
		// older base, a different unit; replaced, not averaged.) A real CRLF file never
		// reaches this: its CR sits at the END of the line.
		["guard-nrl114-lone-cr-after-marker-still-hides", "> Plain prose\n>\r%%\n> SECRET", "Plain prose"],
		// RENAMED from pin-nrl114-setext-cost-quote-tab-html-opener, because the cost it
		// pinned no longer exists and the old name was never on `main`. On 7cdc7b7's own
		// older base, `opensHtmlBlock` opened on this tab-led quote body (which the
		// renderer makes INDENTED CODE: `indentedCode` is blockMethods index 2, `html`
		// index 11) and hid `=== SECRET`. On 9132c3b, NRL-115 had already stopped that,
		// so 7cdc7b7 alone speaks it; NRL-114's `htmlLeadCode` mask now also declines
		// term 2 on such a line, which is what keeps the shape-A family below spoken.
		// Renderer: `<p>PROSE0.</p><blockquote><pre><code>&#x3C;!--</code></pre>
		// <p>===<br>SECRET</p></blockquote>`. The `<!--` is still SPOKEN under
		// skipCodeBlocks, because the declined line is read as prose rather than as
		// code - base parity (base speaks the identical string) and a known miss, not a
		// disclosure. A GUARD, green on base, on 7cdc7b7 alone and on the fix.
		["guard-nrl114-setext-quote-tab-html-opener-spoken", "PROSE0.\n\n>\t<!--\n> ===\n> SECRET", "PROSE0. <!-- === SECRET"],
		["guard-nrl114-setext-space-html-opener-unmoved", "PROSE0.\n\n> <!--\n> ===\n> SECRET", "PROSE0. <!-- === SECRET"],
		// NRL-114's CONTINUATION (run 20261002-190146). 7cdc7b7's narrowed peel cannot
		// land alone: on 9132c3b it newly lost displayed text in two shapes, because
		// two predicates downstream of the peel had only ever been fed the wide peel's
		// output. Every expectation below is the visible text of Obsidian 1.13.7's own
		// rendered HTML (parser and renderer executed in Node, app.js 8efbf581), never
		// a reading. "RED on base" is against 9132c3b; "RED on 7cdc7b7" is against
		// 9132c3b plus 7cdc7b7's src alone.
		//
		// SHAPE A: a quote's fresh-block body that module 134 makes INDENTED CODE.
		// Once the peel leaves the tab, the body `\t<!--` is code for the renderer, but
		// `opensHtmlBlock`'s term 2 (a later `-->`) still opened on it. Fixed by
		// masking term 2 ONCE, at the array level (`htmlLeadCode`), so every reader of
		// that array agrees. skipCodeBlocks is off so the code line's own words count.
		// Lead tab: RED on 7cdc7b7 only (base's wide peel spoke it by accident).
		["pin-nrl114-quote-code-body-tab-html-opener", ">\t<!-- ZCZ\n> ===\n> ZAZ -->\nTAIL ZBZ", "<!-- ZCZ === ZAZ --> TAIL ZBZ", { skipCodeBlocks: false }],
		// Leads space-tab and five spaces: RED on base AND on 7cdc7b7.
		["pin-nrl114-quote-code-body-space-tab-html-opener", "> \t<!-- ZCZ\n> ===\n> ZAZ -->\nTAIL ZBZ", "<!-- ZCZ === ZAZ --> TAIL ZBZ", { skipCodeBlocks: false }],
		["pin-nrl114-quote-code-body-five-space-html-opener", ">     <!-- ZCZ\n> ===\n> ZAZ -->\nTAIL ZBZ", "<!-- ZCZ === ZAZ --> TAIL ZBZ", { skipCodeBlocks: false }],
		// Lead two-spaces-tab: the body ` \t<!--` is NOT code (module 134 is literal:
		// four spaces or one tab at offset 0), so the renderer makes it SETEXT content,
		// `<h1>&#x3C;!-- ZCZ</h1>`. RED on base and on 7cdc7b7. KNOWN MISS, pinned: we
		// speak the `===` underline, which the renderer does not display. That is a
		// markup glyph, not hidden text; the heading text and every displayed word
		// are spoken.
		["pin-nrl114-quote-setext-two-space-tab-html-opener", ">  \t<!-- ZCZ\n> ===\n> ZAZ -->\nTAIL ZBZ", "<!-- ZCZ === ZAZ --> TAIL ZBZ", { skipCodeBlocks: false }],
		//
		// SHAPE B: a lazy tab-led continuation in a quote, then a QUOTED paragraph end.
		// The term-2 bound (`htmlCloserAhead`) read the RAW line, so `> ---` never ended
		// the opener's paragraph. NRL-114 wraps, and does not edit, `endsTerm2Scan` /
		// `endsTerm2Block`: `term2QuotedStop` hands them the line with its quote levels
		// peeled (spaces only). `---` and `-`: RED on 7cdc7b7 only.
		["pin-nrl114-quoted-hr-ends-term2-paragraph", "> Plain ZPZ prose\n>\t<!-- ZCZ\n> ---\n> ZAZ -->\nTAIL ZBZ", "Plain ZPZ prose <!-- ZCZ ZAZ --> TAIL ZBZ"],
		// The `-` glyph is spoken: an empty list item spoken as its marker is NRL-154's
		// pre-existing class (base speaks the identical string).
		["pin-nrl114-quoted-bare-bullet-ends-term2-paragraph", "> Plain ZPZ prose\n>\t<!-- ZCZ\n> -\n> ZAZ -->\nTAIL ZBZ", "Plain ZPZ prose <!-- ZCZ - ZAZ --> TAIL ZBZ"],
		// `***` and a bare `>`: RED on base AND on 7cdc7b7.
		["pin-nrl114-quoted-star-hr-ends-term2-paragraph", "> Plain ZPZ prose\n>\t<!-- ZCZ\n> ***\n> ZAZ -->\nTAIL ZBZ", "Plain ZPZ prose <!-- ZCZ ZAZ --> TAIL ZBZ"],
		["pin-nrl114-quoted-blank-ends-term2-paragraph", "> Plain ZPZ prose\n>\t<!-- ZCZ\n>\n> ZAZ -->\nTAIL ZBZ", "Plain ZPZ prose <!-- ZCZ ZAZ --> TAIL ZBZ"],
		// A tab-led whitespace member is NOT a stop (decisions Q4 and Q10): `>\t---` and
		// `>\t` keep the paragraph open for the renderer, which HIDES ZCZ..ZAZ as one
		// inline comment. The `---` row is RED on base (base spoke the hidden text) and
		// green on 7cdc7b7; the bare-tab row is green everywhere and is a GUARD that
		// stops the stop set being widened into the disclosure direction.
		["pin-nrl114-quoted-tab-hr-is-not-a-stop", "> Plain ZPZ prose\n> <!-- ZCZ\n>\t---\n> ZAZ -->\nTAIL ZBZ", "Plain ZPZ prose TAIL ZBZ"],
		["guard-nrl114-quoted-tab-blank-is-not-a-stop", "> Plain ZPZ prose\n> <!-- ZCZ\n>\t\n> ZAZ -->\nTAIL ZBZ", "Plain ZPZ prose TAIL ZBZ"],
		// MUST STAY: with `> ===` the renderer keeps ONE paragraph holding an inline
		// comment `<!-- ZCZ === ZAZ -->`, so ZCZ and ZAZ are hidden. Base SPOKE them
		// (a disclosure); 7cdc7b7 closed it and the continuation keeps it closed.
		// RED on base, green on 7cdc7b7.
		["pin-nrl114-quoted-setext-keeps-inline-comment-hidden", "> Plain ZPZ prose\n>\t<!-- ZCZ\n> ===\n> ZAZ -->\nTAIL ZBZ", "Plain ZPZ prose TAIL ZBZ"],
		// A shallower quote line is a LAZY continuation for the renderer, so it is not
		// a stop and the inline comment stays hidden. GUARD, green on every arm.
		["guard-nrl114-shallower-quote-is-lazy-not-a-stop", ">> Plain ZPZ prose <!-- ZCZ\n> ZAZ -->\nTAIL ZBZ", "Plain ZPZ prose TAIL ZBZ"],
		// TRIPWIRE, identical on every arm: a DEEPER quote line starts a nested quote
		// and ends the paragraph for the renderer, which displays ZCZ and ZAZ. The plan's
		// depth-rise stop (decision Q3) was built and REMOVED, because the fuzz showed
		// it newly disclosing hidden text where remark keeps more lines in one
		// paragraph than a bare depth test predicts. Fail-closed prose loss, base parity.
		["pin-nrl114-deeper-quote-still-hides-term2", "> Plain ZPZ prose <!-- ZCZ\n>> ZAZ -->\nTAIL ZBZ", "Plain ZPZ prose TAIL ZBZ"],
		// TWO UNMASKINGS found by /critique at ship, each ADJUDICATED ON A BASE CONTROL
		// (decision Q11) rather than waved through. Both are newly lost against base and
		// both are fail-closed: base spoke ZCZ and ZAZ only because its wide peel ate the
		// tab after `>`, which this ticket corrects.
		// (i) A TABLE-SHAPED line right above. `unsureFresh` keeps base's RAW term-2
		// answer there (see `htmlClosesLaterAt`), and the raw pass never sees `> ---` as
		// a paragraph end, so the `-->` below it still closes the block: the NRL-95
		// container residual, unmasked. The renderer displays ZCZ and ZAZ. TRIPWIRE: RED
		// on base, which spoke them. Its control, the ` \t` twin, is a GUARD that base
		// already loses the same way, byte-identically.
		["pin-nrl114-table-line-then-quoted-hr-still-hides-term2", "> | a |\n>\t<!-- ZCZ\n> ---\n> ZAZ -->\nZBZ", "| a | ZBZ"],
		["guard-nrl114-table-line-space-tab-control", "> | a |\n> \t<!-- ZCZ\n> ---\n> ZAZ -->\nZBZ", "| a | ZBZ"],
		// (ii) A FOOTNOTE definition right above, in a quote (no reference here). The
		// renderer puts `<!-- ZCZ` inside the footnote as an html node (hidden) and
		// displays ZAZ; we drop the `<!--` block and lose ZAZ. Base spoke both, a
		// disclosure of ZCZ. Control: the unquoted twin, which base already reads the
		// same way. Footnote fidelity is NRL-163's.
		["pin-nrl114-quoted-footnote-then-quoted-hr-unmasked", "> [^1]: foot ZFZ\n>\t<!-- ZCZ\n> ---\n> ZAZ -->\nZBZ", "foot ZFZ ZBZ"],
		["guard-nrl114-unquoted-footnote-control", "[^1]: foot ZFZ\n\t<!-- ZCZ\n---\nZAZ -->\nZBZ", "foot ZFZ ZBZ"],
		// NRL-114 FIX ROUND 1. An independent Verify pass FAILED PR #212 for a
		// DISCLOSURE with no base control, and these rows are its shapes and their
		// siblings. Every expectation is the executed renderer's (Obsidian 1.13.7's
		// reading-view parser and HTML renderer run in Node), and every "pin" row is
		// RED against the PR head f0c52a2.
		//
		// F1. The term-2 pass's callout-title stop fired on a `[!type]` line it read
		// as a quote START because the line above was a stop and shallower. But a
		// quote behind a list marker (`- >`, `1. >`) was invisible to
		// `term2QuoteView`, so the list line looked depth 0 and the `> [!tip]` line
		// looked like a new quote, where the renderer continues the list item's
		// quote paragraph lazily and its inline comment hides the title. The depth
		// read for "the line above" now comes from `containerPrefix`. RED on the PR
		// head, which spoke QAQ, QBQ and QCQ; green on base.
		["pin-nrl114-f1-list-quote-then-callout-is-lazy", "- > Plain ZPZ <!-- QAQ\n> [!tip] QBQ\n> QCQ -->\nTAIL QDQ", "Plain ZPZ TAIL QDQ"],
		["pin-nrl114-f1-ordered-list-quote-then-tab-callout", "1. > text <!-- QAQ\n> [!note]\ttext -->", "text"],
		["pin-nrl114-f1-quoted-list-quote-then-deeper-callout", "> - > x <!-- QAQ\n>> [!tip] QBQ\n> QCQ -->", "x"],
		// The other direction, so the fix is not "never stop at a callout": after a
		// PLAIN list item the renderer really does start a callout, which ends the
		// item's paragraph, so the `<!--` is displayed. GUARD, green on the PR head
		// (red on base, which hid it).
		["guard-nrl114-f1-plain-item-then-callout-starts", "- x <!-- QAQ\n> [!tip] QBQ\n> QCQ -->\nTAIL", "x <!-- QAQ QBQ QCQ --> TAIL"],
		// A tab-led `%%` in a quote nested in a list item. The renderer dedents the
		// item FIRST and peels the quote second, so the `%%` sits in a quote body,
		// where it needs a spaces-only lead; the `listDedented` pass applied the
		// item's any-whitespace rule to it and opened a block. Now a line quoted
		// deeper than its item's marker line takes the spaces-only rule. RED on the
		// PR head (`text <!-- QAQ === %%`), which lost QEQ; base lost the `<!--`.
		["pin-nrl114-f1-item-then-callout-tab-led-pct-in-quote", "1.  text <!--  QAQ\n> [!note] === %%\n   >  \t%%  -->\n>   QEQ", "text <!-- QAQ === %% %% --> QEQ"],
		// F2. A FENCE line as a callout's title, or as the first content of a list
		// item opened at column 0: never displayed, and spoken as prose because the
		// top-level `FENCE` branch reads the raw line. RED on the PR head.
		["pin-nrl114-f2-callout-title-fence-not-spoken", "-     <!--\n> [!note]\t~~~   QFQ -->", "<!--", { skipCodeBlocks: false }],
		["pin-nrl114-f2-list-quote-fence-not-spoken", "> [!note] \t%% QBQ\n1. >    ~~~ QDQ", "%% QBQ", { skipCodeBlocks: false }],
		["pin-nrl114-f2-list-item-fence-not-spoken", "- ~~~ QFQ\n- after", "after"],
		// Where the renderer DISPLAYS a fence-shaped line, which is why the drop is
		// that narrow. GUARDS, green on every arm: a `[!type]` line that is not a
		// quote's first line is paragraph text; a list line inside a quoted fence or
		// a nested item's fence is code content; a raw HTML block swallows the line.
		["guard-nrl114-f2-callout-marker-on-a-later-line-is-text", "> x\n> [!note] ~~~ QBQ", "x ~~~ QBQ"],
		["guard-nrl114-f2-callout-title-after-a-title-is-text", "> [!note] Title\n> [!tip] ~~~ QBQ", "Title ~~~ QBQ"],
		["guard-nrl114-f2-item-inside-a-quoted-fence-is-content", "> ```\n> - ~~~ QBQ\n> ```", "~~~ QBQ"],
		["guard-nrl114-f2-nested-item-inside-a-fence-is-content", "- ```\n  - ~~~ QBQ\n  ```", "~~~ QBQ", { skipCodeBlocks: false }],
		["guard-nrl114-f2-item-inside-an-html-block-is-raw", "<div>\n- ~~~ QBQ", "~~~ QBQ"],
		// TRIPWIRE, base parity: a quoted fence at a quote START is still spoken. Not
		// dropped because a fence-shaped line inside a quote can be the content of a
		// quoted fence opened above it, and this round keeps no fence state.
		["pin-nrl114-f2-quote-start-fence-still-spoken", "Para.\n> ~~~ QBQ", "Para. ~~~ QBQ"],
		// A tab-led `%%` continuing an indented code block in a quote nested in a
		// list item: the same quote-in-item rule. RED on the PR head, which lost QCQ.
		["pin-nrl114-f2-code-line-pct-in-list-quote", "    -  QAQ\n> \t%% QBQ\n- >\t|---|---|\n  > \t%% QCQ", "- QAQ %% QBQ |---|---| %% QCQ", { skipCodeBlocks: false }],
		// `-    ---` is a THEMATIC BREAK, not a list item (`thematicBreak` precedes
		// `list`), so the next line is not item content. RED on the PR head and on
		// base, which both opened a block on the tab-led `%%`.
		["pin-nrl114-f2-hr-shaped-marker-is-not-an-item", "x\n\n> -    ---\n>   \t%%  -->", "x %% -->"],
		["pin-nrl114-f2-hr-shaped-marker-after-opener", " -|---|---| <!--\n> -    ---\n>   \t%%     --> QFQ", "-|---|---| <!-- %% --> QFQ"],
		// The quote-in-item rule must not reach a quote AROUND the list, or a lone CR
		// the renderer splits the line at. GUARDS, green on every arm.
		["guard-nrl114-f2-quote-around-list-still-dedents", "> - item\n> \t%%\n> SECRET", "item"],
		["guard-nrl114-f2-lone-cr-keeps-the-dedent-answer", "1. > x\n>  \r%% QEQ", "x"],
		// Two UNMASKINGS, adjudicated on a base control (decision Q11): the fix's
		// output on the pin is byte-identical to base's output on the control, and
		// the control renders the SAME visible text. Each pin is RED on base and
		// green on the PR head; each control is green on base.
		// (i) NRL-136: `<!-- -->  <!--` on one line is raw HTML for the renderer, and
		// its trailing `<!--` hides the rest of the note in the DOM. Base hid QEQ
		// only through the wrong item dedent above. Control: the list marker removed.
		//
		// NRL-166 port (2026-10-08): both rows are REPLACED IN PLACE, names kept.
		// NRL-136 (#196, merged after this round was written) hides the rest of a
		// note after a raw-HTML line that reopens `<!--`, which is the renderer's
		// answer for both (`<blockquote>\t<!--  -->  <!--<pre><code>%% QEQ` - the
		// trailing `<!--` swallows the rest of the DOM), so the pin and its control
		// now speak nothing on main e2afbfe and on this fix alike. RED on 9132c3b
		// (`<!--`) and on 9c22016 (`<!-- %% QEQ`).
		["pin-nrl114-f2-nrl136-same-line-reopen-unmasked", "1. >  \t<!--  -->  <!--\n> \t%% QEQ", ""],
		["guard-nrl114-f2-nrl136-control", ">  \t<!--  -->  <!--\n> \t%% QEQ", ""],
		// (ii) NRL-163 with NRL-164: a lone CR after `>` ends the line for the
		// renderer, so `[^1]:` is an unreferenced footnote definition it hides; the
		// empty quote above it ends the opener's paragraph. Control: `>` + CR
		// replaced by a blank line.
		["pin-nrl114-f2-nrl163-cr-footnote-unmasked", " -|---|---| <!--\n>\r[^1]:  QDQ\n> -       --> ", "-|---|---| <!-- QDQ -->"],
		["guard-nrl114-f2-nrl163-control", " -|---|---| <!--\n\n[^1]:  QDQ\n> -       --> ", "-|---|---| <!-- QDQ -->"],
		// A LONE CR is a line terminator for the renderer, so `x` + CR + `%%` opens a
		// real comment that hides the rest of the note. Our `\n` split never sees that
		// line start, and the PR head's code mask then spoke the quoted `<!--` line
		// below it. From the first lone CR on, a line keeps the pre-NRL-114 term-2
		// answer and no code mask (`crAbove`). RED on the PR head; green on base.
		["pin-nrl114-f2-lone-cr-pct-keeps-later-lines-hidden", "x\r%%\n> \t<!-- CBAZ\n> -->", "x %%"],
		["pin-nrl114-f2-lone-cr-pct-indented", "    \r%%\r\n> > \t\t<!-- CBAZ\r\n     \t-->", ""],
		// `- \t---` is a LIST ITEM for the renderer (its thematic break takes spaces
		// only), so the marker exclusion must not reach it: the item's content below
		// is still dedented and `\t%%` there still opens a block. GUARD, every arm.
		["guard-nrl114-f2-tab-separated-dashes-are-an-item", "- item\n> -  \t---\n   > \t%%\n   > SECRET", "item"],
		// Found by /critique on the first fix-round commit (9c22016), each RED there
		// and green on base. A marker line with no `>` of its own after `>` or
		// `> ---` is an item INSIDE the quote the renderer still holds open, so the
		// quoted `\t%%` under it is dedented item content and opens a block.
		["guard-nrl114-r1-lazy-item-in-open-quote-still-dedents", ">\n2. b\n> \t%% HIDDEN\n> more", "b"],
		["guard-nrl114-r1-item-after-quoted-rule-still-dedents", "> ---\n2. b\n  > \t%% HIDDEN\nafter", "b"],
		// A raw HTML block holds the lines under it; they keep the old answer.
		["guard-nrl114-r1-raw-html-block-keeps-dedent", "<div>\n- > x <!-- QS\n> \t%% QK", "x <!-- QS"],
		// `2.` cannot interrupt a paragraph, so `2. ~~~ js` there is TEXT; the fence
		// drop needs the item to start a block. Base parity.
		["guard-nrl114-r1-non-interrupting-ordered-marker-is-text", "Para one\n2. ~~~ js\nmore", "Para one ~~~ js more"],
		// A fence opened above may hold the line, so a later callout-title fence is
		// not dropped: here it is the item fence's CONTENT, displayed as code.
		["guard-nrl114-r1-callout-line-inside-an-item-fence", "- ~~~ js QG\n> [!tip] ~~~ QX", "~~~ QX", { skipCodeBlocks: false }],
		// An UNMASKING on a control (decision Q11): `- - -` is a thematic break, so
		// the line under it is no longer dedented item content, and the lone CR in it
		// is NRL-164's. The renderer-equivalent `***` twin already speaks it on base.
		["pin-nrl114-r1-rule-then-lone-cr-pct-unmasked", "- - -\n    \r%% QV", "%% QV"],
		["guard-nrl114-r1-rule-then-lone-cr-pct-control", "***\n    \r%% QV", "%% QV"],
		// NRL-166: Verify's minimised F2 shapes (its mins.json) that no row above
		// carries byte for byte. Two are closed and pinned at the renderer's text,
		// RED on main e2afbfe and green on 9132c3b: the F1 callout-is-lazy rule with
		// a tab or an underline in the title.
		["pin-nrl166-min-ordered-list-quote-then-tab-callout", "1. > text <!--  QAQ\n> [!note]\ttext          -->", "text"],
		["pin-nrl166-min-ordered-list-quote-then-underline-callout", "1. > text <!--  QAQ\n> [!note] ===        -->", "text"],
		// The other four stay DIVERGENT from the renderer on main and on this fix
		// alike, and each is an unmasking on a base control (decision Q11): base
		// 9132c3b's output on the control is byte-identical to the fix's output on
		// the shape. TRIPWIRES at today's output, not the renderer's, so a change
		// in either direction is seen. (i) A `<div>` raw HTML block holds the next
		// line (module 8776's type 6 runs to a blank line), so its `<!--  QCQ` /
		// `> - ... -->` is one hidden comment; we speak it. Control: the unquoted
		// twin, which base already speaks. NRL-137's raw-HTML class.
		["pin-nrl166-min-div-block-holds-quoted-item-closer", " <div>      <!--  QCQ\n> -    --> ", "<!-- QCQ -->"],
		["guard-nrl166-min-div-block-unquoted-control", " <div>      <!--  QCQ\n-    --> ", "<!-- QCQ -->"],
		["pin-nrl166-min-div-block-holds-quoted-item-pct-closer", " <div>      <!--  QCQ\n> -  %%  --> QEQ", "<!-- QCQ"],
		["guard-nrl166-min-div-block-pct-unquoted-control", " <div>      <!--  QCQ\n-  %%  --> QEQ", "<!-- QCQ"],
		// (ii) A quoted fence at a quote start keeps its info string spoken
		// (`pin-nrl114-f2-quote-start-fence-still-spoken`). Control: the `-->`
		// defused, which base speaks byte-identically modulo that token.
		["pin-nrl166-min-quote-start-fence-info-spoken", " text <!--  QCQ\r\n> ```    QEQ -->", "text <!-- QCQ QEQ -->"],
		// (iii) An unreferenced footnote definition the renderer hides (NRL-163).
		// Control, mask ALL: the unquoted twin; mask DEF: the `-->` defused.
		["pin-nrl166-min-unreferenced-footnote-spoken", ">\t     <!--\n [^1]:  QBQ -->", "<!-- : QBQ -->"],
		// NRL-166 fix round 1: Verify's own F1-structure census (199,584 shapes)
		// found three classes NEWLY LOST against main e2afbfe once the callout line
		// is read as lazy, each a pre-existing main loss on its de-callout twin.
		// Every row is the executed renderer's visible text (harness 1.13.7), and
		// every pin is RED on 44a037a (fix round 0).
		// Class A: an INLINE comment may not hold `--` (CommonMark's comment rule,
		// module 4839), so a term-2 opener whose body up to its `-->` holds one is
		// literal text and the next `<!--` is the comment.
		["pin-nrl166-r1-a-callout-body-holds-opener", "- > Plain QAQ <!-- QXQ\n> [!tip] QBQ <!--\n> QCQ -->", "Plain QAQ <!-- QXQ QBQ"],
		["pin-nrl166-r1-a-decallout-twin", "- > Plain QAQ <!-- QXQ\n> Tip QBQ <!--\n> QCQ -->", "Plain QAQ <!-- QXQ Tip QBQ"],
		["pin-nrl166-r1-a-plain-paragraph", "Plain QAQ <!-- QXQ\nQBQ <!--\nQCQ -->\nTAIL QDQ", "Plain QAQ <!-- QXQ QBQ TAIL QDQ"],
		["pin-nrl166-r1-a-quoted-dash-pair", "> P <!-- QXQ\n> -- QBQ --> Z", "P <!-- QXQ -- QBQ --> Z"],
		["pin-nrl166-r1-a-body-ends-in-dash", "P <!-- QXQ\nQBQ ---> Z", "P <!-- QXQ QBQ ---> Z"],
		["pin-nrl166-r1-a-abrupt-opener", "P <!--> QXQ\nQBQ --> Z", "P <!--> QXQ QBQ --> Z"],
		// Valid bodies stay hidden: a dash at a line end is not `--` across the
		// line break, and `->` after the line break is not at the body's start.
		// A line-start `<!--` is an HTML block, where `--` does not matter.
		["guard-nrl166-r1-a-dash-before-break-hidden", "P <!-- QXQ -\n--> Z", "P Z"],
		["guard-nrl166-r1-a-arrow-after-break-hidden", "P <!--\n-> QXQ --> Z", "P Z"],
		["guard-nrl166-r1-a-block-comment-ignores-dashes", "<!-- QXQ\n-- QBQ -->\nZ", "Z"],
		// Class C: a lazy line led by indented code ENDS a quote (`indentedCode` is
		// in `interruptBlockquote`), so `>\t-->` after a deeper quote's paragraph is a
		// code block of the outer quote and closes nothing. We speak that code line
		// as prose, as main does: displayed text either way.
		["pin-nrl166-r1-c-item-quote-callout-code-closer", "- >> Plain QAQ <!-- QXQ\n> [!x]\n>\t--> QCQ", "Plain QAQ <!-- QXQ --> QCQ"],
		["pin-nrl166-r1-c-nested-callout-code-closer", "- > > Plain QAQ <!-- QXQ\n> [!tip] QBQ\n>\t--> QCQ", "Plain QAQ <!-- QXQ QBQ --> QCQ"],
		["pin-nrl166-r1-c-decallout-twin", "> > P <!-- QXQ\n> QBQ\n>\t--> QCQ", "P <!-- QXQ QBQ --> QCQ"],
		// The same `>\t-->` at the paragraph's own depth is a lazy line, and a tab
		// under a list item's quote is the item's indent: both still close.
		["guard-nrl166-r1-c-same-depth-tab-closer-hidden", "> P <!-- QXQ\n>\t--> Z", "P Z"],
		["guard-nrl166-r1-c-item-indent-tab-closer-hidden", "- > P <!-- QXQ\n\t--> Z", "P Z"],
		["guard-nrl166-r1-c-three-columns-closer-hidden", "> > P <!-- QXQ\n>    --> Z", "P Z"],
		// The code-line stop is for a PARAGRAPH opener only. Here the trailing
		// `<!--` follows a raw HTML line, so it is a browser comment that runs on
		// through the rendered code block and hides QBQ and QCQ. RED on an arm that
		// applied the stop to every opener (minimised from the seed-31337 fuzz).
		["guard-nrl166-r1-c-browser-comment-crosses-code-line", "1. ><!-- y --> QAQ <!--\n>>> \tQBQ\n>> QCQ\n> >\t --> QDQ", "QAQ QDQ"],
		// Class B: `- > \t` opens indented code inside the item's quote, so its
		// `<!--` is code. A `%%` line below ends the list uncertainly and the walker
		// skipped the whole last item; its FIRST line does not depend on where the
		// item ends. We speak the code line as prose, as main does.
		["pin-nrl166-r1-b-item-quote-code-opener-then-pct", "- > \tPlain QAQ <!-- QXQ\n> [!tip] QBQ -->\n%%", "Plain QAQ <!-- QXQ QBQ -->"],
		["pin-nrl166-r1-b-item-quote-code-opener-then-pct-tail", "- > \tPlain QAQ <!-- QXQ\n> [!tip] QBQ -->\n%%\nTAIL QDQ", "Plain QAQ <!-- QXQ QBQ -->"],
		["pin-nrl166-r1-b-decallout-twin", "- > \tPlain QAQ <!-- QXQ\n> Tip QBQ -->\n%%", "Plain QAQ <!-- QXQ Tip QBQ -->"],
		// F3. Three UNMASKING classes Verify's 808,704-shape structured census found
		// NEWLY LOST against base and no ADR row named. Each is fail-closed (we hide
		// text the renderer displays), each was hidden on base only because the wide
		// peel ate the tab in `>\t===` / `>\t---` / `>\t%%`, and each is adjudicated
		// on the peel-equalising control (`>X` -> `> X`), on which base already loses
		// the same text byte-identically. Each pin is RED on base; each control is
		// green on base. Named in ADR 0025's NRL-114 amendment.
		// (a) term 1's `.trim()` takes a VT or NBSP lead as the start of a line-start
		// `<!--` block, where module 8776 skips spaces and tabs only (2,464 cells).
		["pin-nrl114-f3a-vt-led-html-opener-unmasked", "> Plain ZPZ prose\n>\v<!-- ZAZ\n>\t===\n> ZBZ\nTAIL ZDZ", "Plain ZPZ prose"],
		["guard-nrl114-f3a-control", "> Plain ZPZ prose\n> \v<!-- ZAZ\n> \t===\n> ZBZ\nTAIL ZDZ", "Plain ZPZ prose"],
		// (b) an inline comment may not contain `--`, so `<!-- ZAZ` / `---` / `ZBZ -->`
		// in one paragraph is NOT a comment for the renderer (64 cells). CLOSED by
		// NRL-166 fix round 1, which checks the body on lines the walker is sure
		// are paragraph text: both rows now speak the renderer's text (its `---`
		// is a lazy line; we drop the dashes).
		["pin-nrl114-f3b-comment-body-holding-dashes-unmasked", "> Plain ZPZ prose\n>\t<!-- ZAZ\n>\t---\n> ZBZ -->\nTAIL ZDZ", "Plain ZPZ prose <!-- ZAZ ZBZ --> TAIL ZDZ"],
		["guard-nrl114-f3b-control", "> Plain ZPZ prose\n> \t<!-- ZAZ\n> \t---\n> ZBZ -->\nTAIL ZDZ", "Plain ZPZ prose <!-- ZAZ ZBZ --> TAIL ZDZ"],
		// (c) the shared `FENCE` is `^\s*`, so a tab-led ``` is read as a fence where
		// module 134 makes it indented code (208 cells).
		// NRL-166 port (2026-10-08): CLOSED on main by NRL-156 (#214), which caps
		// `FENCE` at the renderer's three-space rule, so a tab-led ``` is no fence
		// and both rows now speak the executed renderer's visible text exactly
		// (`Plain ZPZ prose<br>%% ZAZ` / `<pre>` / `ZBZ %%<br>TAIL ZDZ`). Replaced
		// in place, names kept; RED on 9132c3b and on 9c22016.
		["pin-nrl114-f3c-tab-led-fence-unmasked", "> Plain ZPZ prose\n>\t%% ZAZ\n\t```\n> ZBZ %%\nTAIL ZDZ", "Plain ZPZ prose %% ZAZ ZBZ %% TAIL ZDZ"],
		["guard-nrl114-f3c-control", "> Plain ZPZ prose\n> \t%% ZAZ\n\t```\n> ZBZ %%\nTAIL ZDZ", "Plain ZPZ prose %% ZAZ ZBZ %% TAIL ZDZ"],
		// 3. CLOSED BY NRL-116, and REPLACED IN PLACE keeping its name for the same
		// citation reason as the three above - the name now reads backwards. Our
		// `LIST_BULLET` was /^\s*([-*+]|\d+[.)])\s+/ and its `\s+` ate the WHOLE lead
		// after a marker, where module 745's third group takes at most four spaces or
		// one tab. So `-` plus eight spaces plus `%%` reached the renderer as seven
		// spaces and `%%`, which is indented code, and reached us as `%%` at offset 0.
		// NRL-93 recorded this as "three cells of the census"; measured against the real
		// renderer over NRL-116's own corpus it is far larger than three, and the figure
		// is corrected in `srs.md` rather than here.
		["pin-nrl93-list-marker-lead-eaten-still-silenced", "- Plain prose\n-        %%\n- SECRET", "Plain prose %% SECRET"],
		// 4. A COST this fix carries, measured and pinned rather than hidden. Our `%%`
		// block is NOTE-scoped (ADR 0006 clause 5) where Obsidian scopes an
		// unterminated one to the construct that holds it - module 745 tokenizes each
		// item's value on its own and module 6234 each quote's content. Base was
		// accidentally PAIRING a wrongly-recognised over-indented opener with a real
		// one and so closing the block early; declining the wrong opener leaves the
		// real one's note-scope reaching further, and text Obsidian displays goes
		// quiet. The scope rule itself is untouched. Measured by the 4,000-note fuzz:
		// 157 of 16,000 cells newly lost against 833 losses closed and 0 cells newly
		// leaking, and all 157 are notes whose surviving opener sits inside a list item
		// (117) or a blockquote (40). The structured corpora found none of this, which
		// is why the fuzz carries tabs, multi-space leads and a list-bearing
		// population.
		//
		// NRL-118 CLOSED THIS COST, and these three moved ON PURPOSE, in place with
		// their names kept as a record of the cost they pinned: the surviving opener
		// sits in a list item or a blockquote, its block now ends with that container
		// at the blank line, and VISIBLE is spoken as the reading view displays it.
		// All three were "Para. %%" on base.
		["pin-nrl93-scope-cost-four-space-then-bullet", "Para.\n    %%\n- %%\n\nVISIBLE", "Para. %% VISIBLE"],
		["pin-nrl93-scope-cost-tab-then-bullet", "Para.\n	%%\n- %%\n\nVISIBLE", "Para. %% VISIBLE"],
		["pin-nrl93-scope-cost-tab-then-quote", "Para.\n	%%\n> %%\n\nVISIBLE", "Para. %% VISIBLE"],
		// 5. ADR 0019's designed literal, in its own bucket and NOT a disclosure. A
		// tab-led `%%` line inside a soft-wrapped code span is now part of a CONFIRMED
		// span, so the span is silenced whole when inline code is skipped and spoken
		// verbatim when it is not - destination included, because inside a code span
		// the raw text is what the renderer shows (ADR 0019, srs.md R-M08). Base agreed
		// with NEITHER position, which is the half-recognised symptom. 256 of the 512
		// cells P3's controls report, all at skipInlineCode false.
		["pin-nrl93-adr0019-span-destination-skipped", "Before `a\n	%% x ![alt](zdestz.png)\nb` after.", "Before after."],
		["pin-nrl93-adr0019-span-destination-spoken", "Before `a\n	%% x ![alt](zdestz.png)\nb` after.", "Before a %% x ![alt](zdestz.png) b after.", { skipInlineCode: false }],
		// NRL-93 FIX-FORWARD. An independent Verify pass FAILED the first draft of
		// this change for a DISCLOSURE it introduced, and the twelve fixtures below
		// are that defect's own shapes. Every one of them was RED against the first
		// draft and is green now; the oracle is real rendered HTML from Obsidian
		// 1.13.7's own parser and renderer run in Node, not a transcription.
		//
		// THE DEFECT. `listDedented`'s run-ending condition asked its questions of the
		// QUOTE-PEELED body, `lines[k].replace(BLOCKQUOTE, "")`. A heading, fence or
		// thematic break that lives inside a BLOCKQUOTE nested in a list item peels
		// down to a bare `---` / `# H` / ```` ``` ````, which really would end a list -
		// so the run ended, `listDedented` read false for the next line, the predicate
		// declined an opener the renderer really does honour, and author-hidden text
		// was SPOKEN. Base was correct in all 1,780 cells of the 3,360-cell two-arm
		// corpus; this was introduced, not unmasked. Measured on the fix: 0.
		//
		// ARM 1, the quoted heading / fence / thematic break. The guard is that those
		// three terms may end a run only when the line is NOT quoted. 1,480 of 2,464
		// cells, down to 0.
		["pin-nrl93-arm1-quoted-hr-in-item", "- item\n> ---\n	%% SECRETA\nTAILVIS", "item"],
		["pin-nrl93-arm1-quoted-hr-ordered-item", "1. item\n> ---\n	%% SECRETA\nTAILVIS", "item"],
		["pin-nrl93-arm1-quoted-fence-in-item", "- item\n> ```\n> c\n> ```\n    %% SECRETA\nTAILVIS", "item c"],
		["pin-nrl93-arm1-nested-quoted-hr-in-item", "- item\n> > ---\n	%% SECRETA\nTAILVIS", "item"],
		["pin-nrl93-arm1-indented-quoted-hr-in-item", "- item\n  > ---\n	%% SECRETA\nTAILVIS", "item"],
		// The quoted-heading form, with a divergence of its own that is NOT this
		// fix's and is identical on base: the `#` is spoken because `stripTags` is
		// the only thing that would remove it and a quoted heading inside a list item
		// is not reached by the heading branch. Pinned with the `#` so the fixture
		// records what we really say rather than what we would like to say.
		["pin-nrl93-arm1-quoted-heading-in-item", "- item\n> # H\n	%% SECRETA\nTAILVIS", "item # H"],
		// ARM 2, which the arm-1 guard does NOT cover and which is why both came off
		// together. `blankBefore` may end a run only when the line's RAW indent is
		// empty as well as its peeled body's: two columns of indent reach a `- item`'s
		// content indent, so the quote stays inside the item, while the same quote at
		// column 0 genuinely does end the list. The peel removes the indent along with
		// the marker, so the peeled body cannot tell those apart. 368 of 896 cells,
		// down to 0.
		["pin-nrl93-arm2-blank-then-indented-quote", "- item\n\n  > q\n	%% SECRETA\nTAILVIS", "item q"],
		["pin-nrl93-arm2-blank-then-3sp-quote", "- item\n\n   > q\n    %% SECRETA\nTAILVIS", "item q"],
		["pin-nrl93-arm2-blank-then-tab-quote", "1. item\n\n	> q\n	%% SECRETA\nTAILVIS", "item q"],
		// THE TWO CONTROLS that localise the fault and stop the guards being widened
		// into "never end a run". Both are green on the first draft AND on the fix, and
		// RED on base, so they are census gains rather than evidence of this fix - but
		// a careless widening of either guard would take them away. An UNQUOTED
		// thematic break really does end the list, and a column-0 quoted line after a
		// blank really does too, so in both the renderer DISPLAYS the secret and we
		// must speak it.
		["guard-nrl93-unquoted-hr-really-ends-the-list", "- item\n---\n    %% SECRETA\nTAILVIS", "item %% SECRETA TAILVIS"],
		["guard-nrl93-col0-quote-after-blank-really-ends-the-list", "- item\n\n> q\n	%% SECRETA\nTAILVIS", "item q %% SECRETA TAILVIS"],
		// THE UNMASKED DESTINATION CLASS, pinned as a TRIPWIRE and not as evidence of
		// a fix, following pin-nrl74-container-label-still-leaks-destination. Declining
		// a `%%` opener stops that line interrupting the paragraph, so
		// `bracketClosesLater` confirms a soft-wrapped label across it and the
		// destination is spoken where base said nothing. Measured over 768 cells (2
		// shapes x 8 container prefixes x 6 leads x 8 option sets): base 0, fix 384.
		//
		// THE CONTROL IS WHAT MAKES IT A TRIPWIRE RATHER THAN A LEAK, and it is the
		// second fixture here: replace the declined `%%` line with ordinary prose and
		// the destination is spoken in 768 of 768 cells on BASE and 768 of 768 on the
		// fix. So the aborted-carry literal is pre-existing, and all this change did
		// was stop base's note-scoped `%%` block swallowing the tail that was masking
		// it. Note the other half of the move, in the safe direction: base SPEAKS
		// ZHIDEZ here, which the renderer hides, and the fix does not.
		//
		// When NRL-88's remaining roots close, the first expectation must change on
		// purpose; the control's must not move at all.
		["pin-nrl93-unmasked-label-destination", "Before ![alt\n	%% x\n%%\nZHIDEZ\n%%\nmore](zdestz.png) after.", "Before [alt %% x more](zdestz.png) after."],
		["guard-nrl93-unmasked-label-destination-control", "Before ![alt\n	plain x\n%%\nZHIDEZ\n%%\nmore](zdestz.png) after.", "Before [alt plain x more](zdestz.png) after."],
		// NRL-118. These rows began life as a TRIPWIRE, pinning a pre-existing
		// DISCLOSURE (we spoke text Obsidian hides) so it could only change on
		// purpose. NRL-118 is that purpose, so the first row is RETARGETED IN PLACE
		// and renamed from `pin-nrl118-note-scope-closes-at-another-depth`, which
		// expected "SECRET".
		//
		// The defect: our `%%` block state was note-scoped AND container-blind, where
		// Obsidian scopes a block to the construct holding it. So a later `%%` at a
		// DIFFERENT container depth closed for us a block the renderer keeps open,
		// and the rest of that line was spoken. The rule now (ADR 0006 clause 5, NRL-118
		// amendment): a `%%` block opened inside a container closes when that
		// container ends, and the line that ends it is processed FRESH at its own
		// depth, where a line-start `%%` opens a new block. For `>> %%` / `%% SECRET`
		// the bare `%%` line interrupts both quotes (`comment` is in
		// `interruptBlockquote`) and opens a new top-level block, so SECRET is hidden.
		// Every expectation below is the visible text of real rendered HTML from
		// Obsidian 1.13.7's own parser and renderer run out of the installed bundle.
		// NOT OBSERVED IN A RUNNING OBSIDIAN; reading view only.
		["pin-nrl118-different-depth-percent-opens-new-block", ">> %%\n%% SECRET", ""],
		// The control. It was labelled a guard and stays one: with no container at
		// all the block is note-scoped exactly as before, and the renderer DISPLAYS
		// SECRET here, because the second `%%` is the first block's closer and the
		// rest of a closer line is shown. So this row must NOT move with the fix,
		// and that is what stops the fix being "never close at a later `%%`".
		["guard-nrl118-note-scope-control-no-container", "%%\n%% SECRET", "SECRET"],
		// NRL-113. `INDENTED_CODE` used to accept one to three SPACES followed by a
		// TAB, on CommonMark's tab-stop reasoning. Obsidian's indented-code tokenizer,
		// module 134, does NO tab-stop expansion: its opener arm is four LITERAL
		// spaces or ONE LITERAL tab at offset 0, and the continuation arm is the same
		// test. So a ` \t`, `  \t` or `   \t` lead is not indented code for the
		// renderer, and treating it as code dropped the lead line and spoke whatever
		// followed.
		//
		// The oracle for every entry below is REAL RENDERED HTML from Obsidian
		// 1.13.7's own parser and renderer executed in Node (the harness at
		// ~/.local/share/note-reader-local/obsidian-parser-harness), not a
		// transcription. NOT VERIFIED IN A LIVE OBSIDIAN, and reading-view path only.
		//
		// THE DISCLOSURE (R-M08). For ` \t<!--` in a fresh-block position the real
		// HTML is `<p>Before x.</p>\n \t<!--\nHIDDEN1\nmore` - the raw comment passes
		// through `allowDangerousHtml` untouched and HIDDEN1/more are inside it. We
		// spoke them. BOTH positions of `skipCodeBlocks` were leaks and both are
		// pinned, because the renderer does not call the line code at all, so that
		// toggle has no business governing it.
		["pin-nrl113-space-tab-html-hidden", "Before x.\n\n \t<!--\nHIDDEN1\nmore", "Before x."],
		["pin-nrl113-space-tab-html-hidden-spoken", "Before x.\n\n \t<!--\nHIDDEN1\nmore", "Before x.", { skipCodeBlocks: false }],
		["pin-nrl113-two-space-tab-html-hidden", "Before x.\n\n  \t<!--\nHIDDEN1\nmore", "Before x."],
		["pin-nrl113-two-space-tab-html-hidden-spoken", "Before x.\n\n  \t<!--\nHIDDEN1\nmore", "Before x.", { skipCodeBlocks: false }],
		["pin-nrl113-three-space-tab-html-hidden", "Before x.\n\n   \t<!--\nHIDDEN1\nmore", "Before x."],
		["pin-nrl113-three-space-tab-html-hidden-spoken", "Before x.\n\n   \t<!--\nHIDDEN1\nmore", "Before x.", { skipCodeBlocks: false }],
		// Document start is a second fresh-block position and reached the same branch.
		["pin-nrl113-space-tab-html-hidden-document-start", " \t<!--\nHIDDEN1\nmore", ""],
		["pin-nrl113-space-tab-html-hidden-document-start-spoken", " \t<!--\nHIDDEN1\nmore", "", { skipCodeBlocks: false }],
		// The TERMINATED variant, where the renderer resumes after `-->`: real HTML is
		// `<p>Before x.</p>\n \t<!--\nHIDDEN1\n-->\n<p>more</p>`, so `more` is displayed
		// and HIDDEN1 and the closer are not.
		["pin-nrl113-space-tab-html-terminated", "Before x.\n\n \t<!--\nHIDDEN1\n-->\nmore", "Before x. more"],
		// PROSE RECOVERY, not a disclosure, and the row that touches NRL-93's shipped
		// `opensObsidianBlock`. A fresh-block ` \t%%` stops being an indented-code lead
		// and becomes prose carrying a LITERAL `%%`, which is what the renderer shows:
		// `<p> \t%%<br>\nSECRET<br>\nVISIBLE</p>`. `opensObsidianBlock`'s term A scans
		// charCode 32 only, so it declines the tab-led opener exactly as the renderer's
		// own `%%` skip loop does, and no term of that predicate changed.
		["pin-nrl113-space-tab-percent-literal", "Before x.\n\n \t%%\nSECRET\nVISIBLE", "Before x. %% SECRET VISIBLE"],
		["pin-nrl113-two-space-tab-percent-literal", "Before x.\n\n  \t%%\nSECRET\nVISIBLE", "Before x. %% SECRET VISIBLE"],
		// THE R-M09 HALF, through the second read site: `containerCarryStops`' lazy arm
		// (NRL-98, ADR 0029). A lazy continuation led by ` \t` does NOT end the
		// blockquote for the renderer - one `<p>` spans the break and the destination
		// lands in an attribute - so the carry must be confirmed and the destination
		// dropped. Base spoke `](zdestz.png)`. The lone-tab and four-space twins below
		// are guards: those leads really do end the quote, so failing closed there is
		// correct.
		["pin-nrl113-container-lazy-space-tab-destination-dropped", "> A ![alt\n \twords](zdestz.png) B", "A B", { speakImageAlt: false }],
		["pin-nrl113-container-lazy-space-tab-destination-dropped-link", "> A [lbl\n \twords](zdestz.png) B", "A lbl words B", { speakImageAlt: false }],
		["pin-nrl113-container-lazy-two-space-tab-destination-dropped", "> A ![alt\n  \twords](zdestz.png) B", "A B", { speakImageAlt: false }],
		// THE CONTINUATION ROW (Q1), which has no cell in the issue's own corpus and so
		// was measured rather than asserted. Module 134 is a SINGLE loop whose
		// continuation arm is its opener arm, so a ` \t` line ENDS an open indented code
		// block for the renderer: `<pre><code>code one\n</code></pre>\n<p> \tSECRETC<br>
		// \nmore</p>`. Base kept it inside the block and silenced SECRETC, which is
		// prose loss; the fix speaks it, matching the rendered paragraph. The
		// four-space-opened twin exercises the same arm from the other opener form.
		["pin-nrl113-indented-code-continuation-space-tab-ends-block", "Before x.\n\n\tcode one\n \tSECRETC\nmore", "Before x. SECRETC more"],
		["pin-nrl113-indented-code-continuation-space-tab-ends-block-4sp-opener", "Before x.\n\n    code one\n \tSECRETC\nmore", "Before x. SECRETC more"],
		// GUARDS. Green on BOTH sides of this change and therefore NOT evidence of it;
		// they exist so the narrowing cannot be widened or over-narrowed later.
		//
		// THE NOT-A-DEFECT PIN, and the one entry here that must never be "fixed"
		// back. A fresh-block `\t<!--` renders as `<p>Before x.</p>\n<pre><code>&#x3C;!--
		// \n</code></pre>\n<p>HIDDEN1<br>\nmore</p>` - paragraph, code, paragraph - so
		// HIDDEN1 and `more` are DISPLAYED and speaking them is renderer-faithful in
		// both `skipCodeBlocks` positions. The cause is `blockMethods` ORDER, produced
		// by running the real construction: `indentedCode` sits at index 2 and `html`
		// at index 11, so module 134 consumes the line before module 8776 is consulted.
		// Module 8776's skip loop does accept a tab, but it never gets to decide this
		// shape, which is why `AGENTS.md`, `srs.md:328` and `docs/adr/0025` all drew the
		// wrong conclusion from a true premise until NRL-113 ran the parser.
		["guard-nrl113-fresh-block-tab-html-is-indented-code", "Before x.\n\n\t<!--\nHIDDEN1\nmore", "Before x. HIDDEN1 more"],
		["guard-nrl113-fresh-block-tab-html-is-indented-code-spoken", "Before x.\n\n\t<!--\nHIDDEN1\nmore", "Before x. <!-- HIDDEN1 more", { skipCodeBlocks: false }],
		["guard-nrl113-fresh-block-four-space-html-is-indented-code", "Before x.\n\n    <!--\nHIDDEN1\nmore", "Before x. HIDDEN1 more"],
		["guard-nrl113-fresh-block-eight-space-html-is-indented-code", "Before x.\n\n        <!--\nHIDDEN1\nmore", "Before x. HIDDEN1 more"],
		// `\t ` is a tab FIRST, so module 134's one-literal-tab arm still opens, and so
		// does ours. The narrowing is about a tab that FOLLOWS spaces, not about any
		// lead containing a tab.
		["guard-nrl113-tab-space-still-indented-code", "Before x.\n\n\t %%\nSECRET\nVISIBLE", "Before x. SECRET VISIBLE"],
		// Three spaces alone was never indented code in either tree, and a tab-led
		// lazy continuation really does end a blockquote, so both stay put.
		["guard-nrl113-three-space-html-opener-unmoved", "Before x.\n\n   <!--\nHIDDEN1\nmore", "Before x."],
		["guard-nrl113-container-lazy-tab-fails-closed", "> A ![alt\n\twords](zdestz.png) B", "A [alt words](zdestz.png) B", { speakImageAlt: false }],
		["guard-nrl113-indented-code-continuation-tab-stays-in-block", "Before x.\n\n\tcode one\n\tSECRETC\nmore", "Before x. more"],
		// Two shapes where base already agreed with the fix and the agreement is worth
		// pinning. At `skipCodeBlocks: false` the continuation row lands on the same
		// string by a different route - base speaks the line as code content through
		// `verbatimLine`, the fix speaks it as prose - so the toggle hides the move.
		// And a ` \t<!--` in a PARAGRAPH CONTINUATION position never reaches the opener
		// at all (`wasBlank` is false), so this diff cannot touch it; the renderer
		// displays that line and we still drop it, which is a PRE-EXISTING prose loss
		// of the `opensHtmlBlock` `.trim()` family (NRL-93's shape), measured identical
		// on both arms and NOT opened here.
		["guard-nrl113-indented-code-continuation-space-tab-spoken-unmoved", "Before x.\n\n\tcode one\n \tSECRETC\nmore", "Before x. code one SECRETC more", { skipCodeBlocks: false }],
		// NRL-115 CLOSED the paragraph-continuation half of the note above and moved
		// this row in place (the NRL-66/NRL-67 convention): the ` \t<!--` line is a lazy
		// continuation for module 8607, the renderer's HTML is
		// `<p>Before x.<br>&#x3C;!--<br>HIDDEN1<br>more</p>`, and every line is displayed.
		// It was green on both NRL-113 arms as base behaviour, not as a correctness claim.
		["guard-nrl113-space-tab-paragraph-continuation-unmoved", "Before x.\n \t<!--\nHIDDEN1\nmore", "Before x. <!-- HIDDEN1 more"],
		// A TRIPWIRE AND NOT EVIDENCE OF A FIX, in the style of
		// `pin-nrl74-container-label-still-leaks-destination`. This is the one class
		// the structured corpora could not see and the 4,000-note fuzz did: a
		// 1-3-space-plus-tab-led LINK REFERENCE DEFINITION. It is a DISCLOSURE - we
		// speak a destination the renderer never shows, because module 1616 consumes
		// the definition and renders nothing at all (real HTML for the first fixture
		// is `<p>ZPROSEZ <a href="zdestz.png" title="t">a</a>.</p>`, destination in an
		// attribute only).
		//
		// MECHANISM. Base ate the line as indented code, so it was silent for the
		// wrong reason. The narrowing lets the line reach the `LINK_REF_DEF` branch,
		// whose own lead rule is `^ {0,3}\[` - spaces only, capped at three, the same
		// CommonMark-shaped assumption this ticket removed one predicate over. It
		// declines a tab-bearing lead, so the line falls through to prose.
		//
		// IT IS NOT A NEW LEAK CLASS, and the CONTROL is what establishes that rather
		// than an argument. The second fixture is the ADR 0018 decision-Q8 shape with
		// NO LEAD ANYWHERE: the second of two consecutive definitions inside a
		// blockquote fails the branch's empty-paragraph guard, falls through, and
		// speaks its destination on BASE and on the fix alike. Measured over 6
		// positions x 15 leads x 512 content-key masks = 46,080 cells: 2,560 cells
		// newly speak the destination, all in the doc-start and fresh-block positions
		// with a tab-bearing lead; the SAME shape already leaks 256 of each row's 512
		// cells on base, at `skipCodeBlocks: false`, where base spoke the destination
		// as verbatim code content; and the in-quote and two-definition rows leak
		// 512 of 512 on BOTH arms with or without a tab. 0 cells newly speak a
		// destination anywhere the renderer displays it.
		//
		// NOT FIXED HERE, deliberately: widening a second predicate in the same diff
		// is what makes a measured result unattributable, and `LINK_REF_DEF`'s lead
		// needs ADR 0018's own battery re-run. WHEN IT CLOSES, the first expectation
		// must change on purpose; the control's must not move at all.
		["pin-nrl113-space-tab-link-ref-def-leaks-destination", " \t[a]: zdestz.png \"t\"\n\nZPROSEZ [a].", "a : zdestz.png \"t\" ZPROSEZ a ."],
		["guard-nrl113-link-ref-def-fallthrough-control-no-lead", "> [a]: zdestz.png \"t\"\n> [b]: zdestz.png \"u\"\n\nZPROSEZ.", "b : zdestz.png \"u\" ZPROSEZ."],
		// NRL-113, SHIP REVIEW. The ticket's own corpus had a CONSTRUCT axis three
		// wide - `<!--`, `%%`, and the image/link label - and the branch this change
		// narrows carries the comment "Checked before fences, rules, math and
		// tables". Every one of those four, plus headings, bullets, quotes, callouts,
		// wikilinks, embeds, footnote definitions and HTML blocks, becomes newly
		// REACHABLE for a ` \t` / `  \t` / `   \t` lead, and none of them had a cell.
		// Re-measured at ship review over 20 constructs x 10 leads x 4 option modes =
		// 800 cells with the renderer verdict from the same harness's real rendered
		// HTML: 200 cells move, `sourceIndex` lockstep holds with 0 failures in all
		// four properties on BOTH arms, and the large majority of the 200 are the
		// narrowing agreeing with the renderer where base did not. The rows worth
		// pinning are below. The fuzz found one missed class (the link-reference
		// definition above); it did not find these, so the corpus is what is pinned.
		//
		// RENDERER-FAITHFUL MOVES. Each HTML string is what the harness rendered.
		// A fence really does open on a ` \t` lead, so its body is CODE and the
		// code-block key governs it, where base ate the fence line as indented code
		// and then spoke the body as prose with the code key ON.
		["pin-nrl113-space-tab-fence-opens-a-fence", "Before x.\n\n \t```js\nCODEBODY\n```\nAFTER", "Before x. AFTER"],
		["pin-nrl113-space-tab-fence-unclosed-is-code-to-eof", "Before x.\n\n \t```js\nPROSEA\nPROSEB", "Before x."],
		["pin-nrl113-space-tab-fence-unclosed-spoken", "Before x.\n\n \t```js\nPROSEA\nPROSEB", "Before x. PROSEA PROSEB", { skipCodeBlocks: false }],
		// `<h1 data-heading="HEADA">HEADA</h1>`, `<li>ITEMA</li>`,
		// `<blockquote><p>QUOTEA</p></blockquote>`, and a real callout div: all four
		// were silenced whole on base and all four are displayed.
		["pin-nrl113-space-tab-heading-is-a-heading", "Before x.\n\n \t# HEADA\nAFTER", "Before x. HEADA AFTER"],
		["pin-nrl113-space-tab-bullet-is-a-list-item", "Before x.\n\n \t- ITEMA\nAFTER", "Before x. ITEMA AFTER"],
		["pin-nrl113-space-tab-quote-is-a-blockquote", "Before x.\n\n \t> QUOTEA\nAFTER", "Before x. QUOTEA AFTER"],
		["pin-nrl113-space-tab-callout-title-recovered", "Before x.\n\n \t> [!note] TITLEA\n> CBODY\n\nAFTER", "Before x. TITLEA CBODY AFTER"],
		// An unterminated `$$` is NOT a math block for the renderer with this lead -
		// `<p> \t$$<br>MPROSEA<br>MPROSEB</p>` - so the literal `$$` is displayed and
		// is now spoken, where base dropped it as an indent.
		["pin-nrl113-space-tab-unclosed-math-is-literal", "Before x.\n\n \t$$\nMPROSEA\nMPROSEB", "Before x. $$ MPROSEA MPROSEB"],
		// TRIPWIRES, NOT EVIDENCE OF A FIX. Three shapes where the narrowing exposes a
		// pre-existing divergence in a DIFFERENT predicate, each in the prose-loss or
		// markup-leak direction and none a disclosure. They are pinned rather than
		// fixed for the same reason the link-reference definition above is: widening a
		// second predicate inside this diff would make its measurements unattributable
		// and would move `interruptsParagraph`'s answer set, which this change
		// deliberately leaves byte-identical. Tracked as NRL-147.
		//
		// `TABLE_ROW` is `/^\s*\|/`, so a tab-led pipe line is a table row for us and
		// `skipTables` drops it. The renderer makes it a PARAGRAPH -
		// `<p> \t| a | b |<br>| - | - |<br>| TCELL | y |</p>` - so that key has no
		// business governing it. Base spoke the first row as verbatim code content at
		// `skipCodeBlocks: false`; the fix speaks none of it. At the default
		// `skipCodeBlocks: true` both arms are silent, so this is reachable only in
		// that one combination. WHEN IT CLOSES, this expectation must change.
		["pin-nrl113-space-tab-table-row-silenced-by-skiptables", "Before x.\n\n \t| a | b |\n| - | - |\n| TCELL | y |\n\nAFTER", "Before x. AFTER", { skipCodeBlocks: false }],
		// `opensMathBlock` uses `trimStart()`, which accepts a tab where the renderer's
		// `$$` predicate skips charCode 32 only - the divergence `AGENTS.md` already
		// records as NRL-93's family. So we call this a display-math block and say
		// "equation", where the renderer displays ` \t$$` and `a+b` as paragraph text.
		// It is asserted BELOW rather than here, because it synthesises an "equation"
		// chunk and this table's lockstep loop deliberately passes no ADR 0004
		// exemption. Teaching the shared loop that exemption would loosen it for
		// every one of its ~200 entries to accommodate one fixture.
		// `HEADING` is `/^\s{0,3}#{1,6}\s+/` and `BLOCKQUOTE` is `/^(?:\s{0,3}>\s?)+/`,
		// so FOUR leading whitespace characters exceed the cap and the marker is
		// spoken as prose. The renderer makes both a heading and a quote. A markup
		// leak, not prose loss and not a disclosure: nothing hidden is spoken and
		// nothing displayed is lost, only `#` and `>` are said aloud.
		["pin-nrl113-three-space-tab-heading-leaks-hash", "Before x.\n\n   \t# HEADA\nAFTER", "Before x. # HEADA AFTER"],
		["pin-nrl113-three-space-tab-quote-leaks-marker", "Before x.\n\n   \t> QUOTEA\nAFTER", "Before x. > QUOTEA AFTER"],
		// NRL-116. `containerPrefix`'s list arm peeled with the SHARED `LIST_BULLET`,
		// whose trailing `\s+` ate a marker's whole lead, and with the SHARED `TASK`,
		// whose trailing `\s*` did the same after a checkbox. Module 745 takes at most
		// four spaces not followed by a fifth, or one space, or one tab, and leaves the
		// rest as the item's content indent. The peel is now THREE peel-local constants
		// - `PEEL_MARKER`, `PEEL_LEAD`, `PEEL_TASK` - and `LIST_BULLET` and `TASK` are
		// BYTE-IDENTICAL for their three other readers (`interruptsParagraph`, the
		// `listDedented` pass, and that pass's `inList` end test), which is the whole
		// reason this is safe: NRL-93's planned one-term change to a shared predicate
		// measured a 6,144-cell regression.
		//
		// CORE CASES. Each was measured RED against the unfixed tree. The oracle is
		// real rendered HTML from Obsidian 1.13.7's own parser and renderer run in
		// Node, which displays the sentinel in every one.
		["pin-nrl116-star-marker-tab-lead", "* Plain prose\n* 	%%\n* SECRET", "Plain prose %% SECRET"],
		["pin-nrl116-paren-ordered-tab-lead", "1) Plain prose\n1) 	%%\n1) SECRET", "Plain prose %% SECRET"],
		// FIVE spaces, which is the branch that proves the lead is a BOUNDED alternation
		// and not `\s+`: ` {1,4}(?! )` cannot match here (a fifth space follows every
		// prefix of it), so the single-space alternative fires and four spaces are left
		// in the body, where `INDENTED_CODE` sees them.
		["pin-nrl116-five-space-lead", "- Plain prose\n-     %%\n- SECRET", "Plain prose %% SECRET"],
		// THE `TASK` HALF, which is a SECOND constant and not covered by the bullet
		// cases: without narrowing `TASK`'s own trailing `\s*` the checkbox arm eats the
		// lead exactly as `LIST_BULLET`'s did and these stay silenced.
		["pin-nrl116-task-eight-space-lead", "- [ ] Plain prose\n- [ ]        %%\n- [ ] SECRET", "Plain prose %% SECRET"],
		["pin-nrl116-task-five-space-lead", "- [x] Plain prose\n- [x]     %%\n- [x] SECRET", "Plain prose %% SECRET"],
		//
		// TRIPWIRES ON WHAT THIS DOES NOT CLOSE. Each is measured IDENTICAL on both
		// sides of NRL-116 and each must change on purpose when its own root closes.
		//
		// 1. `-` + TAB with NO space (Q40) and the bare `- %%` above are the same root:
		// the item's content really is `%%` at a block start, so the opener is right and
		// only the SCOPE is wrong. NRL-118 CLOSED THAT ROOT and moved this ON PURPOSE,
		// in place, name kept for its citations: the renderer ends the comment with the
		// item, so the next item's SECRET is displayed and now spoken. Was "Plain prose".
		["pin-nrl116-tab-no-space-after-marker-still-silenced", "- Plain prose\n-	%%\n- SECRET", "Plain prose SECRET"],
		// 2. EXACTLY FOUR spaces, where ` {1,4}(?! )` consumes the whole lead and the
		// body really is `%%` at offset 0 - so, again, a correct opener with the wrong
		// scope. This one is worth its own fixture because it is the cell that separates
		// "the lead was mis-peeled" (fixed here) from "the block's scope is note-wide"
		// (NRL-118): the renderer hides the `%%` and DISPLAYS SECRET. NRL-118 moved it
		// ON PURPOSE, in place and with its name kept, for the same reason as row 1.
		// Was "Plain prose".
		["pin-nrl116-four-space-lead-still-silenced", "- Plain prose\n-    %%\n- SECRET", "Plain prose SECRET"],
		// 3. THE `<!--` TWIN IS NOT FIXED, and that is the one place a reader is most
		// likely to assume otherwise. `opensHtmlBlock` accepts a tab deliberately -
		// module 8776's skip loop takes spaces AND tabs, so that is right for a `<!--`
		// in a FRESH block - but on a list marker line the item's content indent makes
		// it indented code before the HTML tokenizer is reached, and we do not model the
		// indent AMOUNT. Same root as NRL-93's boolean-`dedentedByList` residual, which
		// is NRL-117's, not this ticket's.
		// NRL-115 moved it in place: its container model does dedent the item's content
		// indent, sees `\t<!--` as indented code inside the item, and refuses the opener,
		// so SECRET is spoken as the renderer displays it (HTML:
		// `<li><pre><code>&#x3C;!--</code></pre></li><li>SECRET</li>`). The `<!--` itself
		// is spoken as prose where the renderer shows it as code, so `skipCodeBlocks`
		// does not skip it: displayed text either way, not a disclosure, and the
		// indent-amount modelling for the `%%` twins above is still NRL-117's.
		["pin-nrl116-html-twin-tab-lead-still-silenced", "- Plain prose\n- 	<!--\n- SECRET", "Plain prose <!-- SECRET"],
		//
		// GUARDS FOR Q38, THE SINGLE LARGEST RISK IN THIS CHANGE. NRL-131's
		// indented-code stop used to read the PEELED string's trailing whitespace run;
		// under a narrowed lead that run is at most four spaces or one tab, so the stop
		// stops firing and NRL-131 regresses. It is RELOCATED onto the REMAINING BODY.
		// These are green on BOTH sides of the shipped change and so are not evidence of
		// it - they are the mutation target: with the stop left where it was, every one
		// of them goes red, measured at 72,704 newly-lost cells of 98,304 on a
		// nested-quote corpus.
		["guard-nrl116-q38-nested-quote-tab-lead", "- Plain prose\n- 	> ZMARKZ x\n- after", "Plain prose > ZMARKZ x after"],
		["guard-nrl116-q38-nested-quote-five-space-lead", "- Plain prose\n-     > ZMARKZ x\n- after", "Plain prose > ZMARKZ x after"],
		["guard-nrl116-q38-nested-quote-four-space-lead", "- Plain prose\n-    > ZMARKZ x\n- after", "Plain prose ZMARKZ x after"],
		// The `marker + lead + > %%` shape the probe's own corpus was BLIND to (Q41):
		// the `>` is displayed as code content, so it is spoken, and the real opener is
		// never reached. Base and fix agree; without the relocation the body loses its
		// `>` and the following item goes quiet.
		["guard-nrl116-q38-nested-quote-comment-tab-lead", "- Plain prose\n- 	> %%\n- SECRET", "Plain prose > %% SECRET"],
		["guard-nrl116-q38-nested-quote-comment-five-space-lead", "- Plain prose\n-     > %%\n- SECRET", "Plain prose > %% SECRET"],
		["guard-nrl116-q38-task-nested-quote-tab-lead", "- [x] Plain prose\n- [x] 	> ZMARKZ x\n- [x] after", "Plain prose > ZMARKZ x after"],
		// The rest of the family, each RED on base faf55a3. Disclosure direction
		// first: a blank line ends a quote, a lazy line stays in a list item, and a
		// shallower quote ends the inner one, so each closing `%%` is really a new
		// opener for the renderer.
		["pin-nrl118-blank-ends-quote-then-new-block", "> %%\n\n%% SECRET", ""],
		["pin-nrl118-lazy-line-stays-in-item-then-new-block", "- %%\nlazy\n%% after", ""],
		["pin-nrl118-shallower-quote-opens-new-block", ">> %%\n> %% after", ""],
		// Prose-loss direction: the container ends at a line the renderer displays,
		// so base hid displayed text up to a mid-line `%%` and spoke only the tail.
		["pin-nrl118-heading-ends-quote", "> %%\n# head\nx %% y", "head x %% y"],
		["pin-nrl118-new-ordered-item-ends-block", "1. %%\n2. x %% y", "x %% y"],
		["pin-nrl118-blank-then-unindented-ends-item", "- %%\n\nmore\n%% after", "more"],
		["pin-nrl118-empty-inner-quote-line-ends-inner", ">> %%\n>\n> x %% y", "x %% y"],
		["pin-nrl118-blank-ends-quote-inside-item", "- > %%\n\n  > x %% y", "x %% y"],
		// Guards, green on base and on the fix and NOT counted as evidence. Each is a
		// shape where the renderer keeps the block OPEN across the line, so a scope
		// rule that ends too eagerly would newly speak hidden text in it.
		["guard-nrl118-empty-quote-line-keeps-block", "> %%\n>\n> x %% y", "y"],
		["guard-nrl118-nested-item-keeps-block", "- %%\n  - x %% y", "y"],
		["guard-nrl118-deeper-quote-keeps-block", "> > %%\n> > > x %% after", "after"],
		["guard-nrl118-indented-line-keeps-quote-in-item", "- > %%\n  x %% y", "y"],
		["guard-nrl118-blank-then-indented-keeps-item", "- %%\n\n  x %% y", "y"],
		["guard-nrl118-lazy-quote-line-keeps-block", "> %%\nlazy x %% y", "y"],
		["guard-nrl118-same-quote-per-line-opener", "> %%\n> ZHIDEZ\n> %%\n> ZPROSEZ tail.", "ZPROSEZ tail."],
		// The container a block belongs to is not always on the opener's own line,
		// and each of these was a disclosure on base. A lazy `> ...` line inside a
		// list item opens a quote INSIDE the item (blockquote interrupts the
		// paragraph it is folded into), and `- - %%` / `  - A` / `   %% Q2` opens in
		// the OUTER item, which no reading of the `   %%` line alone can tell. The
		// renderer's own tokenizer, re-run by obsidianBlocks.ts, settles both.
		// RED on base.
		["pin-nrl118-lazy-quote-opens-inside-item", "- item0\n> %%\n  %% SECX\nTAILX", "item0"],
		["pin-nrl118-lazy-quoted-list-inside-item", "- item0\n> - %%\n> %% SECX\nTAILX", "item0"],
		["pin-nrl118-opener-in-outer-item", "- - %%\n  - A\n   %% Q2\n- Q3 tail\n\n> - %%\nQend", "A Q3 tail"],
		// The renderer dedents an item's content by whole characters, so a tab that
		// starts exactly at the content column survives and is indented code that
		// ENDS the quote, while one that overshoots is removed. RED on base.
		["pin-nrl118-tab-kept-after-item-dedent-ends-quote", "- > %%\n  \tX %% Y", "X %% Y"],
		// A marker whose own lead reaches indented-code depth makes the item CODE, so
		// its `%%` is literal and opens nothing (NRL-116's peel). Both rows: the
		// renderer shows only "%%". The first was "" on base and the second "w",
		// which the renderer hides - a disclosure on base, closed here because the
		// quoted `%%` blocks around them now end with their quotes.
		["pin-nrl118-code-lead-marker-keeps-percent-literal", "> %% w\n* \t%%\n> - %%\n> \tprose ZS", "%%"],
		["pin-nrl118-code-lead-ordered-marker-keeps-percent-literal", "-  %%\n* %% w\n> - %%\n2.  \t%%\n>> %% ZS", "%%"],
		// A line that ends an indented code block is read normally, markers
		// included, so the `> - %% ZM` block is scoped to its own item. Base spoke
		// ZM, which the renderer hides. RED on base. REPLACED IN PLACE by the NRL-118
		// fix pass: the expectation was "b after ZT. ZQ tail.", which dropped
		// `Before a ZA`. The reading view DISPLAYS that line (the four-space lazy line
		// ends the quote as indented code, so the first `%%` comment ends on line 1),
		// and the renderer-transcribed scope now speaks it. The backticks go because
		// our code-span carry pairs them across the lines; the renderer shows them as
		// code text, a pre-existing difference in how the text is spoken, not in
		// whether it is.
		["pin-nrl118-block-after-indented-code-is-scoped", "> - %%\n    Before `a ZA\n> - %% ZM\n> - b` after ZT.\nZQ tail.", "Before a ZA b after ZT. ZQ tail."],
		// GUARDS, each green on base and on the fix. `interruptBlockquote`'s
		// indentedCode is module 134's literal test, four spaces or a tab at offset 0
		// ONLY: one to three spaces then a tab is lazy text inside the quote (a
		// column-model arm reusing INDENTED_CODE's ` {0,3}\t` spoke X here). And a tab
		// that overshoots the item's dedent is removed whole by remove-indentation.
		["guard-nrl118-spaces-then-tab-is-lazy-in-quote", "> %%\n   \tX %% Y", "Y"],
		["guard-nrl118-overshooting-tab-removed-by-dedent", "- > %%\n   \tX %% Y", "Y"],
		// NRL-118 SHIP REVIEW. Four NEW disclosures the first (column-model) revision
		// of this fix opened, each found by an independent fuzz and a column census
		// against real rendered HTML, each "" on base (base's note-scoped block hid
		// it) and each speaking SECRET on that revision. Every expectation is the
		// reading view's visible text, which is empty in all of them. The rows stay
		// as regression pins; the transcribed tokenizer gets each right by
		// construction rather than by a rule written for it.
		//
		// A thematic break is no list item: `- ---` and `* * *` render `<hr>`, so
		// the `  %%` below opens a top-level block. Reading the HR as a list
		// container scoped that block to a list that does not exist.
		["pin-nrl118-ship-hr-line-is-no-list-container", "- ---\n  %%\n1) --> SECRET", ""],
		["pin-nrl118-ship-spaced-hr-line-is-no-list-container", "* * *\n  %%\n- SECRET", ""],
		// A `-` or `*` break indented EXACTLY one column short of the item's content
		// column stays in the item (`- a` / ` ---` renders `<li><h2>a</h2>`, a setext
		// heading inside the item), measured for content columns 2 to 5.
		["pin-nrl118-ship-hr-one-column-short-stays-in-item", "- %%\n ---\nSECRET", ""],
		["pin-nrl118-ship-star-hr-one-column-short-stays-in-ordered-item", "1. %%\n  ***\nSECRET", ""],
		// A tab after a break: module 6968 allows only spaces between and after the
		// markers, so `---\t` is no break and the line is lazy text inside the open
		// block.
		["pin-nrl118-ship-hr-trailing-tab-not-an-interrupter", "- %%\n---\t\nSECRET", ""],
		["pin-nrl118-ship-hr-trailing-tab-in-quote", "> %%\n---\t\nSECRET", ""],
		// A TRIPWIRE, REPLACED IN PLACE by the NRL-118 fix pass, and the old comment
		// here was WRONG: it said a tab after a block tag name is no interrupter. It
		// is one. Module 8776's type-6 test is `(?=(\s|/?>|$))` and `\s` takes the
		// tab, so `<div\tx` ENDS the quote (and the comment with it), exactly like
		// `<div x`; the parser itself agrees (its comment node ends on line 1). What
		// keeps SECRET off the screen is something else: `<div\tx` / `SECRET` becomes
		// a raw HTML block, passed through unterminated, and the browser swallows it
		// as a tag. We speak raw HTML block text, comment or no comment - the control
		// below, with no `%%` at all, speaks SECRET on base and on the fix alike - so
		// this is that PRE-EXISTING root unmasked, not a scope error. Was "" (base's
		// note-scoped block hid it). MUST CHANGE ON PURPOSE when raw HTML blocks are
		// modelled.
		["pin-nrl118-ship-tab-after-tag-not-html", "> %%\n<div\tx\nSECRET", "<div x SECRET"],
		["guard-nrl118-unterminated-tag-control-no-comment", "> x\n<div\tx\nSECRET", "x <div x SECRET"],
		// Found by the same fuzz once the rows above were fixed, reduced by line
		// deletion. Each was "" or hid SECRET on base and spoke it on the first
		// revision. `-\t---` is a list item HOLDING a break (the renderer refuses a
		// tab in a break), and dropping that outer layer is NOT fail-closed: the
		// layer is what strips the indent the inner quote then sees.
		["pin-nrl118-ship-tab-hr-item-keeps-list-layer", "-\t---\n> %%\n    A SECRET", "", { skipCodeBlocks: false }],
		// A setext underline must sit inside every item enclosing the quote: the
		// col-0 `---` here ends the item, so it underlines nothing in the quote.
		["pin-nrl118-ship-setext-lookahead-respects-item", "- a\n> %%\n\tSECRET\n---", "a"],
		// And inside every enclosing QUOTE, non-lazily: a col-0 `---` has no `>`, so
		// it is a break outside the outer quote, not an underline inside it.
		["pin-nrl118-ship-setext-lookahead-respects-outer-quote", ">> %%\n>| SECRET |\n---", ""],
		// Only `1.` (or a bullet) interrupts a paragraph, so `2. Two.` is paragraph
		// text and opens no container; the `   %%` block below is top-level.
		["pin-nrl118-ship-ordered-continuation-opens-no-item", "   Prose one.\n2. Two.\n   %%\n- SECRET", "Prose one. Two."],
		// A TRIPWIRE and not evidence. A `%%` after such a marker is mid-line text
		// for the renderer, which shows `2. %%` and SECRET; we still open a block
		// there and hide SECRET, exactly as base does (pre-existing, fail-closed).
		// Keeping it literal was tried at ship review and REVERTED: the only
		// signals for "a paragraph is open" (prevPara, prevContainer) also fire
		// after `>---` and inside an HTML comment, and trusting them newly spoke
		// hidden text in 32 reduced fuzz notes. MUST CHANGE ON PURPOSE when a
		// reliable open-paragraph signal exists.
		["pin-nrl118-ship-percent-after-continuation-marker-still-hidden", "Prose.\n2. %%\nSECRET", "Prose."],
		// A marker indented four or more columns is indented CODE, not an item, so
		// it opens no container: the `>  %%` block below is a top-level quote's,
		// and the lazy `2. > SECRET` stays inside it.
		["pin-nrl118-ship-code-indented-marker-opens-no-item", "    - a\n>  %%\n2. > SECRET", ""],
		// Inside `- <!--` ... `-->` the renderer stays in the item across `2. Q1`, so
		// the lazy `>> %%` block is inside the item and the tab-led line is item
		// content, hidden. A column model that read the hidden `2. Q1` as ending the
		// item scoped the block too narrowly; the transcribed tokenizer never sees a
		// hidden line as anything but the HTML it is.
		["pin-nrl118-ship-container-ended-under-comment-taints-scope", "- <!--\n2. Q1\n--> Q2\n>> %% Q3\n\tSECRET` B", "Q2", { skipCodeBlocks: false, skipInlineCode: false }],
		// The renderer has NO `%%` comment here: `  - %% shown` is content of the HTML
		// block `* <div>` opens inside the item. Our block on that line is therefore
		// one the renderer does not have, and the scope rule never touches such a
		// block (it is consulted only where both parsers open one), so it stays
		// note-scoped, which is base's answer. The renderer DISPLAYS `- %% shown` as
		// raw HTML text; losing it is the pre-existing HTML-in-item gap, unchanged.
		["pin-nrl118-ship-hidden-html-opener-keeps-block", "* <div>\n  - %% shown\n<!--\n- > SECRET", ""],
		// GUARDS, green before and after the ship-review change and not counted:
		// each is a break the renderer DOES end the container on, so SECRET is
		// displayed. They stop the narrowing becoming "an HR never ends a scope".
		["guard-nrl118-ship-unindented-hr-ends-item", "- %%\n---\nSECRET", "SECRET"],
		["guard-nrl118-ship-underscore-hr-one-short-ends-item", "- %%\n ___\nSECRET", "SECRET"],
		["guard-nrl118-ship-hr-ends-quote", "> %%\n---\nSECRET", "SECRET"],
		// NRL-118 wrote this as a TRIPWIRE whose expectation "MUST CHANGE ON PURPOSE
		// when that boolean becomes an indent", and NRL-117 is the ticket that made it
		// an indent, so it changed here - on purpose, and to an oracle-derived value
		// rather than to whatever turned it green. NRL-118's reading of the renderer
		// was right: `2. \t%%` / 8 spaces + `%% S` renders to
		// `<ol start="2"><li><pre><code>%%\n%% S\n</code></pre></li></ol>`, so the
		// renderer has NO comment on either line and shows BOTH as code. Base spoke
		// only `%%`, losing the displayed `%% S`, because `dedentedByList` was a
		// boolean and our block opened on the second line. With the dedent an amount,
		// the 8-space lead no longer reaches a block start and no block opens, so the
		// displayed text comes back: the new expectation EQUALS the renderer's own
		// visible text, measured. So this row stops being a residual and becomes a
		// prose-loss CLOSURE - and the residual that remains on it is a different and
		// narrower one, namely that we speak as prose what the renderer shows as CODE,
		// which is `skipCodeBlocks` being unreachable here for the reason srs.md's
		// `%%` bullet records, not the indent. Still tracked: the `> >` + tab sibling
		// is NRL-114 (its 8 quote-in-list cells are scoped out of NRL-117), and a
		// fence on a list marker line plus fences not ending with their container is
		// NRL-159.
		["pin-nrl118-residual-deep-item-content-opener", "2. \t%%\n        %% S", "%% %% S"],
		// NRL-118 FIX PASS. An independent Verify FAILED the column-model revision of
		// this fix (26cd7ed) for seven shapes it newly SPOKE that the reading view
		// hides, none reducible to a pre-existing root. These are those seven, as
		// Verify reduced them, plus siblings varying the marker, the lead and the
		// tab. Every row was RED against 26cd7ed and every expectation is checked
		// against real rendered HTML: the reading view hides SECRET in all of them
		// (the `*` the last three speak is a pre-existing, unrelated `* * *` item
		// reading, identical on base). Each one is a place where the renderer's
		// rules are not column rules: a list item's content is dedented by the
		// SMALLEST indent of its lines (module 5540) with `1.` counting one column
		// wider than `1)` (module 745's odd-length rule), a lazy line is judged by
		// the PARENT's text, a blank line ends an item before any break can, and a
		// quote's indented-code interrupter is module 134's literal test on the text
		// the quote actually receives. obsidianBlocks.ts re-runs those modules
		// rather than approximating them.
		["pin-nrl118-v1-quote-in-ordered-item-spaces-tab", "1. > %%\n   \tSECRET", ""],
		["pin-nrl118-v1-indented-ordered-tab", "  1. > %%\n\tSECRET", ""],
		["pin-nrl118-v4-lazy-quote-after-first-item", "1. x\n> %%\n   \tSECRET", "x"],
		["pin-nrl118-v2-indented-ordered-four-spaces", "  1. > %%\n    SECRET", ""],
		["pin-nrl118-v3-three-space-bullet-tab", "   - > %%\n\tSECRET", ""],
		["pin-nrl118-v3-three-space-bullet-four-spaces", "   - > %%\n    SECRET", ""],
		["pin-nrl118-v3-three-space-star-tab", "   * > %%\n\tSECRET", ""],
		["pin-nrl118-v3-three-space-ordered-tab", "   1. > %%\n\tSECRET", ""],
		["pin-nrl118-v4-lazy-quote-after-ordered-item", "2. x\n> %%\n   \tSECRET", "x"],
		["pin-nrl118-v5-blank-then-one-short-dash-break", "-   %% x\n\n   ---\nSECRET", ""],
		["pin-nrl118-v5-blank-then-one-short-bare", "- %%\n\n ---\nSECRET", ""],
		["pin-nrl118-v5-blank-then-one-short-star", "-  %% x\n\n  ***\nSECRET", ""],
		["pin-nrl118-v5-blank-then-one-short-ordered", "1.  %% x\n\n   ---\nSECRET", ""],
		["pin-nrl118-v6-tab-nested-item-in-quote", "> - \n  \t- %%\n     # SECRET", ""],
		["pin-nrl118-v6-space-tab-nested-item-in-quote", "> - \n \t- %%\n     # SECRET", ""],
		["pin-nrl118-v7-break-item-then-nested-quote", "-    * * *\n>> %% x\n    SECRET", "*"],
		["pin-nrl118-v7-break-item-then-quote", "-    * * *\n> %% x\n    SECRET", "*"],
		["pin-nrl118-v7-break-item-then-nested-quote-tab", "-    * * *\n>> %% x\n\tSECRET", "*"],
		// And the other direction, so the fix cannot be "keep the block open":
		// siblings of the same shapes where the reading view DISPLAYS SECRET. All
		// five hid it on base (prose loss closed here).
		["pin-nrl118-v1-paren-ordered-is-no-quote-interrupter", "1) > %%\n   \tSECRET", "SECRET"],
		["pin-nrl118-v1-bullet-two-spaces-tab", "- > %%\n  \tSECRET", "SECRET"],
		["pin-nrl118-v5-underscore-break-ends-item", "-   %% x\n\n   ___\nSECRET", "SECRET"],
		["pin-nrl118-v6-four-space-heading-is-in-quote", "> - \n  \t- %%\n    # SECRET", "# SECRET"],
		["pin-nrl118-v7-dash-break-is-no-list", "-    - - -\n>> %% x\n    SECRET", "SECRET"],
		// A TRIPWIRE and not evidence: the one shape behind the only newly-lost cells
		// in the fix pass's 600,000-note fuzz that subset control did not attribute
		// (3 cells). `-    %%` opens a comment that the renderer ends with the item, so
		// `    %% PROSE` is read afresh, and the reading view shows it as indented
		// code. We open a block on it, so PROSE goes quiet, where base happened to
		// close its note-scoped block there and speak it. Pre-existing and
		// fail-closed: the control below, with the first `%%` neutralised, loses
		// PROSE on base and on the fix alike.
		//
		// This comment used to attribute the root to "NRL-117's boolean
		// `dedentedByList`" and to predict that the expectation "MUST CHANGE ON
		// PURPOSE when NRL-117 closes". NRL-117 has closed (`d53aa1d`) and the
		// prediction DID NOT COME TRUE, so both halves are corrected rather than
		// left standing. Measured by bundling the real extractor at `d53aa1d` and at
		// its parent `dad8de2`: this row, its 3-space sibling and the control below
		// all speak the same on BOTH arms, and a 5-space lead speaks PROSE on both
		// too - so "the boolean could not tell leads apart" is not the explanation
		// either. The live root is the one the deep-item-content pin above records:
		// the dedent term correctly reports a block start while the renderer reads
		// the line as indented CODE, and nothing routes it to the code exclusion, so
		// `skipCodeBlocks` cannot reach it. That is not the indent.
		["pin-nrl118-residual-code-depth-line-after-item", "-    %%\n    %% PROSE", ""],
		["guard-nrl118-residual-code-depth-line-after-item-control", "-    xx\n    %% PROSE", "xx"],
		// NRL-117. `listDedented` stopped being "this line is list content, so keep
		// the old any-whitespace rule" and became that CONJOINED with "and the item's
		// own dedent really does leave the lead at the block start a `%%` opener
		// needs". The predicate `opensObsidianBlock` is UNTOUCHED - its body is
		// byte-identical and its 263,672-triple structural proof still holds - and the
		// whole change is one extra term on the pass's boolean plus the three helpers
		// that compute it (`leadStops`, `listDedentCut`, `itemHeadCols`).
		//
		// THE MODEL, and why it is a STACK of character cuts rather than a column
		// subtraction. NRL-93 named the faithful rule and declined to approximate it;
		// an early arm for this ticket shipped the obvious approximation,
		// `columnsOf(lead) - itemContentIndent <= 3`, and a 3,021,824-cell census
		// DISCLOSED 7,168 cells in one shape - `- outer` / `  - inner` / `\t\t%%`,
		// where module 745 nests so the dedent runs TWICE, and module 5540's budget is
		// in columns while its cut is in CHARACTERS so each pass removes a whole tab.
		// Two two-column budgets therefore take both tabs and land on column 0: the
		// block really does open, the renderer really does hide the rest, and
		// `8 - 4 = 4` says the opposite. `guard-nrl117-nested-double-tab-correctly-hides`
		// is that counter-example, kept as a guard rather than as a fix.
		//
		// Every `pin-nrl117-` row below was RED against base 9bdc74c and every
		// `guard-nrl117-` row was green on both sides. The oracle is real rendered
		// HTML from Obsidian 1.13.7's own parser and renderer executed in Node
		// (app.js sha256 8efbf581...9898), not a transcription. NOT OBSERVED IN A
		// RUNNING OBSIDIAN - rule 11 applies to all of it.
		["pin-nrl117-six-space-in-list", "- item\n      %%\nSECRET", "item %% SECRET"],
		["pin-nrl117-two-space-tab-in-list", "- item\n  	%%\nSECRET", "item %% SECRET"],
		["pin-nrl117-triple-tab-in-list", "- item\n			%%\nSECRET", "item %% SECRET"],
		["pin-nrl117-tab-then-four-spaces-in-list", "- item\n	    %%\nSECRET", "item %% SECRET"],
		["pin-nrl117-ordered-deep-indent", "1. item\n        %%\nSECRET", "item %% SECRET"],
		["pin-nrl117-task-deep-indent", "- [ ] item\n        %%\nSECRET", "item %% SECRET"],
		// Nesting, which is the half a single subtraction cannot express. The budget
		// at each level is measured in the coordinate space the levels above it leave.
		["pin-nrl117-nested-deep-indent", "- outer\n  - inner\n        %%\nSECRET", "outer inner %% SECRET"],
		["pin-nrl117-nested-triple-tab", "- outer\n  - inner\n			%%\nSECRET", "outer inner %% SECRET"],
		["pin-nrl117-three-levels-deep-indent", "- outer\n  - mid\n    - inner\n            %%\nSECRET", "outer mid inner %% SECRET"],
		// A list inside a blockquote, where the quote peel runs FIRST and is the right
		// order - the one shape where our peel and the renderer agree about it.
		["pin-nrl117-list-in-quote-deep-indent", "> - item\n>         %%\n> SECRET", "item %% SECRET"],
		["pin-nrl117-item-after-blank-deep-indent", "- item\n\n        %%\nSECRET", "item %% SECRET"],
		["pin-nrl117-lazy-continuation-deep-indent", "- item\nlazy\n        %%\nSECRET", "item lazy %% SECRET"],
		// FOUR of Q15's six "blockquote nested in a list item" cells DO close here,
		// and these are them: a SPACE lead survives our `BLOCKQUOTE` peel, so the
		// dedent still has something to measure. The tab form does not and is
		// `pin-nrl93-quote-inside-list-still-silenced`, which NRL-114 owns.
		["pin-nrl117-quote-in-list-deep-indent-closes", "- item\n  > Plain\n  >         %%\n  > SECRET", "item Plain %% SECRET"],
		// A setext underline AFTER a declined opener. The refusal makes the `%%` line
		// literal prose, so the `===` really is that paragraph's second line and the
		// renderer shows the lot.
		["pin-nrl117-setext-after-declined-opener", "- item\n        %%\n===\nSECRET\nTAILA", "item %% === SECRET TAILA"],
		// THE COUNTER-EXAMPLE THAT DISQUALIFIED THE SUBTRACTION. Green on both sides,
		// so it is evidence of nothing being broken rather than of anything being
		// fixed - but it is the one row in the suite that catches a regression to
		// column arithmetic, because that is the only shape where the two models
		// disagree in the DISCLOSURE direction.
		["guard-nrl117-nested-double-tab-correctly-hides", "- outer\n  - inner\n		%%\nSECRET", "outer inner"],
		["guard-nrl117-four-space-in-list-correctly-hides", "- item\n    %%\nSECRET", "item"],
		["guard-nrl117-five-space-in-list-correctly-hides", "- item\n     %%\nSECRET", "item"],
		["guard-nrl117-single-tab-in-list-correctly-hides", "- item\n	%%\nSECRET", "item"],
		// The five shapes the NRL-113 and NRL-114 blocks were caused by, carried here
		// because this pass feeds `interruptsParagraph` and therefore both lookaheads.
		["guard-nrl117-setext-underline-in-item", "- item\nHead text SECRET\n        ===\nTAILA", "item Head text SECRET === TAILA"],
		["guard-nrl117-quoted-setext-in-item", "- item\n  > Head SECRET\n  >         ===\n  > TAILA", "item Head SECRET === TAILA"],
		["guard-nrl117-marker-lead-quote-opener", "- 	> %%\nSECRET", "> %% SECRET"],
		["guard-nrl117-nested-quote-arrow-is-the-sentinel", "> > QARROW SECRET\n        %%\nTAILA", "QARROW SECRET %% TAILA"],
		["guard-nrl117-lone-percent-still-disqualifies", "- item\n        %% 50% off\nSECRET", "item %% 50% off SECRET"],
		["guard-nrl117-after-list-ends", "- item\n\npara\n\nother\n        %%\nSECRET", "item para other %% SECRET"],
		// THREE TRIPWIRES on divergences NRL-117 does NOT close. Each was identical on
		// both sides of NRL-117 (tripwire 1 has since moved with NRL-115, below), each
		// is prose loss and never disclosure, and each must change on purpose.
		//
		// 1. The `<!--` TWIN. `opensHtmlBlock` had no dedent term of any kind, so the
		// HTML-comment half of this family was untouched: the renderer displays
		// `<!--`, SECRET and TAILA here and NRL-117 hid all three. Same mechanism, a
		// different predicate, and deliberately not merged into one (D-73-4).
		// NRL-115 moved both in place, as this tripwire asked: its container model
		// (`rendererLeads`, a separate model from NRL-117's `listDedented`, feeding
		// `opensHtmlBlock` only) dedents the item and sees a lazy continuation still
		// led by four columns, which module 8607 absorbs without offering it to module
		// 8776. Re-checked against real rendered HTML from the executed reading-view
		// parser at the merge of the two tickets: `<li>item\n&#x3C;!--\nSECRET\nTAILA</li>`
		// for both leads, so all three lines are displayed and now spoken.
		["pin-nrl117-html-twin-deep-indent-still-silenced", "- item\n        <!--\nSECRET\nTAILA", "item <!-- SECRET TAILA"],
		["pin-nrl117-html-twin-double-tab-still-silenced", "- item\n		<!--\nSECRET\nTAILA", "item <!-- SECRET TAILA"],
		// 2. `interruptList` is not modelled. Obsidian puts `comment` in it, so a `%%`
		// line indented LESS than the item's content indent ENDS the list instead of
		// joining it, and is then indented code at document level - displayed. We take
		// it as item content and dedent it away. `-    item` budgets five columns, so a
		// four-space `%%` is shallower; so is a four-space one under `100. item` or
		// `   - item`. Measured at 22 cells of a 667-cell renderer-keyed sweep.
		["pin-nrl117-shallower-than-content-indent-still-silenced", "-    item\n    %%\nSECRET", "item"],
		["pin-nrl117-wide-ordered-marker-still-silenced", "100. item\n    %%\nSECRET", "item"],
		// 3. CLOSED BY NRL-162 (2026-10-03). This used to document the budget
		// being module 5540's `maximum` rather than the `p` it really uses (the
		// minimum indent over the item's own non-blank lines), and claimed that
		// over-estimating the dedent "keeps the pre-NRL-117 answer, which is the
		// fail-toward-hiding direction". That claim was FALSE: ` x` drops the
		// real budget to one column, so the renderer keeps four columns of lead
		// on the `%%` line and displays it as literal text - but the max budget
		// (2, from `- `) removed two columns, leaving a 3-column residual that
		// WRONGLY opened a block comment, hiding SECRET (a disclosure, not mere
		// prose loss, since this item has no later closing `%%` and the note
		// has none either, so nothing ever un-hides it). `extractChunks` now
		// computes the item's real `p` via a two-phase record-then-refold pass
		// (see `listDedented`'s own comment) and the residual is 4 columns,
		// declining the opener exactly as Obsidian does. Flipped in place,
		// keeping the name per house convention, even though "still silenced"
		// no longer describes it: re-derived against the real renderer
		// (`GT(WT(src))` on this exact source), which shows `item x %% SECRET`.
		["pin-nrl117-minimum-indent-not-maximum-still-silenced", "- item\n x\n     %%\nSECRET", "item x %% SECRET"],
		// THE ACCEPTED COST, per Q46, and it is the SAME TWO CLASSES this repo has
		// already documented rather than a new one. Declining a wrongly-recognised
		// opener lets `codeSpanClosesLater` CONFIRM a soft-wrapped span the base only
		// half-recognised, and the user's own `skipInlineCode` then silences it - 1,536
		// of 3,021,824 census cells, `skipInlineCode` true in every one, which is
		// NRL-73's ship-review class (`pin-nrl73-span-of-only-disqualified-openers`).
		// Four prose sentinels are RECOVERED in the same cell. The `speakImageAlt`
		// twin is ADR 0023 / NRL-88's designed alt-text class, 256 cells.
		["pin-nrl117-span-confirmed-then-excluded", "- item\nBefore `a SPANA\n        %%\nSPANB b` after TAILA\nSECRET", "item Before after TAILA SECRET"],
		["pin-nrl117-span-confirmed-then-spoken", "- item\nBefore `a SPANA\n        %%\nSPANB b` after TAILA\nSECRET", "item Before a SPANA %% SPANB b after TAILA SECRET", { skipInlineCode: false }],
		["pin-nrl117-label-confirmed-alt-excluded", "- item\nA ![alt LABELA\n        %%\nLABELB](zdestz.png) TAILA\nSECRET", "item A TAILA SECRET", { speakImageAlt: false }],
		// A SECOND accepted cost, and it is NRL-93's note-scope cost re-triggered rather
		// than a new class - but it IS newly lost text and must not be read as
		// pre-existing. Two ingredients, both already named. The budget here is module
		// 5540's `maximum` where the real `p` is lower, because ` -   ` has no content
		// after its marker so `M`'s rewritten first line trims to nothing and drops out
		// of the minimum, leaving `p` = 4 from the `\tSECRET` line; we use 5, remove one
		// column too many and accept an opener the renderer makes INDENTED CODE. And our
		// `%%` block is note-scoped (ADR 0006 clause 5), so base's wrongly-accepted
		// FIRST opener was being closed by this one, while declining the first leaves
		// this one reaching to end of note. It is a TRADE and not a pure regression:
		// `%%` and QARROW are recovered, SECRET and TAILA are lost, and the renderer
		// displays all four. Found only by the fuzz - the structured census carries one
		// comment construct per note by construction and reported ZERO cells of it -
		// which is the same way NRL-93 found its own 157-cell version.
		// NRL-114 CLOSED THE LOSS HALF OF THIS TRADE, replaced in place keeping the
		// name. The second `%%` sits on a container fresh-block line that module 134
		// makes indented code, and NRL-114's `htmlLeadCode` veto keeps a `%%` opener
		// there from opening, so SECRET and TAILA are spoken again. Renderer:
		// `<li><pre><code>%%</code></pre>SECRET<br>TAILA</li>`. The `%%` itself is
		// spoken under skipCodeBlocks for the same declined-line-as-prose reason as
		// guard-nrl114-setext-quote-tab-html-opener-spoken: a known miss, displayed
		// text, never hidden text. RED on base 9132c3b and on 7cdc7b7 alone.
		["pin-nrl117-scope-cost-contentless-marker", "- item\n		%%\nQARROW after.\n -   \n        %%\n	SECRET\nTAILA", "item %% QARROW after. %% SECRET TAILA"],
		// THE SAME MECHANISM IN THE DISCLOSURE DIRECTION, which is the one figure in this
		// ticket that must not be buried. ADR 0006 clause 5 used to scope an unterminated
		// `%%` block to the NOTE, where Obsidian scopes it to the construct holding it, so
		// our openers pair up in sequence. DECLINING one therefore shifts the parity of
		// every later one, and a block that used to cover lines X..Y now covers something
		// else: text the renderer hides can become spoken. NRL-93, NRL-116 and NRL-120
		// each narrowed this same predicate and are each exposed to it; NRL-93 reported 0
		// newly leaking cells, measured with a fuzz whose PRNG this ticket found to be
		// degenerate (it reported 12,000 notes and generated a few hundred).
		//
		// Measured on a 12,000-distinct-note fuzz x 8 option sets = 388,944 graded cells
		// against real rendered HTML, at base 9bdc74c: 146 newly disclosed in 11 notes
		// against 1,199 disclosures CLOSED, plus 491 newly lost against 8,475 closed.
		// (Implement recorded 144 / 1,204 / 512 / 8,530 on the same instrument and the
		// same seeded corpus; the difference is the four extra option-set masks the
		// re-measure had to pick. Same measurement, not a disagreement.)
		//
		// NRL-118 THEN SHIPPED THE CONTAINER RULE IN CLAUSE 5 AND SHRANK THIS COST.
		// Re-measured with the base as the only variable, same instrument and same seeded
		// corpus: 146 cells in 11 notes at 9bdc74c falls to 40 cells in 3 notes at
		// dad8de2, a 73% reduction, with disclosures closed rising 1,199 -> 1,255 and
		// newly lost falling 491 -> 301 against 8,483 closed. Net 8.2:1 in favour becomes
		// 31:1. The class is NOT empty: inside one container our openers still pair up in
		// sequence, so declining one still shifts the parity of the later ones there.
		//
		// ATTRIBUTED BY A CONTROLLED SWITCH rather than argued, and the switch holds on
		// both bases: capping the corpus at ONE `%%` construct per note gives 193,904
		// graded cells with NEW_DISCLOSURE 0 and NEW_LOSS 0 at dad8de2, and 0 and 0 at
		// 9bdc74c, so none of it comes from the dedent model and all of it from the
		// pairing. The 1,170 x 512 census, one construct per note by construction, is
		// byte-identical across the rebase (2,957,312 graded text cells, 0 newly
		// disclosed, 2,816 newly lost, 155,392 closed, 9,728 of 64,512 attribute cells
		// moved, on both bases), which is the same attribution reached a second way. The
		// model's own per-line faithfulness is the other half of the control: an ARBITRARY
		// refusal-only narrowing of the same boolean discloses 1,424 cells at the same
		// one-construct cap where this one discloses 0, and Q43's disqualified
		// single-subtraction arm discloses 24 there.
		//
		// This note carries BOTH directions at once, which is why it is the one pinned:
		// PROSEB is hidden by the renderer and newly spoken, TAILA is displayed by it and
		// newly silenced. Reduce it and the effect reverses - every smaller arrangement
		// tried has the fix strictly better - so it must be pinned whole. Both of those
		// per-sentinel directions were re-derived at the rebase and are UNCHANGED on
		// dad8de2, so this note is one of the 3 that survive NRL-118's narrowing.
		//
		// CLOSED IN BOTH DIRECTIONS by NRL-114's fix round 1 and replaced in place
		// keeping its name: the expectation is now the executed renderer's text
		// exactly (PROSEB not spoken, TAILA spoken). `>\t%%` is a quote nested in
		// the item, which the item does not dedent, and the narrower peel leaves the
		// tab in its body, so it is code (`<blockquote><pre><code>%%`) and no opener;
		// the pairing that disclosed PROSEB and silenced TAILA is gone with it.
		["pin-nrl117-note-scope-parity-discloses", "  -	item SECRET\n	    %%\nQARROW after.\n>	%%\n   SECRET b after TAILA\n   %%\n			- [ ] item PROSEB", "item SECRET %% QARROW after. %% SECRET b after TAILA"],
		// NRL-120 PART 1. Term 1 of the HTML-comment rule needs block position: a
		// line-start `<!--` whose NEXT line is an exact setext underline is not an
		// HTML block at all, because `blockMethods` runs `setextHeading` (index 10)
		// before `html` (index 11) and module 8671 takes the `<!--` line as the
		// heading's one content line. Measured against real rendered HTML out of the
		// installed obsidian.asar 1.13.7 (app.js sha256 8efbf581...9898):
		// `<!--` / `===` / `HIDDENA` is
		// `<h1 data-heading="<!--">&#x3C;!--</h1><p>HIDDENA</p>`, so the heading
		// text and everything after it are DISPLAYED. We hid all of it. Decision Q1:
		// the heading speaks its literal `<!--`, delimiters included, as NRL-74's
		// mid-line opener already does. Every row below was RED against base
		// f250ddd and each expectation is what the reading view shows. NOT OBSERVED
		// IN A RUNNING OBSIDIAN; the harness executes the shipped parser in Node.
		["pin-nrl120-h1-literal-opener", "<!--\n===\nHIDDENA\nmore", "<!-- HIDDENA more"],
		["pin-nrl120-h1-closer-later", "<!--\n===\nHIDDENA\n--> t.", "<!-- HIDDENA --> t."],
		["pin-nrl120-h1-single-eq", "<!--\n=\nHIDDENA\n--> t.", "<!-- HIDDENA --> t."],
		["pin-nrl120-h2-single-dash", "<!--\n-\nHIDDENA\nmore", "<!-- HIDDENA more"],
		["pin-nrl120-h2-dash-pair", "<!--\n--\nHIDDENA\n--> t.", "<!-- HIDDENA --> t."],
		["pin-nrl120-h2-dash-run", "<!--\n---\nHIDDENA\n--> t.", "<!-- HIDDENA --> t."],
		// The Q7 shape: the `<!--` interrupts `Intro.` (html is in
		// `u.interruptParagraph`), and the block it starts is then a heading. The
		// term-2 pass calls that `===` a third content line, so the refusal has to
		// gate both terms and not term 1 alone.
		["pin-nrl120-after-paragraph", "Intro.\n<!--\n===\nHIDDENA\n--> t.", "Intro. <!-- HIDDENA --> t."],
		["pin-nrl120-lead-spaces", "  <!--\n===\nHIDDENA\n--> t.", "<!-- HIDDENA --> t."],
		["pin-nrl120-after-setext", "PROSEP\n===\n<!--\n===\nHIDDENA\n--> t.", "PROSEP <!-- HIDDENA --> t."],
		["pin-nrl120-heading-text-shown", "<!-- SECRETH\n===\nHIDDENA\n--> t.", "<!-- SECRETH HIDDENA --> t."],
		["pin-nrl120-crlf-underline", "<!--\n===\r\nHIDDENA\r\n--> t.", "<!-- HIDDENA --> t."],
		["pin-nrl120-skip-headings", "<!--\n===\nHIDDENA\n--> t.", "HIDDENA --> t.", { skipHeadings: true }],
		// The container forms. The spoken `===` is NOT new: a quoted or listed setext
		// heading has always spoken its underline here (`> Title` / `> ===` says
		// "Title ===" on base), because the setext branch never runs on a container
		// line. What moved is HIDDENA, which the reading view displays.
		["pin-nrl120-quote", "> <!--\n> ===\n> HIDDENA\n> --> t.", "<!-- === HIDDENA --> t."],
		["pin-nrl120-list", "- <!--\n  ===\n  HIDDENA\n  --> t.", "<!-- === HIDDENA --> t."],
		// Guards: each is a shape where the renderer DOES open an HTML block, so the
		// refusal must not fire. All green on base and on the fix; labelled guards,
		// not counted. Each names the measured disclosure it stands in front of.
		//
		// Not exact underlines: module 8671 refuses leading or trailing whitespace.
		["guard-nrl120-indented-eq-not-an-underline", "<!--\n ===\nHIDDENA\n--> t.", "t."],
		["guard-nrl120-trailing-space-not-an-underline", "<!--\n===  \nHIDDENA\n--> t.", "t."],
		["guard-nrl120-spaced-dashes-not-an-underline", "<!--\n- - -\nHIDDENA\n--> t.", "t."],
		["guard-nrl120-quote-two-spaces-not-an-underline", "> <!--\n>  ===\n> HIDDENA\n> --> t.", "t."],
		// A second content line: the `<!--` line opened an HTML block and `===` is
		// inside it, not under it.
		["guard-nrl120-underline-not-next-line", "<!--\nmore\n===\nHIDDENA\n--> t.", "t."],
		// A tab-led `<!--` after a paragraph is a lazy continuation, never a setext
		// content line. The `^\s*<!--` arm newly spoke HIDDENA in 8,640 census cells.
		["guard-nrl120-tab-lead-is-lazy", "Intro.\n\t<!--\n===\nHIDDENA\n--> t.", "Intro. t."],
		// Inside a list a lone `-` is a new ITEM, not an underline, so the `<!--`
		// stays raw HTML in the first item. Without the listDedented veto: 2,304
		// census cells newly spoken.
		["guard-nrl120-lazy-list-dash-is-an-item", "- item\n<!--\n-\nHIDDENA\n--> t.", "item t."],
		// Inside a raw HTML block the `<!--` is emitted raw. Without the rawHtml
		// state: 22,656 census cells newly spoken.
		["guard-nrl120-inside-html-block", "<div>\n</div>\n<!--\n=\nHIDDENA\n--> t.", "t."],
		// The remainder of a comment's closing line is still inside that HTML block
		// for the renderer, so appendRemainder must not be handed the setext answer.
		["guard-nrl120-remainder-not-refused", "<!--\nx\n<!-- y --> <!--\n===\nHIDDENA\nmore", ""],
		// The refused line still STARTS a block, so the paragraph above is flushed
		// first and only the `<!--` line becomes the heading. Without the flush the
		// underline turned the whole buffer into a heading and skipHeadings dropped
		// SEEN, which the renderer displays: found by the fuzz, not the census.
		["pin-nrl120-paragraph-above-is-not-heading", "SEEN\n<!--\n===\nHIDDENA", "SEEN HIDDENA", { skipHeadings: true }],
		// A BARE marker is a list item too (module 745 accepts `-` with nothing
		// after it), and inside a list a lone `-` is the next item, not an
		// underline. `listDedented` misses bare markers; `listInRun` catches it.
		["guard-nrl120-bare-marker-dash-is-an-item", "-\n<!--\n-\nHIDDENA\n--> t.", "- t."],
		// Module 5540 strips the SMALLEST non-zero indent across a list item's
		// lines, so the later ` ===` re-indents `  -` to ` -` and the `<!--` stays
		// raw HTML. The scan in isSetextContentLine's list branch refuses that.
		["guard-nrl120-list-dedent-follows-the-item", "- <!--\n  -\nHIDDENA\n<div>\n ===", ""],
		["pin-nrl120-list-dash-underline", "- <!--\n  -\n  HIDDENA", "<!-- - HIDDENA"],
		// A ` \t<!--` is a raw HTML comment block to the renderer and indented code
		// to us (NRL-93 / NRL-115's divergence, not fixed here). The refusal must
		// not reach inside it: SECRETH and HIDDENA are both hidden.
		["guard-nrl120-no-refusal-inside-tab-led-block", " \t<!--\n<!-- SECRETH\n--\nHIDDENA", ""],
		// CLOSED BY NRL-136, replaced in place with the names kept (the NRL-66/NRL-67
		// convention). These were NRL-120's tripwires for the pre-existing same-line
		// reopen disclosure: a line that starts an HTML comment block and closes it
		// on the same line (`<!-- y -->`) ends that block at the end of the line, so
		// a further unclosed `<!--` on it is RAW HTML that hides the rest of the note
		// in the reading view. NRL-136 now hides it. Renderer verdicts (parser
		// harness, oracle111): `<!-- SECRETH` / `---` / ... renders an `<h2>` showing
		// `<!-- SECRETH` and hides HIDDENA; `SEEN` / `---` / ... shows SEEN only.
		// NRL-120 Verify blockers. The `$$` stop kept the `<!--` literal, which
		// let the line after it be read as a setext underline, and skipHeadings
		// then dropped the displayed paragraph. Obsidian 1.13.7's MarkdownRenderer
		// (2026-10-01) renders A as `<p>Prose VISIBLEP &lt;!--<br>===</p>` then
		// math, and B as a raw `<div>` block showing VISIBLED. Both were RED on
		// 8add7ba (`$$ VISIBLEM --> t.` and `$$ HIDDENM --> t.`). B's HIDDENM is
		// the NRL-137 raw-HTML class, already recorded as an unmasking; what this
		// pins is that VISIBLED is spoken.
		["pin-nrl120-setext-needs-exact-underline", "Prose VISIBLEP <!--\n ===\n$$\nVISIBLEM --> t.", "Prose VISIBLEP <!-- === $$ VISIBLEM --> t.", { skipHeadings: true }],
		["pin-nrl120-setext-needs-one-content-line", "<div>\nVISIBLED\n<div><!--\n===\n$$\nHIDDENM --> t.", "VISIBLED <!-- === $$ HIDDENM --> t.", { skipHeadings: true }],
		["pin-nrl120-unmasked-same-line-reopen", "<!-- SECRETH\n---\n<!-- y --> <!--\nHIDDENA", "<!-- SECRETH"],
		["guard-nrl120-same-line-reopen-on-base", "SEEN\n---\n<!-- y --> <!--\nHIDDENA", "SEEN"],
		// Three more unmaskings, found by NRL-120's Ship census (73,728 newly
		// speaking cells over 144 rows x 512 content-key combinations, every one of
		// them reproduced on base by replacing the heading's `<!--` with plain text,
		// so base = fix once the mask is gone). Each tripwire is paired with that
		// defused control. (1) The SAME same-line reopen class, unmasked by part 2
		// rather than part 1: base hid it only because its term-2 scan ran past the
		// `$$` to the `-->`; base already speaks it when a blank line sits there.
		// (2) A processing-instruction raw HTML block (`<?x`), which the renderer
		// passes through raw so the browser hides its content as a bogus comment.
		// (3) A `<div>` raw HTML block holding a mid-line `<!--`. (2) and (3) are a
		// pre-existing raw-HTML-block class, not a comment-rule defect. When either
		// is fixed, these expectations change on purpose.
		//
		// (1) is CLOSED BY NRL-136 and its pair is replaced in place, names kept: the
		// reopened `<!--` is a browser comment that runs to the next `-->` in the
		// document, so HIDDENA is hidden whether a `$$` or a blank line sits between
		// (renderer: both show only `t.`). `pin-nrl136-reopen-blank-stop` pins the
		// blank-line form again under NRL-136's own name. (2) and (3) are NRL-137's
		// and are deliberately unchanged.
		["pin-nrl120-unmasked-reopen-by-math-stop", "<!-- y --> <!--\nHIDDENA\n$$\n--> t.", "t."],
		["guard-nrl120-reopen-blank-stop-on-base", "<!-- y --> <!--\nHIDDENA\n\n--> t.", "t."],
		["pin-nrl120-unmasked-processing-instruction", "<!--\n===\n<?x\nHIDDENP", "<!-- <?x HIDDENP"],
		["guard-nrl120-processing-instruction-on-base", "SEEN\n===\n<?x\nHIDDENP", "SEEN <?x HIDDENP"],
		["pin-nrl120-unmasked-div-block-comment", "<!--\n===\n<div>\nProse <!-- HIDDEND", "<!-- Prose <!-- HIDDEND"],
		["guard-nrl120-div-block-comment-on-base", "SEEN\n===\n<div>\nProse <!-- HIDDEND", "SEEN Prose <!-- HIDDEND"],
		// NRL-120 PART 2. `math` is in `u.interruptParagraph` unconditionally, so a
		// `$$` line ends the paragraph a mid-line `<!--` belongs to and module 4839's
		// inline regex cannot reach the `-->` past it. Measured: `Prose <!--` / `$$` /
		// `HIDDENM --> t.` renders `<p>Prose &#x3C;!--</p>` then a math block holding
		// `HIDDENM --> t.`: DISPLAYED, as math source. No closer is needed - the block
		// runs to end of input. Each pin RED against base f250ddd.
		["pin-nrl120-math-stop", "Prose <!--\n$$\nHIDDENM --> t.", "Prose <!-- $$ HIDDENM --> t."],
		["pin-nrl120-math-three-space-lead", "Prose <!--\n   $$\nHIDDENM --> t.", "Prose <!-- $$ HIDDENM --> t."],
		["pin-nrl120-math-dollar-run", "Prose <!--\n$$$\nHIDDENM --> t.", "Prose <!-- $$$ HIDDENM --> t."],
		["pin-nrl120-math-trailing-text", "Prose <!--\n$$ y\nHIDDENM --> t.", "Prose <!-- $$ y HIDDENM --> t."],
		["pin-nrl120-math-third-line", "Prose <!--\nmore\n$$\nHIDDENM\n--> t.", "Prose <!-- more $$ HIDDENM --> t."],
		// Guards: lines the math tokenizer does NOT accept, so the paragraph goes on
		// and the inline comment really does hide HIDDENM. Each is a disclosure if
		// stopped at: the `includes("$$")` arm newly spoke 208,320 math-census cells
		// and the `trimStart()` arm 140,880.
		["guard-nrl120-math-tab-lead", "Prose <!--\n\t$$\nHIDDENM --> t.", "Prose t."],
		["guard-nrl120-math-four-space-lead", "Prose <!--\n    $$\nHIDDENM --> t.", "Prose t."],
		["guard-nrl120-math-inline-pair", "Prose <!--\n$$y$$\nHIDDENM --> t.", "Prose t."],
		["guard-nrl120-math-two-pairs", "Prose <!--\n$$ x $$ y\nHIDDENM --> t.", "Prose t."],
		["guard-nrl120-math-not-at-start", "Prose <!--\nx $$\nHIDDENM --> t.", "Prose t."],
		["guard-nrl120-math-dollar-later", "Prose <!--\n$$ $\nHIDDENM --> t.", "Prose t."],
		// CHANGED ON PURPOSE BY NRL-114, exactly as this tripwire asked, and kept under
		// its name (NRL-66 / NRL-67). The term-2 pass now peels the line's quote levels
		// before the unchanged `endsTerm2Scan` (`term2QuotedStop`), so `> $$` is a stop
		// and the `<!--` is no longer an opener. Renderer: `<p>Prose &#x3C;!--</p><div
		// class="math math-block">HIDDENM--> t.</div>`. The `$$` and the math body are
		// spoken literally, which is what base already does for an unclosed quoted
		// math block (`> Prose` / `> $$` / `> HIDDENM` speaks `Prose $$ HIDDENM` on
		// base 9132c3b), so that half is parity and not this change. RED on base.
		["pin-nrl120-quoted-math-still-hidden", "> Prose <!--\n> $$\n> HIDDENM\n> --> t.", "Prose <!-- $$ HIDDENM --> t."],
		// NRL-155. NRL-120's setext refusal capped the `<!--` lead at three SPACES,
		// on the claim that a tab is never setext content. Module 134 (indented code)
		// is LITERAL: four spaces or one tab at offset 0, no tab-stop expansion, so a
		// lead of one to three spaces and then a tab reaches setextHeading. Measured
		// against rendered HTML out of the installed obsidian.asar 1.13.7 (app.js
		// sha256 8efbf581...9898): `# Head` / ` \t<!--` / `===` / `HIDDENA` / `more` is
		// `<h1>Head</h1><h1>\t&#x3C;!--</h1><p>HIDDENA<br>more</p>`. Directly after an
		// ATX heading, a thematic break or a fence closer our INDENTED_CODE (which
		// needs wasBlank) does not take the line, so it reached opensHtmlBlock and
		// hid to end of note. Every pin below was RED against main faf55a3, which
		// spoke only what precedes the `<!--`. NOT OBSERVED IN OBSIDIAN (reading-view
		// parser executed in Node).
		["pin-nrl155-atx-1sp-tab", "# Head\n \t<!--\n===\nHIDDENA\nmore", "Head <!-- HIDDENA more"],
		["pin-nrl155-atx-2sp-tab", "# Head\n  \t<!--\n===\nHIDDENA\nmore", "Head <!-- HIDDENA more"],
		["pin-nrl155-atx-3sp-tab", "# Head\n   \t<!--\n===\nHIDDENA\nmore", "Head <!-- HIDDENA more"],
		["pin-nrl155-atx-1sp-tab-1sp", "# Head\n \t <!--\n===\nHIDDENA\nmore", "Head <!-- HIDDENA more"],
		["pin-nrl155-hr-1sp-tab", "Intro.\n\n***\n \t<!--\n===\nHIDDENA\nmore", "Intro. <!-- HIDDENA more"],
		["pin-nrl155-hr-2sp-tab", "Intro.\n\n***\n  \t<!--\n===\nHIDDENA\nmore", "Intro. <!-- HIDDENA more"],
		["pin-nrl155-hr-3sp-tab", "Intro.\n\n***\n   \t<!--\n===\nHIDDENA\nmore", "Intro. <!-- HIDDENA more"],
		["pin-nrl155-hr-1sp-tab-1sp", "Intro.\n\n***\n \t <!--\n===\nHIDDENA\nmore", "Intro. <!-- HIDDENA more"],
		["pin-nrl155-fence-1sp-tab", "```\ncode\n```\n \t<!--\n===\nHIDDENA\nmore", "<!-- HIDDENA more"],
		["pin-nrl155-fence-2sp-tab", "```\ncode\n```\n  \t<!--\n===\nHIDDENA\nmore", "<!-- HIDDENA more"],
		["pin-nrl155-fence-3sp-tab", "```\ncode\n```\n   \t<!--\n===\nHIDDENA\nmore", "<!-- HIDDENA more"],
		["pin-nrl155-fence-1sp-tab-1sp", "```\ncode\n```\n \t <!--\n===\nHIDDENA\nmore", "<!-- HIDDENA more"],
		// GUARDS, green on main and on the fix. Each names the wrong arm it is red
		// on; none is counted as evidence of the fix.
		// (a) Document start and after a blank line. Masked on main by INDENTED_CODE
		// (` \t` is indented code to us, so HIDDENA is spoken). Red on main with
		// NRL-113's narrowing alone, which hides HIDDENA. TRIPWIRE: when NRL-113
		// lands the text becomes `<!-- HIDDENA more` / `Intro. <!-- HIDDENA more`,
		// on purpose; the HIDDENA-is-spoken check after this table must stay green.
		//
		// NRL-113 HAS NOW LANDED, so both expectations are REPLACED IN PLACE with
		// the two strings NRL-155 predicted verbatim, keeping the names (the
		// NRL-66/NRL-67 convention). The reason is the rendered HTML, re-measured
		// here out of the executed Obsidian 1.13.7 parser and renderer:
		// ` \t<!--` / `===` is `<h1 data-heading="<!--">\t&#x3C;!--</h1>` followed by
		// `<p>HIDDENA<br>more</p>`, so the opener line is HEADING TEXT the reader
		// sees and the two lines under it are a displayed paragraph. Speaking
		// `<!-- HIDDENA more` is renderer-faithful; main's `=== HIDDENA more` spoke
		// the setext underline, which the renderer consumes and never displays.
		["guard-nrl155-doc-start-tab-lead", " \t<!--\n===\nHIDDENA\nmore", "<!-- HIDDENA more"],
		["guard-nrl155-after-blank-tab-lead", "Intro.\n\n  \t<!--\n---\nHIDDENA\nmore", "Intro. <!-- HIDDENA more"],
		// (b) Paragraph continuation: a tab-led `<!--` does not interrupt a
		// paragraph, so the renderer makes one `<p>` and the inline comment hides
		// HIDDENA. Red on the arm with no block-position gate.
		["guard-nrl155-paragraph-continuation", "Intro.\n \t<!--\n===\nHIDDENA\n--> t.", "Intro. t."],
		// (c) A TAB-led `# H` or `***` is a lazy paragraph continuation, not a block
		// end, so the gate's predecessor tests are spaces-only capped. Red on the
		// arm using the shared HEADING / HR constants, and on the wasPara arm.
		["guard-nrl155-tab-led-atx-is-lazy", "Intro.\n\t# H\n \t<!--\n===\nHIDDENA\n--> t.", "Intro. H t."],
		["guard-nrl155-tab-led-hr-is-lazy", "Intro.\n\t***\n \t<!--\n===\nHIDDENA\n--> t.", "Intro. t."],
		// (d) `| a |` is a paragraph line to the renderer (no delimiter row), so the
		// opener continues it. Under skipTables our skip path resets the paragraph
		// state, which is why the gate reads raw lines rather than wasPara: red on
		// the wasPara arm and on the no-gate arm.
		["guard-nrl155-table-row-skipped", "| a |\n \t<!--\n===\nHIDDENA\n--> t.", "t."],
		// (e) Leads module 134 takes as indented code are never setext content.
		// Red on the arm that drops the module-134 test. TRIPWIRES as well: the
		// renderer shows `<pre><code>&#x3C;!--</code></pre><p>=== HIDDENA --> t.</p>`
		// here, so `Head t.` is a PRE-EXISTING prose loss (our INDENTED_CODE needs
		// wasBlank, so after a heading the line reaches opensHtmlBlock instead).
		// Not opened by NRL-155 and identical on main; when indented code after a
		// block end is fixed, these expectations change on purpose.
		["guard-nrl155-module134-lead-tab", "# Head\n\t<!--\n===\nHIDDENA\n--> t.", "Head t."],
		["guard-nrl155-module134-lead-tab-1sp", "# Head\n\t <!--\n===\nHIDDENA\n--> t.", "Head t."],
		["guard-nrl155-module134-lead-4sp", "# Head\n    <!--\n===\nHIDDENA\n--> t.", "Head t."],
		["guard-nrl155-module134-lead-4sp-tab", "# Head\n    \t<!--\n===\nHIDDENA\n--> t.", "Head t."],
		["guard-nrl155-module134-lead-tab-tab", "# Head\n\t\t<!--\n===\nHIDDENA\n--> t.", "Head t."],
		["guard-nrl155-module134-lead-tab-1sp-tab", "# Head\n\t \t<!--\n===\nHIDDENA\n--> t.", "Head t."],
		// The module-134 test is also what keeps a FOUR-SPACE lead from being
		// refused as a paragraph continuation: that lead bears no tab, so the
		// block-position gate does not see it. Red on the arm dropping the test.
		["guard-nrl155-module134-4sp-paragraph-continuation", "Intro.\n    <!--\n===\nHIDDENA\n--> t.", "Intro. t."],
		// PRE-EXISTING DISCLOSURE, pinned as a tripwire and not opened here: a
		// whitespace line holding a tab does not end a paragraph in module 8607, so
		// the renderer makes one `<p>` and hides HIDDENA, while we take ` \t ` as
		// blank and the next line as indented code. Identical on main. The fix
		// counts only a spaces-only line as blank for its own gate; on main that
		// choice is masked by INDENTED_CODE and measured only on the NRL-113 arm
		// (accepting a tab there newly spoke HIDDEN in 1,792 census cells). When
		// either NRL-113 or the blank-line rule lands, this changes on purpose.
		//
		// NRL-113 HAS NOW LANDED and the tripwire has fired, so the expectation is
		// REPLACED IN PLACE keeping the name. It moves in the CLOSING direction:
		// this was the disclosure, and the narrowing shuts it. Re-measured out of
		// the executed parser and renderer, the whole note is ONE paragraph -
		// `<p>Intro.<br><br><!--\n===\nHIDDENA\n--> t.</p>` - whose visible text is
		// `Intro.` and ` t.` only, because the inline comment hides `===`, HIDDENA
		// and the `-->`. Main spoke `=== HIDDENA --> t.`, which is author-hidden
		// text; the fix speaks `Intro. t.`, which is what a reader sees. This is a
		// FOURTH leaking lead class closed by NRL-113 beyond the three the ticket
		// named, after the ` \t ` lead Verify found.
		["pin-nrl155-tab-whitespace-line-is-not-blank", "Intro.\n \t \n \t<!--\n===\nHIDDENA\n--> t.", "Intro. t."],
		// (f) NRL-114 CLOSED THE PROSE LOSS BOTH TRIPWIRES PINNED, and both are
		// replaced in place keeping their names. The setext arms themselves are still
		// spaces-only for lists, so what "unchanged" referred to still holds; what moved
		// is the outcome, through a different mechanism. After the quote peel stops at
		// `> `, both bodies begin with a tab, which module 134 makes INDENTED CODE at a
		// container fresh block, and NRL-114's `htmlLeadCode` masks `opensHtmlBlock`'s
		// term 2 there, so the `<!--` never opens. Renderer, quote row:
		// `<blockquote><pre><code>&#x3C;!--</code></pre><p>===<br>HIDDENA<br>--> t.
		// </p></blockquote>`; list row: `<li><pre><code>&#x3C;!--</code></pre>===<br>
		// HIDDENA<br>--> t.</li>`. The `<!--` is spoken under skipCodeBlocks (the
		// declined-line-as-prose known miss, displayed text). RED on base and on 7cdc7b7.
		["guard-nrl155-quote-arm-unchanged", "> \t<!--\n> ===\n> HIDDENA\n> --> t.", "<!-- === HIDDENA --> t."],
		["guard-nrl155-list-arm-unchanged", "- \t<!--\n  ===\n  HIDDENA\n  --> t.", "<!-- === HIDDENA --> t."],
		// NRL-115. `opensHtmlBlock`'s term 1 (`<!--` begins its line, any leading
		// whitespace) is module 8776's own rule, and it is right only where module
		// 8776 is REACHED. For an indented line it often is not: module 8607 absorbs
		// a paragraph continuation led by a tab or four columns as lazy prose without
		// running the interrupt check, and inside a quote or a list item a fresh block
		// led by a tab or four spaces is indented code (module 134 runs before html).
		// "Indented" is measured AFTER the renderer's own container dedent, which is
		// what `rendererLeads` models. We hid the rest of the note in every one of the
		// shapes below while Obsidian displays it. Every `pin-nrl115-` row down to the
		// setext block was measured RED against base 2c4e2ca and again against base
		// 9dadbea, and each expectation is renderer-faithful: real rendered HTML
		// from Obsidian 1.13.7's parser (app.js sha256 8efbf581...9898) shows both
		// sentinels. The `<!--` itself is spoken because
		// it is displayed, as lazy prose or as code. NOT OBSERVED IN OBSIDIAN.
		["pin-nrl115-after-paragraph-tab", "Before x.\n\t<!--\nSECRET\nVISIBLE", "Before x. <!-- SECRET VISIBLE"],
		["pin-nrl115-after-paragraph-space-tab", "Before x.\n \t<!--\nSECRET\nVISIBLE", "Before x. <!-- SECRET VISIBLE"],
		["pin-nrl115-after-paragraph-2sp-tab", "Before x.\n  \t<!--\nSECRET\nVISIBLE", "Before x. <!-- SECRET VISIBLE"],
		["pin-nrl115-after-paragraph-3sp-tab", "Before x.\n   \t<!--\nSECRET\nVISIBLE", "Before x. <!-- SECRET VISIBLE"],
		["pin-nrl115-after-paragraph-tab-space", "Before x.\n\t <!--\nSECRET\nVISIBLE", "Before x. <!-- SECRET VISIBLE"],
		["pin-nrl115-after-paragraph-4sp", "Before x.\n    <!--\nSECRET\nVISIBLE", "Before x. <!-- SECRET VISIBLE"],
		["pin-nrl115-after-paragraph-8sp", "Before x.\n        <!--\nSECRET\nVISIBLE", "Before x. <!-- SECRET VISIBLE"],
		["pin-nrl115-quote-continuation-tab", "> Before x.\n> \t<!--\n> SECRET\n> VISIBLE", "Before x. <!-- SECRET VISIBLE"],
		// After a `>` blank line the line is a FRESH block in the quote's content, so
		// it is indented code there, not lazy prose. Same visible outcome.
		["pin-nrl115-quote-after-blank-tab", "> Before x.\n>\n> \t<!--\n> SECRET\n> VISIBLE", "Before x. <!-- SECRET VISIBLE"],
		["pin-nrl115-quote-after-blank-tab-space", "> Before x.\n>\n> \t <!--\n> SECRET\n> VISIBLE", "Before x. <!-- SECRET VISIBLE"],
		["pin-nrl115-quote-after-blank-4sp", "> Before x.\n>\n>     <!--\n> SECRET\n> VISIBLE", "Before x. <!-- SECRET VISIBLE"],
		["pin-nrl115-quote-after-blank-8sp", "> Before x.\n>\n>         <!--\n> SECRET\n> VISIBLE", "Before x. <!-- SECRET VISIBLE"],
		// Inside a list item the lead is judged after module 5540 removes the item's
		// content indent: two spaces then a tab loses the two spaces and keeps the
		// tab, and eight spaces keep six, so both survive as indented code.
		["pin-nrl115-list-after-blank-2sp-tab", "- Before x.\n\n  \t<!--\nSECRET\nVISIBLE", "Before x. <!-- SECRET VISIBLE"],
		["pin-nrl115-list-after-blank-8sp", "- Before x.\n\n        <!--\nSECRET\nVISIBLE", "Before x. <!-- SECRET VISIBLE"],
		["pin-nrl115-list-continuation-2sp-tab", "- Before x.\n  \t<!--\nSECRET\nVISIBLE", "Before x. <!-- SECRET VISIBLE"],
		// The dedent is the smaller of the marker width and the item's least indent,
		// so the same `   \t` line is lazy here, where every item line is indented
		// three, and an opener in the guard below, where the lazy lines are not.
		["pin-nrl115-ordered-continuation-indented-item", "1. Before x.\n   \t<!--\n   SECRET\n   VISIBLE", "Before x. <!-- SECRET VISIBLE"],
		// A quote nested in a list item. On PR #169's base this carried a stray `> `
		// because the nested quote was not peeled; NRL-131 peels it now.
		["pin-nrl115-quote-in-list-tab", "- > Before x.\n  > \t<!--\n  > SECRET\n  > VISIBLE", "Before x. <!-- SECRET VISIBLE"],
		// An item's or a quote's FIRST line is a fresh block too. Module 745's marker
		// regex takes one space after `-` and leaves the tab as content indent.
		["pin-nrl115-item-first-line-tab", "- \t<!--\nSECRET\nVISIBLE", "<!-- SECRET VISIBLE"],
		["pin-nrl115-quote-first-line-tab", "> \t<!--\n> SECRET\n> VISIBLE", "<!-- SECRET VISIBLE"],
		// A tab-led underline-shaped line is a lazy continuation for module 8607,
		// never an underline, so the paragraph goes on and the next tab-led `<!--` is
		// lazy too. This is why the setext test below sits AFTER the tab test.
		["pin-nrl115-tab-led-underline-is-lazy", "PROSEP\n\t===\n\t<!--\nSECRET\nVISIBLE", "PROSEP === <!-- SECRET VISIBLE"],
		// A fenced code block inside a quote or a list item, then paragraph text: the
		// walker must see the fence closer through the container's own prefix, or
		// it would read everything after the opener as fence content and claim
		// nothing. Renderer: all of it displayed.
		["pin-nrl115-quoted-fence-then-paragraph", "> PROSEP\n> ```\n> x\n> ```\n> \t<!--\n> SECRET\n> VISIBLE", "PROSEP x <!-- SECRET VISIBLE"],
		["pin-nrl115-list-fence-then-paragraph", "- PROSEP\n  ```\n  x\n  ```\n  \t<!--\n  SECRET\n  VISIBLE", "PROSEP <!-- SECRET VISIBLE"],
		// AFTER A SETEXT HEADING. The first version of this fix (PR #169, baf8a85)
		// read `PROSEP` / `===` / ` \t<!--` as one three-line paragraph and claimed
		// the `<!--` line was lazy. It is not: module 8671 closes the block as a
		// heading, the next line is a block start, and module 8776 opens a comment
		// there, so Obsidian HIDES SECRET and VISIBLE. That spoke the comment body
		// in 512 of 512 option combinations per shape - a DISCLOSURE, found at
		// Verify. Each `pin-nrl115-setext-` row is the base's own speech (green on
		// base 2c4e2ca, on base 9dadbea and on the fix) and was measured RED against the port of
		// baf8a85's walker without the two setext tiers. `=`, `==`, `-` and `--`
		// leak the same way as `===`; ` \t`, `  \t` and `   \t` are the leads that
		// reach 8776 at a block start. Where the quote or list rows say `===` that
		// is a pre-existing divergence of ours (an underline inside a container is
		// spoken), identical on base.
		["pin-nrl115-setext-eq3-space-tab", "PROSEP\n===\n \t<!--\nSECRET\nVISIBLE", "PROSEP"],
		["pin-nrl115-setext-eq1-2sp-tab", "PROSEP\n=\n  \t<!--\nSECRET\nVISIBLE", "PROSEP"],
		["pin-nrl115-setext-eq2-3sp-tab", "PROSEP\n==\n   \t<!--\nSECRET\nVISIBLE", "PROSEP"],
		["pin-nrl115-setext-dash1-space-tab", "PROSEP\n-\n \t<!--\nSECRET\nVISIBLE", "PROSEP"],
		["pin-nrl115-setext-dash2-2sp-tab", "PROSEP\n--\n  \t<!--\nSECRET\nVISIBLE", "PROSEP"],
		["pin-nrl115-setext-leading-space-content", "   PROSEP\n===\n \t<!--\nSECRET\nVISIBLE", "PROSEP"],
		["pin-nrl115-setext-quote", "> PROSEP\n> ===\n>  \t<!--\n> SECRET\n> VISIBLE", "PROSEP ==="],
		["pin-nrl115-setext-nested-quote", "> > PROSEP\n> > ===\n> >  \t<!--\n> > SECRET\n> > VISIBLE", "PROSEP ==="],
		["pin-nrl115-setext-list", "- PROSEP\n  ===\n   \t<!--\n  SECRET\n  VISIBLE", "PROSEP ==="],
		["pin-nrl115-setext-ordered", "1. PROSEP\n   =\n    \t<!--\n   SECRET\n   VISIBLE", "PROSEP ="],
		["pin-nrl115-setext-callout", "> [!note]\n> PROSEP\n> ===\n>  \t<!--\n> SECRET\n> VISIBLE", "PROSEP ==="],
		["pin-nrl115-setext-quote-in-list", "- > PROSEP\n  > ===\n  >  \t<!--\n  > SECRET\n  > VISIBLE", "PROSEP ==="],
		["pin-nrl115-setext-list-in-quote", "> - PROSEP\n>   ===\n>    \t<!--\n>   SECRET\n>   VISIBLE", "PROSEP ==="],
		// Underline-shaped lines that are NOT a heading for Obsidian (two content
		// lines above, a leading or trailing space). The renderer displays all of
		// it, so these are prose loss, but the walker ends the paragraph as
		// `unknown` and keeps base's hiding: fail-closed, because a count or a view
		// the walker gets wrong here would be a disclosure. RED against the port
		// without the tiers, which spoke the comment body; recorded as known misses.
		["pin-nrl115-setext-two-content-lines-left", "Pre line\nPROSEP\n===\n \t<!--\nSECRET\nVISIBLE", "Pre line PROSEP ==="],
		["pin-nrl115-setext-loose-underline-left", "PROSEP\n ===\n \t<!--\nSECRET\nVISIBLE", "PROSEP ==="],
		["pin-nrl115-setext-trailing-space-underline-left", "PROSEP\n=== \n \t<!--\nSECRET\nVISIBLE", "PROSEP ==="],
		// GUARDS, green on base and on the fix and counted as nothing: each is a shape
		// where the renderer DOES open a comment (or where this ticket deliberately
		// leaves the old answer), so a widening of the rule would turn it red.
		//
		// `---` under one line is an h2 (tier 1 pre-empts the walker's HR test).
		["guard-nrl115-setext-dash3", "PROSEP\n---\n \t<!--\nSECRET\nVISIBLE", "PROSEP"],
		// The ordering trap. A broad underline test placed BEFORE the interrupt test
		// pre-empts the list walk: `   -` inside the quote is a list item for the
		// renderer, whose content `<!--` opens a comment. Measured leaking on that arm.
		["guard-nrl115-setext-preempt-quote-tab", "> PROSEP\n>    -\n>\t<!--\n> SECRET\n> VISIBLE", "PROSEP -"],
		["guard-nrl115-setext-preempt-quote-4sp", "> PROSEP\n>    -\n>     <!--\n> SECRET\n> VISIBLE", "PROSEP -"],
		// A fence inside a quote BEFORE the paragraph: the comment still opens.
		["guard-nrl115-quoted-fence-before", "> ```\n> PROSEP\n> ```\n>  \t<!--\n> SECRET\n> VISIBLE", "PROSEP"],
		// The item dedent eats a lone tab whole, so `<!--` reaches column 0 and opens.
		["guard-nrl115-list-continuation-tab-dedented-away", "- Before x.\n\t<!--\nSECRET\nVISIBLE", "Before x."],
		// `1. ` pads to FOUR columns (module 745's odd-width bump), and the unindented
		// lazy lines do not lower it, so `   \t` loses everything.
		["guard-nrl115-ordered-continuation-unindented-item", "1. Before x.\n   \t<!--\nSECRET\nVISIBLE", "Before x."],
		// Three spaces is under module 8607's four-column threshold.
		["guard-nrl115-after-paragraph-3sp-still-opens", "Before x.\n   <!--\nSECRET\nVISIBLE", "Before x."],
		// ` \t` is four columns and lazy after a paragraph, but at a FRESH block start
		// it is not indented code (module 134 needs a tab or four spaces FIRST), so it
		// reaches module 8776 and opens. This is why the two thresholds differ.
		["guard-nrl115-quote-after-blank-space-tab-still-opens", "> Before x.\n>\n>  \t<!--\n> SECRET\n> VISIBLE", "Before x."],
		// Decision Q3: only term 1 is narrowed. A lazy `<!--` whose `-->` sits later in
		// the same paragraph is an inline comment for the renderer and stays hidden.
		["guard-nrl115-term2-same-paragraph-closer-still-hides", "Before x.\n\t<!--\nSECRET\n--> VISIBLE", "Before x. VISIBLE"],
		// Decision Q2: top-level fresh-block positions are NRL-113's and this change does
		// not touch them. It was a DISCLOSURE on 9dadbea (` \t` is not code for the
		// renderer, so it hides SECRET; our INDENTED_CODE branch spoke it). NRL-113
		// (#194) narrowed INDENTED_CODE and closed it before this branch was rebased,
		// so the line now reaches the opener and is hidden, as the renderer hides it.
		["guard-nrl115-fresh-block-space-tab-is-nrl113", "Before x.\n\n \t<!--\nSECRET\nVISIBLE", "Before x."],
		// Decision Q5: a top-level line after a heading is a fresh block, indented code
		// for the renderer, and still silenced here - prose loss, recorded and left.
		["guard-nrl115-after-heading-tab-left", "# Head\n\t<!--\nSECRET\nVISIBLE", "Head"],
		// An HTML block of kinds 6 and 7 ends only at a TRULY empty line, so a line
		// holding a tab does not end it and the `<!--` below is raw HTML the browser
		// treats as a comment. Resetting the model's `unknown` state on a
		// whitespace-only line was measured to claim this line, and would speak SECRET.
		["guard-nrl115-html-block-not-ended-by-tab-line", "<div>\n \t\n- \t<!--\nSECRET\nVISIBLE", ""],
		// A lazy line after a quote may end the quote (indented code interrupts it), so
		// the model records nothing and the old answer stands: prose loss, left.
		["guard-nrl115-lazy-line-after-quote-left", "> Before x.\n\t<!--\nSECRET\nVISIBLE", "Before x."],
		// NRL-155's defect (iv), closed here rather than there: a ` \t`- or tab-led
		// `<!--` straight after a paragraph line is a lazy continuation for module
		// 8607, so the `===` under it is lazy text too and Obsidian displays all of
		// `Intro. <!-- === HIDDENA more`. RED on base 9dadbea, which spoke `Intro.`.
		["pin-nrl115-nrl155-iv-space-tab", "Intro.\n \t<!--\n===\nHIDDENA\nmore", "Intro. <!-- === HIDDENA more"],
		["pin-nrl115-nrl155-iv-tab", "Intro.\n\t<!--\n===\nHIDDENA\nmore", "Intro. <!-- === HIDDENA more"],
		// SHIP-CRITIQUE REGRESSIONS of the first rework (kept patch, 818f8d0). Each
		// `pin-nrl115-f1-` / `-f2-` / `-f3-` row is RED against that arm and green
		// here. The F1 rows are RED on base 9dadbea too (it hid ZBZ); the F2 and the
		// 5,000-level F3 rows are green on base.
		//
		// F1, a DISCLOSURE: the carry's containerCarryStops still stopped at the
		// peeled `\t<!--` line while cleanLine no longer hid it, so the label was
		// never confirmed and the destination ZDZ was read aloud. The refusal now
		// covers every HTML_BLOCK_OPEN tag on a line rendererLeads marks, because
		// a lazy indented line never reaches module 8776. Renderer: an image (or a
		// link) whose destination is an attribute, ZBZ displayed.
		["pin-nrl115-f1-quoted-image-destination", "> A ![alt ZAZ\n>\t<!--\n> words](ZDZ.png) ZBZ", "A alt ZAZ words ZBZ"],
		["pin-nrl115-f1-quoted-image-destination-no-alt", "> A ![alt ZAZ\n>\t<!--\n> words](ZDZ.png) ZBZ", "A ZBZ", { speakImageAlt: false }],
		["pin-nrl115-f1-quote-in-list-image-destination", "- > A ![alt ZAZ\n  >\t<!--\n  > words](ZDZ.png) ZBZ", "A alt ZAZ words ZBZ"],
		["pin-nrl115-f1-quoted-link-destination", "> A [label ZAZ\n>\t<!--\n> words](ZDZ.png) ZBZ", "A label ZAZ words ZBZ"],
		// F2, a DISCLOSURE: Obsidian absorbs every tab-led line below as lazy text,
		// so the `-->` closes an inline comment and ZCZ and ZHZ are hidden. The kept
		// arm claimed the `<!--` line and spoke both, because NRL-95's term-2 bound
		// (endsTerm2Scan) stops at the whitespace-only `\t` line that module 8607
		// does not stop at. Fixed by keeping term 1 when a `-->` lies later in the
		// walker's own lazy paragraph (closerInPara); endsTerm2Scan is untouched.
		["pin-nrl115-f2-tab-line-then-closer", "Prose\n\t<!-- ZCZ\n\t\nZHZ -->", "Prose"],
		["pin-nrl115-f2-tab-fence-then-closer", "Prose\n\t<!-- ZCZ\n\t```\nZHZ -->", "Prose"],
		["pin-nrl115-f2-tab-tilde-then-closer", "Prose\n\t<!-- ZCZ\n  \t~~~\nZHZ -->", "Prose"],
		["pin-nrl115-f2-tab-hr-then-closer", "Prose\n\t<!-- ZCZ\n\t ***\nZHZ -->", "Prose"],
		["pin-nrl115-f2-tab-atx-then-closer", "Prose\n\t<!-- ZCZ\n\t # X\nZHZ -->", "Prose"],
		["pin-nrl115-f2-list-item-then-closer", "- Prose\n  \t<!-- ZCZ\n  \t\n  ZHZ -->", "Prose"],
		// The scan for that `-->` continues THROUGH an underline-shaped line: under
		// two or more content lines it is not a heading for Obsidian. RED on an arm
		// that stops the scan at RL_SETEXT, as are NRL-155's two tab-led guards.
		["pin-nrl115-f2-scan-continues-through-underline", "Prose\n\t<!-- ZCZ\n\t\n===\nZHZ -->", "Prose"],
		// F1's refusal is the LAZY half only. A tab-led line after `>\t` content is a
		// FRESH indented-code line in the quote, a code block no label can span, so
		// the HTML-tag stop stays there: the renderer displays the whole construct
		// as code, destination included. RED on the arm that refused every
		// indented line (prose loss found by the fuzz). The `<div>` row is green on
		// base; the `<!--` row is RED on base too, which hid the rest as a comment.
		["pin-nrl115-f1-code-line-div-still-stops-the-carry", ">\t![alt ZAZ\n>\t<div>\n>\tx](ZDZ.png) ZBZ", "[alt ZAZ x](ZDZ.png) ZBZ"],
		["pin-nrl115-f1-code-line-comment-still-stops-the-carry", ">\t![alt ZAZ\n>\t<!--\n>\tx](ZDZ.png) ZBZ", "[alt ZAZ <!-- x](ZDZ.png) ZBZ"],
		// GUARDS for F2's counter-direction, green on the kept arm and here (RED on
		// base, so they are also 6,656-class evidence): a TRULY empty line or an
		// unindented ATX heading does end the paragraph, so the `-->` below it is
		// out of reach and the lazy `<!--` stays displayed.
		["guard-nrl115-f2-empty-line-ends-paragraph", "Prose\n\t<!-- ZCZ\n\nZHZ -->", "Prose <!-- ZCZ ZHZ -->"],
		["guard-nrl115-f2-atx-ends-paragraph", "Prose\n\t<!-- ZCZ\n# X\nZHZ -->", "Prose <!-- ZCZ X ZHZ -->"],
		// RESIDUAL TRIPWIRE, not fixed, identical on base, the kept arm and here: the
		// MID-LINE twin of F2. Module 4839 hides ZCZ and ZHZ (one lazy paragraph);
		// NRL-95's term-2 bound stops at the `\t` line, so we speak both. Fixing it
		// means teaching endsTerm2Scan lazy continuation, which moves NRL-95's census
		// and collides with NRL-119; left for that work.
		["guard-nrl115-f2-midline-twin-residual", "Prose <!-- ZCZ\n\t\nZHZ -->", "Prose <!-- ZCZ ZHZ -->"],
		// THE TAB-RULE DEFECT, found by this rework's own fuzz and RED on the plan's
		// prototype (the kept patch plus F1-F3): the walker's thematic-break test took a TAB
		// between or after the markers, which Obsidian's tokenizer does not. So
		// `- \t---` read as a break rather than the list item it is, the next
		// tab-led line was claimed as indented code, and the comment the item's
		// dedent opens at column 0 was spoken; and `***\t` ended the paragraph for
		// the closer scan, so a `-->` past it was missed. Renderer: ZCDZ, ZCZ and ZHZ
		// hidden. Green on base, which hid them.
		["pin-nrl115-tabrule-quoted-tab-dash-item-is-not-a-break", "> - \t---\n>\t<!--\n>\tb ZCDZ", ""],
		["pin-nrl115-tabrule-nested-tab-dash-item-is-not-a-break", "- x\n\n  - \t---\n  \t<!--\n  \tb ZCDZ", "x"],
		["pin-nrl115-tabrule-quoted-tab-star-item-is-not-a-break", "> * \t**\n>\t<!--\n>\tb ZCDZ", "**"],
		["pin-nrl115-tabrule-tab-trailing-rule-is-lazy-for-the-closer-scan", "Prose\n\t<!-- ZCZ\n***\t\nZHZ -->", "Prose"],
		// Two more DISCLOSURES the same fuzz found, at 180,000 notes, on the
		// prototype and on the tab-rule fix alike. Both are walker miscounts of
		// where a paragraph starts, each ending in a fresh indented-code claim for
		// a line the renderer dedents to a column-0 `<!--`. (1) A `|` line is
		// paragraph text, so `-` sits under two content lines and is a list item,
		// not an h2. (2) A line-start `<!--` with an underline under it is setext
		// heading content (NRL-120), not a comment to skip to its `-->`. Renderer:
		// ZLFZ and ZPJZ hidden. Green on base.
		["pin-nrl115-fuzz-table-shaped-line-is-paragraph-text", ">>|\nZ\n>>-\n>>\t<!--\nZLFZ", "| Z -"],
		// (3) The same for an underline-shaped or table-shaped line that is itself
		// setext content: `=` over `-` is an h2, and the next line a comment.
		["pin-nrl115-fuzz-underline-shaped-line-is-setext-content", ">>=\n>>-\n>>  \t<!--\nZPIZ", "= -"],
		// (4) A list cut short at a line that MAY interrupt it (`$$`): the item's
		// dedent is the least indent over its WHOLE content, `$$` included, so the
		// walker's shorter item over-dedented ` \t<!--` to a bare tab. The last item
		// of such a list is no longer walked.
		["pin-nrl115-fuzz-uncertain-list-tail-is-not-walked", "  -\n   \t<!--ZHCZ\n  $$", "-"],
		["pin-nrl115-fuzz-uncertain-list-tail-is-not-walked-quoted", ">  -\n>   \t<!--ZHCZ\n>  $$", "-"],
		["pin-nrl115-fuzz-setext-comment-content-is-not-skipped", "><!--\n>-\n>1.\n-->\n>\t<!--\nZPJZ", "<!-- - 1. -->"],
		// F3: the kept arm's walker recursed once per container level and threw
		// RangeError on a few thousand `>` or `- `. It now drains an explicit stack
		// and stops descending at RL_MAX_DEPTH (32) container levels.
		["pin-nrl115-f3-5000-quotes", ">".repeat(5000) + " deep ZQZ", "deep ZQZ"],
		["pin-nrl115-f3-5000-list-markers", "- ".repeat(5000) + "deep ZLZ", "deep ZLZ"],
		["pin-nrl115-f3-2500-quote-list-pairs", "> - ".repeat(2500) + "deep ZMZ", "deep ZMZ"],
		// BEYOND THE CAP the model records nothing for the deeper content, so each
		// such line keeps base's answer: FAIL-CLOSED (no new disclosure) but prose
		// loss is RETAINED. Measured: 32 levels is fixed, 33 and deeper speak exactly
		// what base speaks, over quote, list and alternating quote/list nesting to
		// depth 40 (0 new disclosures, 0 new losses). The `-cap33-` lazy rows pin
		// the retained loss (also RED on the uncapped kept arm, which fixed them);
		// the setext row pins the fail-closed direction: green on base and here, RED
		// on a wrong arm that claims the un-walked lines as lazy, as are the two
		// loss rows.
		["pin-nrl115-f3-cap32-quote-fixed", "> ".repeat(32) + "Before x.\n" + "> ".repeat(32) + "\t<!--\n" + "> ".repeat(32) + "SECRET\n" + "> ".repeat(32) + "VISIBLE", "Before x. <!-- SECRET VISIBLE"],
		["pin-nrl115-f3-cap33-quote-loss-retained", "> ".repeat(33) + "Before x.\n" + "> ".repeat(33) + "\t<!--\n" + "> ".repeat(33) + "SECRET\n" + "> ".repeat(33) + "VISIBLE", "Before x."],
		["pin-nrl115-f3-cap33-list-loss-retained", "- ".repeat(33) + "Before x.\n" + "  ".repeat(33) + "\t<!--\n" + "  ".repeat(33) + "SECRET\n" + "  ".repeat(33) + "VISIBLE", "Before x."],
		// SHIP-CRITIQUE r3 F1: CRLF line endings. `extractChunks` splits on `\n`, so each
		// line keeps its `\r`, and the walker's thematic-break, heading and blank tests
		// did not allow for it: `___\r` read as paragraph text, the ` \t<!--` after it
		// as a lazy continuation, and the comment body was spoken. Obsidian's parser
		// treats `\r\n` as a line ending and hides it. RED before the walker stripped
		// one trailing `\r` per line; base spoke `Prose ZPZ` on all four. The
		// blank-line row was green on both sides and is a guard, not evidence.
		["pin-nrl115-crlf-hr-underscore-still-hides", "Prose ZPZ\r\n___\r\n \t<!-- ZHZ\r\nZH2Z", "Prose ZPZ"],
		["pin-nrl115-crlf-hr-star-still-hides", "Prose ZPZ\r\n***\r\n \t<!-- ZHZ\r\nZH2Z", "Prose ZPZ"],
		["pin-nrl115-crlf-empty-heading-still-hides", "Prose ZPZ\r\n#\r\n \t<!-- ZHZ\r\nZH2Z", "Prose ZPZ"],
		["pin-nrl115-crlf-blank-line-still-hides", "Prose ZPZ\r\n\r\n \t<!-- ZHZ\r\nZH2Z", "Prose ZPZ"],
		// Counter-direction guard: the CRLF twin of the ticket's own lazy shape keeps
		// the fix (renderer displays every line).
		["guard-nrl115-crlf-lazy-continuation-spoken", "Before x.\r\n\t<!--\r\nHIDDEN1\r\nmore", "Before x. <!-- HIDDEN1 more"],
		["guard-nrl115-f3-cap33-setext-fails-closed", "> ".repeat(33) + "PROSEP\n" + "> ".repeat(33) + "===\n" + "> ".repeat(33) + " \t<!--\n" + "> ".repeat(33) + "SECRET\n" + "> ".repeat(33) + "VISIBLE", "PROSEP ==="],
	];
	for (const [id, src, expected, overrides] of cases) {
		const chunks = extractChunks(src, { ...OPTS, ...overrides });
		check(`NRL-38 ${id}: visible output`, chunks.map(c => c.text).join(" ") === expected);
		check(`NRL-38 ${id}: UTF-16 mapping and bounds`, chunks.every(c => {
			if (c.sourceIndex.length !== c.text.length || c.sourceStart !== c.sourceIndex[0] ||
				c.sourceEnd !== c.sourceIndex[c.text.length - 1]! + 1) return false;
			for (let i = 0; i < c.text.length; i++) {
				const at = c.sourceIndex[i]!;
				if (at < 0 || at >= src.length || (i > 0 && at < c.sourceIndex[i - 1]!)) return false;
				if (c.text[i] !== " " && src[at] !== c.text[i]) return false;
			}
			return true;
		}));
		// Each sentinel occurs once outside the removed spans. Checking raw
		// offsets, rather than sourceStart + text position, catches shifted maps.
		for (const word of ["after", "middle", "tail", "Visible"]) {
			if (!expected.includes(word)) continue;
			const c = chunks.find(c => c.text.includes(word));
			check(`NRL-38 ${id}: ${word} offset`, c?.sourceIndex[c.text.indexOf(word)] === src.indexOf(word));
		}
	}
	// NRL-95. Explicit character-identity coverage, through the shared
	// `unitsMatch` helper rather than the loop's inline form, for the four new
	// fixtures whose SPOKEN text newly spans something: a paragraph break, an
	// image label, a link label, a code span and a dropped link reference
	// definition. Numeric and UTF-16-based, never a spread - see unitsMatch.
	// The loop above already checks all four properties per fixture; these are
	// named separately so a regression names the shape rather than the array.
	const nrl95Lockstep: Array<[string, string, Partial<typeof OPTS>?]> = [
		["closer-in-later-paragraph", "Before x.\nProse <!--\nHIDDENP\n\nNew paragraph -->\nTail."],
		["label-dest-closer-later-para", "Before ![alt <!--x\nmore](zdestz.png) after.\n\nnew para -->", { speakImageAlt: false }],
		["codespan-closer-later-para", "Before `a\nProse <!--\nHIDDENX\nb` after.\n\nnew -->", { skipInlineCode: false }],
		["linkrefdef-title-closer-later", "[a]: x.png \"<!--\"\n\nZS here.\n\n-->\n\nZAFTERZ here."],
		// Added at ship review with the TERM2_LIST stop: these two newly speak
		// across a list-item boundary, which is a shape no earlier entry covers.
		["bullet-items-are-three-paragraphs", "- Prose <!--\n- HIDDENL\n- more -->\nTail."],
		["bullet-line-between", "Prose <!--\n- item\nHIDDENB\n--> t."],
	];
	for (const [id, src, overrides] of nrl95Lockstep) {
		check(`NRL-95 ${id}: sourceIndex lockstep by UTF-16 unit`, extractChunks(src, { ...OPTS, ...overrides }).every(
			(k) => k.sourceIndex.length === k.text.length && unitsMatch(k.text, k.sourceIndex, src),
		));
	}
	// NRL-155. The property guard (a) above must keep after NRL-113 changes its
	// exact text: a tab-bearing `<!--` over an exact underline at document start
	// or after a blank line is a heading, so HIDDENA is displayed and spoken. Red
	// on main with NRL-113's INDENTED_CODE narrowing alone (measured, 20,480 of the
	// 99,840-cell sweep), green on main and on the fix with or without it.
	for (const [id, src] of [
		["doc-start-1sp-tab", " \t<!--\n===\nHIDDENA\nmore"],
		["doc-start-3sp-tab-dash", "   \t<!--\n-\nHIDDENA\nmore"],
		["after-blank-2sp-tab", "Intro.\n\n  \t<!--\n---\nHIDDENA\nmore"],
		["after-blank-1sp-tab-1sp", "Intro.\n\n \t <!--\n--\nHIDDENA\nmore"],
	] as Array<[string, string]>) {
		check(`NRL-155 ${id}: HIDDENA spoken`, extractChunks(src, OPTS).some(c => c.text.includes("HIDDENA")));
	}
	// NRL-155 lockstep, numeric by UTF-16 unit through unitsMatch: the pins' spoken
	// text newly spans a heading whose content is led by a tab.
	for (const src of [
		"# Head\n \t<!--\n===\nHIDDENA\nmore",
		"Intro.\n\n***\n \t <!--\n===\nHIDDENA\nmore",
		"```\ncode\n```\n   \t<!--\n---\nHIDDENA\n--> t.",
		"# H\u00e9ad \ud83d\ude00\n  \t<!-- \ud83d\ude00\n=\nHIDDENA \u00e9\nmore",
	]) {
		check(`NRL-155 sourceIndex lockstep by UTF-16 unit: ${JSON.stringify(src.slice(0, 12))}`, extractChunks(src, { ...OPTS, skipCodeBlocks: false }).every(
			(k) => k.sourceIndex.length === k.text.length && unitsMatch(k.text, k.sourceIndex, src),
		));
	}
	// NRL-116. The narrowed peel changes HOW MANY raw characters `containerPrefix`
	// reports, which is the number `cleanLine` adds to every offset it emits, so an
	// off-by-one there would be invisible to a text-only expectation and is exactly
	// what non-negotiable 8 forbids. Checked numerically by UTF-16 code-unit index
	// through the same `unitsMatch` helper, over the shapes whose peel actually moved.
	const nrl116Lockstep: Array<[string, string, Partial<typeof OPTS>?]> = [
		["bullet-tab-lead", "- Plain prose\n- 	%%\n- SECRET"],
		["ordered-tab-lead", "1. Plain prose\n1. 	%%\n1. SECRET"],
		["task-tab-lead", "- [ ] Plain prose\n- [ ] 	%%\n- [ ] SECRET"],
		["bullet-eight-space-lead", "- Plain prose\n-        %%\n- SECRET"],
		["task-eight-space-lead", "- [ ] Plain prose\n- [ ]        %%\n- [ ] SECRET"],
		["nested-quote-tab-lead", "- Plain prose\n- 	> ZMARKZ x\n- after"],
		["nested-quote-comment-tab-lead", "- Plain prose\n- 	> %%\n- SECRET"],
		["four-space-lead", "- Plain prose\n-    %%\n- SECRET"],
		["two-space-lead-quote", "- Plain prose\n-  > ZMARKZ x\n- after"],
		["code-spoken-tab-lead", "- Plain prose\n- 	%%\n- SECRET", { skipCodeBlocks: false, skipInlineCode: false }],
	];
	for (const [id, src, overrides] of nrl116Lockstep) {
		check(`NRL-116 ${id}: sourceIndex lockstep by UTF-16 unit`, extractChunks(src, { ...OPTS, ...overrides }).every(
			(k) => k.sourceIndex.length === k.text.length && unitsMatch(k.text, k.sourceIndex, src),
		));
	}
	// NRL-166. The F1 rows and the container-fence drop, by UTF-16 unit. The drop
	// skips a whole line through `flushParagraph(); continue`, so the check that
	// matters is that every offset AFTER the dropped line still lands on its own
	// raw character, not only that lengths agree.
	const nrl166Lockstep: Array<[string, string, Partial<typeof OPTS>?]> = [
		["f1-list-quote-then-callout", "- > Plain ZPZ <!-- QAQ\n> [!tip] QBQ\n> QCQ -->\nTAIL QDQ"],
		["f1-ordered-tab-callout", "1. > text <!-- QAQ\n> [!note]\ttext -->\nAfter ZAZ."],
		["fence-drop-list-item", "- ~~~ QFQ\n- after ZAZ"],
		["fence-drop-callout-title", "> [!note] \t%% QBQ\n1. >    ~~~ QDQ\nAfter ZAZ.", { skipCodeBlocks: false }],
		["fence-drop-callout-title-tab", "-     <!--\n> [!note]\t~~~   QFQ -->\nAfter ZAZ.", { skipCodeBlocks: false }],
		// Fix round 1: a literal `<!--` now spoken mid-paragraph, the code-line
		// stop, and the first line of an uncertainly-ended item.
		["r1-a-literal-opener-then-comment", "- > Plain QAQ <!-- QXQ\n> [!tip] QBQ <!--\n> QCQ -->\nAfter ZAZ."],
		["r1-a-dash-pair-body", "> P <!-- QXQ\n> -- QBQ --> Z"],
		["r1-c-code-line-stop", "- >> Plain QAQ <!-- QXQ\n> [!x]\n>\t--> QCQ", { skipCodeBlocks: false }],
		["r1-b-item-quote-code-opener", "- > \tPlain QAQ <!-- QXQ\n> [!tip] QBQ -->\n%%"],
	];
	for (const [id, src, overrides] of nrl166Lockstep) {
		const chunks = extractChunks(src, { ...OPTS, ...overrides });
		check(`NRL-166 ${id}: sourceIndex lockstep by UTF-16 unit`, chunks.length > 0 && chunks.every(
			(k) => k.sourceIndex.length === k.text.length && unitsMatch(k.text, k.sourceIndex, src),
		));
	}
	{
		const src = "- ~~~ QFQ\n- after ZAZ";
		const after = extractChunks(src, OPTS).find((k) => k.text.startsWith("after"));
		check("NRL-166 fence-drop-list-item: the line after the drop maps to its own offset", after !== undefined && after.sourceStart === src.indexOf("after"));
	}
	// NRL-113. Named character-identity coverage through the shared `unitsMatch`
	// helper, for the shapes whose SPOKEN text newly spans something: a prose line
	// that used to be swallowed as indented code, a container-carried label, a
	// literal `%%`, and an astral character inside a newly-spoken region. Numeric
	// and UTF-16-based, never a spread - see unitsMatch.
	const nrl113Lockstep: Array<[string, string, Partial<typeof OPTS>?]> = [
		["space-tab-html-hidden", "Before x.\n\n \t<!--\nHIDDEN1\nmore"],
		["space-tab-html-hidden-spoken", "Before x.\n\n \t<!--\nHIDDEN1\nmore", { skipCodeBlocks: false }],
		["space-tab-percent-literal", "Before x.\n\n \t%%\nSECRET\nVISIBLE"],
		["code-continuation-space-tab", "Before x.\n\n\tcode one\n \tSECRETC\nmore"],
		["code-continuation-space-tab-spoken", "Before x.\n\n\tcode one\n \tSECRETC\nmore", { skipCodeBlocks: false }],
		["container-lazy-space-tab-image", "> A ![alt\n \twords](zdestz.png) B", { speakImageAlt: false }],
		["container-lazy-space-tab-link", "> A [lbl\n \twords](zdestz.png) B"],
		["space-tab-astral", "Before x.\n\n \t<!--\nHID\u{1F600}DEN\nmore", { skipCodeBlocks: false }],
		["space-tab-equation", "Before x.\n\n \t<!--\n$$\na+b\n$$\nmore", { skipCodeBlocks: false }],
		// Added at ship review with the constructs the corpus had no cell for. Each
		// of these newly speaks a region base silenced, so each is a new chance for
		// an offset to drift.
		["space-tab-fence-spoken", "Before x.\n\n \t```js\nPROSEA\nPROSEB", { skipCodeBlocks: false }],
		["space-tab-heading", "Before x.\n\n \t# HEADA\nAFTER"],
		["space-tab-bullet", "Before x.\n\n \t- ITEMA\nAFTER"],
		["space-tab-quote", "Before x.\n\n \t> QUOTEA\nAFTER"],
		["space-tab-callout", "Before x.\n\n \t> [!note] TITLEA\n> CBODY\n\nAFTER"],
		["space-tab-unclosed-math", "Before x.\n\n \t$$\nMPROSEA\nMPROSEB"],
		["three-space-tab-heading", "Before x.\n\n   \t# HEADA\nAFTER"],
		["three-space-tab-quote", "Before x.\n\n   \t> QUOTEA\nAFTER"],
		["space-tab-table-spoken", "Before x.\n\n \t| a | b |\n| - | - |\n| TCELL | y |\n\nAFTER", { skipCodeBlocks: false }],
		["space-tab-wikilink", "Before x.\n\n \t[[folder/Note]] tail.\n\nAFTER"],
		["space-tab-image", "Before x.\n\n \t![alt](zdestz.png) tail.\n\nAFTER"],
	];
	for (const [id, src, overrides] of nrl113Lockstep) {
		check(`NRL-113 ${id}: sourceIndex lockstep by UTF-16 unit`, extractChunks(src, { ...OPTS, ...overrides }).every(
			(k) => k.sourceIndex.length === k.text.length && unitsMatch(k.text, k.sourceIndex, src),
		));
	}
	// NRL-113 TRIPWIRE, asserted here rather than in the table above because it
	// synthesises an "equation" chunk and so needs ADR 0004's text-keyed exemption.
	// `opensMathBlock` uses `trimStart()`, which accepts a tab where the renderer's
	// `$$` predicate skips charCode 32 only (the divergence `AGENTS.md` records as
	// NRL-93's family). So we call a ` \t$$` line a display-math opener and say
	// "equation", where the harness renders `<p> \t$$<br>a+b</p>` - paragraph text.
	// Base never reached this, having eaten the line as indented code. Prose loss,
	// not a disclosure; pinned not fixed, because narrowing a second predicate in
	// this diff would make its measurements unattributable. Tracked as NRL-147.
	// WHEN IT CLOSES, this expectation must change on purpose.
	{
		const src = "Before x.\n\n \t$$\na+b\n$$\nAFTER";
		const ks = extractChunks(src, OPTS);
		check(
			"NRL-113 pin-nrl113-space-tab-math-block-says-equation: visible output",
			ks.map((k) => k.text).join(" ") === "Before x. equation AFTER",
			`got: ${JSON.stringify(ks.map((k) => k.text))}`,
		);
		check(
			"NRL-113 pin-nrl113-space-tab-math-block-says-equation: UTF-16 mapping and bounds",
			ks.every(
				(k) =>
					k.sourceIndex.length === k.text.length &&
					unitsMatch(k.text, k.sourceIndex, src, (text) => text === "equation"),
			),
		);
	}
	// NRL-136 (R-M08, disclosure direction). A line whose FIRST `<!--` starts an
	// HTML block and closes on that line, with a LATER `<!--` that does not, is
	// raw HTML for the renderer: Obsidian 1.13.7's own WT parser and GT renderer
	// turn `x` / blank / `<!-- y --> <!-- Q1Z` / `TAIL` into
	// `<p>x</p>\n<!-- y --> <!-- Q1Z\n<p>TAIL</p>`, and the second, unclosed
	// `<!--` becomes a BROWSER comment that hides the rendered output up to the
	// next `-->` anywhere later. Reworked after the first draft's Verify found three
	// disclosure classes (Q1-Q3 below).
	//
	// Every expectation was decided against real rendered HTML (the parser
	// harness, app.js sha256 8efbf581e259cabef4f9c9a34814cfe3c02863757377e56b3603933c50e89898,
	// oracle111.rendererHides), not by hand. Reading view only; NOT OBSERVED IN
	// A RUNNING OBSIDIAN (rule 11).
	//
	// CORE rows are red on origin/main 844b7f6 and green after.
	const nrl136: Array<[string, string, string, Partial<typeof OPTS>?]> = [
		// CORE, the ticket's base-reproducing rows and the same class in the other shapes and positions it reaches.
		["pin-nrl136-same-line-reopen", "x\n\n<!-- y --> <!-- Q1Z\nTAIL", "x"],
		["pin-nrl136-reopen-blank-stop", "<!-- y --> <!--\nHIDDENA\n\n--> t.", "t."],
		["pin-nrl136-text-between-openers", "<!-- y --> x <!-- H1\n\nT2", "x"],
		["pin-nrl136-empty-first-comment", "<!----> <!-- Q2Z\nTAIL", ""],
		// `html` is in interruptParagraph, so the line ends the paragraph above it.
		["pin-nrl136-paragraph-continuation", "Para\n<!-- y --> <!-- Q1Z\nTAIL", "Para"],
		["pin-nrl136-in-quote", "> <!-- y --> <!-- Q1Z\n> TAIL", ""],
		["pin-nrl136-list-marker", "- <!-- y --> <!-- Q1Z\nTAIL", ""],
		["pin-nrl136-list-continuation", "- item\n  <!-- y --> <!-- Q1Z\nTAIL", "item"],
		["pin-nrl136-task", "- [ ] <!-- y --> <!-- Q1Z\nTAIL", ""],
		// The closing line of a top-level HTML block is raw too, so an unclosed `<!--` anywhere on it opens a browser comment.
		["pin-nrl136-html-block-remainder-text", "<!-- a\nb --> x <!-- Q1Z\nTAIL", "x"],
		// The markdown under a browser comment is still parsed. A `-->` inside a fence's code closes it (GT emits `>` raw in `<pre>`), the rest of that line is code, and the fence's own closer must not be read as an opener.
		["pin-nrl136-fence-closer", "<!-- y --> <!-- Q4Z\n```\nco --> de\n```\nTAIL", "TAIL"],
		["pin-nrl136-fence-closer-spoken", "<!-- y --> <!-- Q4Z\n```\nco --> de\n```\nTAIL", "de TAIL", { skipCodeBlocks: false }],
		// What follows a browser comment's `-->` on an ordinary line is inline, so a `<!--` there is not a line-start opener.
		["pin-nrl136-browser-close-remainder-inline", "<!-- y --> <!-- Q1Z\nmid --> <!-- R2\nTAIL", "<!-- R2 TAIL"],
		// A `%%` block under a browser comment is removed by the parser, `-->` and all, so the browser comment closes at the NEXT `-->`.
		["pin-nrl136-pct-block-under-comment", "<!-- y --> <!-- Q1Z\n%%\nmid --> M2\n%%\nN3 --> after.", "after."],
		// A `-->` on an ATX heading closes inside its `data-heading` attribute, which GT writes before the heading text, so the reader sees the rest of the raw line (`line">`) and then the whole heading.
		["pin-nrl136-heading-closer", "<!-- y --> <!-- Q1Z\n# Head --> line\nTAIL", "line Head --> line TAIL"],
		// The line is an HTML block, so it interrupts the paragraph and a code span cannot cross it.
		["pin-nrl136-code-carry-refused", "A `x\n<!-- y --> <!-- Q1Z\nz` B\nTAIL", "A x", { skipInlineCode: false }],
		// CORE, Q1. An inline `%%...%%` pair is removed by the parser before rendering, so a `-->` inside one does not close the browser comment; the first draft spoke the content of the user's `%%` comment (Verify, 60 fuzz cells). Paired on the same line, non-greedy, after code spans and complete inline HTML comments, never on a fence, raw HTML or heading line.
		["pin-nrl136-q1-pct-pair-after-blank", "<!-- y --> <!-- Q1Z\n\nA %%x --> SECRETZ%% B\nTAIL", ""],
		["pin-nrl136-q1-pct-pair-list", "x\n\n<!-- y --> <!-- Q1Z\n- A %%note --> SECRETZ%% B", "x"],
		["pin-nrl136-q1-pct-pair-quote", "x\n\n<!-- y --> <!-- Q1Z\n> A %%note --> SECRETZ%% B\n\nTAIL", "x"],
		["pin-nrl136-q1-pct-pair-table", "x\n\n<!-- y --> <!-- Q1Z\n\n| A %%n --> SECRETZ%% B | c |\n| - | - |\n\nTAIL", "x", { skipTables: false }],
		["pin-nrl136-q1-pct-pair-same-paragraph", "<!-- y --> <!-- Q1Z\nA %%x --> SECRETZ%% B\nTAIL", ""],
		["pin-nrl136-q1-pct-triple", "<!-- y --> <!-- Q1Z\nA %%%x --> SECRETZ%% B\nTAIL", ""],
		// A heading's raw text, pair and all, is in `data-heading`, so its `-->` closes there and the rest of the raw line is shown before the heading. Closes the residual the first draft pinned as `pin-nrl136-residual-inline-pct-closer`.
		["pin-nrl136-q1-heading-attribute-rest", "<!-- y --> <!-- Q1Z\n# A %%x --> S%% B\nTAIL", "S%% B A B TAIL"],
		["pin-nrl136-q1-setext-attribute-rest", "<!-- y --> <!-- Z0Q\nA %%x --> Z1Q%% Z2Q\n===\nZ8Q TAIL", "Z1Q%% Z2Q A Z2Q Z8Q TAIL"],
		// CORE, Q2. A line-start `<!--` that opens a markdown HTML block while the browser comment is open: every line of that block is raw HTML (no heading, fence or `%%`), and the block ends at its `-->` or with its container, not at a blank line. The first draft read `# Z2Q --> Z3Q` there as a heading and spoke Z2Q (Verify).
		["pin-nrl136-q2-heading-inside-block", "<!-- a --> <!-- Z0Q\n<!-- Z1Q\n# Z2Q --> Z3Q", "Z3Q"],
		["pin-nrl136-q2-blank-inside-block", "<!-- a --> <!-- Z0Q\n<!-- Z1Q\n\n# Z2Q --> Z3Q", "Z3Q"],
		["pin-nrl136-q2-after-paragraph", "<!-- a --> <!-- Z0Q\nP\n<!-- Z1Q\n# Z2Q --> Z3Q", "Z3Q"],
		["pin-nrl136-q2-list", "<!-- a --> <!-- Z0Q\n\n- <!-- Z1Q\n  # Z2Q --> Z3Q", "Z3Q"],
		["pin-nrl136-q2-quote", "<!-- a --> <!-- Z0Q\n\n> <!-- Z1Q\n> # Z2Q --> Z3Q", "Z3Q"],
		["pin-nrl136-q2-raw-remainder", "<!-- a --> <!-- Z0Q\n<!-- Z1Q\nZ2Q --> Z3Q <!-- Z4Q\nZ5Q", "Z3Q"],
		["pin-nrl136-q2-fence-inside-block", "<!-- a --> <!-- Z0Q\n<!-- Z1Q\n```\nZ2Q --> Z3Q\n```\nZ4Q", "Z3Q"],
		["pin-nrl136-q2-fence-inside-block-spoken", "<!-- a --> <!-- Z0Q\n<!-- Z1Q\n```\nZ2Q --> Z3Q\n```\nZ4Q", "Z3Q Z4Q", { skipCodeBlocks: false }],
		// Four spaces is indented code, not a block, so the heading after it is a heading and shows its attribute's rest.
		["pin-nrl136-q2-four-space-not-a-block", "<!-- a --> <!-- Z0Q\n    <!-- Z1Q\n# Z2Q --> Z3Q", "Z3Q Z2Q --> Z3Q"],
		// A lazy `<!--` line ends a quote (and any list in it), because `html` is in interruptBlockquote, so the block is top-level.
		["pin-nrl136-q2-lazy-html-leaves-quote", "> - <!-- y --> <!-- S2Z\n<!-- S3Z\n# S4Z --> S6Z\nS7Z", "S6Z S7Z"],
		// CORE, Q3. List-item content is stripped by module 5540 (the smallest positive indent over the bullet pad and the item's lines) before the HTML tokenizer sees it, so the lead is measured on the stripped view. The first draft's fixed `<= 4 spaces or one tab` rule disclosed (Verify).
		["pin-nrl136-q3-list-five-space-content", "- item\n     <!-- y --> <!-- Q1Z\nTAIL", "item"],
		["pin-nrl136-q3-ordered-six-space", "1. item\n      <!-- y --> <!-- Q1Z\nTAIL", "item"],
		["pin-nrl136-q3-ordered-seven-space", "1. item\n       <!-- y --> <!-- Q1Z\nTAIL", "item"],
		["pin-nrl136-q3-nested-seven-space", "- A\n  - B\n       <!-- y --> <!-- Q1Z\nTAIL", "A B"],
		["pin-nrl136-q3-tab", "- item\n\t<!-- y --> <!-- Q1Z\nTAIL", "item"],
		["pin-nrl136-q3-quoted-list-six-space", "> - A\n>      <!-- y --> <!-- Q1Z\n> TAIL", "A"],
		// CORE, found by Ship's fuzz on the rebased tree. The app's `%%` block tokenizer skips SPACES only, so a `%%` led by spaces then a tab is paragraph text (renderer: `  \t%% Z0Q` displays `%% Z0Q`). `containerViews` took it for a `%%` block, swallowed the list below it and left the reopening line unstripped, so the first row newly spoke `<!-- Z7Q` against origin/main (which says `x`), and the second spoke Z7Q and Z8Q on main and on the fix alike. Red before the tab test, green after. The second row's missing `%% Z0Q` under default options is NRL-93's pre-existing tab-led `%%` loss (origin/main drops it too), not this change.
		["pin-nrl136-tab-led-pct-is-not-a-block", "  \t%% Z0Q\n1. <!-- a --> x <!-- Z6Q\n    <!-- y --> <!-- Z7Q", "%% Z0Q x", { skipCodeBlocks: false, skipInlineCode: false, skipTables: false }],
		// Rebase onto main 20d9da1: `%% Z0Q` is now spoken because NRL-113 narrowed INDENTED_CODE to module 134's literal rule, so ` \t%% Z0Q` is paragraph text, which the renderer displays (`%% Z0Q A`). Only that half moved; Z7Q and Z8Q stay hidden.
		["pin-nrl136-tab-led-pct-list-strip", " \t%% Z0Q\n\n- A\n     <!-- y --> <!-- Z7Q\nZ8Q", "%% Z0Q A"],
		// CORE, also from Ship's fuzz. A lazy `=` under a quoted line underlines it only while it stays in the quote run; when an exact underline follows it, the quote ends there and `=` is the content of its own `<h1>`. Renderer: the first row shows `Z2Q B`, `=` and TAIL and hides Z1Q, which the pre-Ship tree spoke by reading the quoted line as a heading; the second hides everything, which origin/main and the pre-Ship tree both spoke.
		["pin-nrl136-quote-lazy-underline-left-quote", "<!-- y --> <!-- Z0Q\n> A Z1Q --> Z2Q B\n=\n===\nTAIL", "Z2Q B = === TAIL"],
		["pin-nrl136-quote-block-lazy-underline-left-quote", "> <!-- y --> <!-- S2Z\n=\n===\nS3Z", ""],
		// CORE, from Ship's fuzz after the rebase onto NRL-131. A `%%` straight after a callout marker is title text, not a block, so the next line's `-->` closes the browser comment (renderer: empty title, Z5Q and Z6Q shown). The pre-Ship tree read it as a block and hid the rest; NRL-131's peel of `- > [!note]` is what brought the nested form into reach.
		["pin-nrl136-callout-title-pct-not-a-block", "<!-- a --> x <!-- Z2Q\n> [!note] %%\n Z4Q --> Z5Q\n  Z6Q", "x Z5Q Z6Q"],
		["pin-nrl136-nested-callout-title-pct-not-a-block", "- > [!note] <!-- a --> x <!-- Z2Q\n- > [!note] %%\n Z4Q --> Z5Q\n  Z6Q\n1. %%Z7Q --> Z8Q%% Z9Q", "x Z5Q Z6Q Z9Q"],
		// Red on an arm that drops the `%%` block test for every quoted line: a `%%` on a callout BODY line is still a block, removed by the parser, so the comment closes only at the `-->` after it.
		["guard-nrl136-callout-body-pct-is-a-block", "<!-- a --> x <!-- Z2Q\n> [!note] t\n> %%\n> Z4Q --> Z5Q\n> %%\nZ6Q --> Z7Q", "x Z7Q"],
		// CORE, Ship fuzz. A heading as a list item's content leaves no paragraph open, so a six-space line under it is indented code and its `-->` closes the browser comment, `%%` pair and all (renderer shows `Z4Q%% Z5Q`); the pre-Ship tree kept the paragraph open, skipped the pair and hid the rest. The `- Z2Q` twin, a real paragraph, stays hidden.
		["pin-nrl136-item-heading-then-code", "- <!----> <!-- Z1Q\n- # Z2Q\n      %%Z3Q --> Z4Q%% Z5Q\nTAIL", "Z4Q%% Z5Q TAIL", { skipCodeBlocks: false }],
		["guard-nrl136-item-paragraph-then-continuation", "- <!----> <!-- Z1Q\n- Z2Q\n      %%Z3Q --> Z4Q%% Z5Q\nTAIL", ""],
		// CORE, Ship fuzz. A line that leaves the quote above it starts a block, so over an exact underline it is setext content and its raw text, pair and all, is in `data-heading` (renderer shows `Z9Q%% Z10Q">A Z10Q TAIL`). The pre-Ship tree read it as continuing the quote's paragraph and hid everything.
		["pin-nrl136-setext-after-quote", "<!-- a --> <!-- Z6Q\n> Z7Q\nA %%x --> Z9Q%% Z10Q\n===\nTAIL", "Z9Q%% Z10Q A Z10Q TAIL"],
		// Red on an arm that refuses every lazy underline: with no second underline the lazy `=` does underline the quoted line, so its raw text is in `data-heading` and shown.
		["guard-nrl136-quote-lazy-underline-holds", "<!-- y --> <!-- Z0Q\n> A Z1Q --> Z2Q B\n=\nTAIL", "Z2Q B A Z1Q --> Z2Q B = TAIL"],
		// Green on origin/main, on the pre-Ship tree and on an arm that refuses any `%%` led by whitespace (measured), so it pins only that spaces alone still open the block and hide the rest of the note; it is not evidence for the tab test.
		["guard-nrl136-space-led-pct-is-a-block", "  %% Z0Q\n1. <!-- a --> x <!-- Z6Q\n    <!-- y --> <!-- Z7Q", ""],
		// GUARDS: green on origin/main and on the fix, so evidence of nothing on their own. Each names what breaks it: `old` is the first NRL-136 draft (d021898); the others are scratch arms of this fix with one mechanism removed or widened.
		// Red on wrong-q1-noinline: a complete inline comment binds before a `%%` pair inside it.
		["guard-nrl136-q1-inline-comment-binds-first", "<!-- y --> <!-- Q1Z\nA <!-- %%x --> SEENZ%% B\nTAIL", "SEENZ%% B TAIL"],
		// Red on `old`: Verify's third disclosure, a five-space line in a list item after a two-space sibling.
		["guard-nrl136-q3-sibling-indent-reopen", "- <!-- y --> <!-- Z0Q\n  Z1Q\n     <!----> <!-- Z2Q\n  Z3Q", ""],
		// Red on `old`: setext runs before html, including under a lazy `=` underline.
		["guard-nrl136-setext-lazy-underline", "> <!-- y --> <!-- S2Z\n===\nS3Z", "<!-- S2Z === S3Z"],
		["guard-nrl136-setext-beats-block", "<!-- y --> <!-- Q\n===\nTAIL", "<!-- Q TAIL"],
		// Red on `old`: a callout marker is one only on the first line of its quote.
		["guard-nrl136-late-callout-is-text", "> x\n> [!note] <!-- y --> <!-- Z1Q\nZ2Q", "x <!-- Z1Q Z2Q"],
		// Red on abl-browsermodel: display math content is literal, so its `-->` closes and the line is not a heading.
		["guard-nrl136-math-is-literal", "- <!--> <!-- Z0Q\n\n# Z2Q\n   $$\n---\n=\n> # Z6Q --> Z7Q", "Z7Q"],
		// Red on `old`: `BLOCKQUOTE` takes a tab after `>`, module 6234 does not, so the line is indented code.
		["guard-nrl136-quote-tab-is-code", ">\t<!-- y --> <!-- S2Z\nS3Z TAIL", "<!-- S2Z S3Z TAIL"],
		// Red on wrong-q3-anylead, which drops the lead cap: four columns after the strip is lazy prose or code.
		["guard-nrl136-lazy-four-space", "Para\n    <!-- y --> <!-- Q1Z\nTAIL", "Para <!-- Q1Z TAIL"],
		["guard-nrl136-q3-six-space-shown", "- item\n      <!-- y --> <!-- Q1Z\nTAIL", "item <!-- Q1Z TAIL"],
		["guard-nrl136-q3-ordered-eight-space-shown", "1. item\n        <!-- y --> <!-- Q1Z\nTAIL", "item <!-- Q1Z TAIL"],
		["guard-nrl136-q3-nested-eight-space-shown", "- A\n  - B\n        <!-- y --> <!-- Q1Z\nTAIL", "A B <!-- Q1Z TAIL"],
		["guard-nrl136-q3-two-space-tab-shown", "- item\n  \t<!-- y --> <!-- Q1Z\nTAIL", "item <!-- Q1Z TAIL"],
		// Red on wrong-q1-nocode / wrong-q1-noescape: a code span or an escape is paired before `%%`.
		["guard-nrl136-q1-code-span-closes", "<!-- y --> <!-- Q1Z\nA `%%x --> SEENZ%%` B\nTAIL", "SEENZ%% B TAIL"],
		["guard-nrl136-q1-code-span-pct-closes", "<!-- y --> <!-- Q1Z\nA `%%`x --> SEENZ%% B\nTAIL", "SEENZ%% B TAIL"],
		["guard-nrl136-q1-escaped-pct-closes", "<!-- y --> <!-- Q1Z\nA \\%%x --> SEENZ%% B\nTAIL", "SEENZ%% B TAIL"],
		// Inherited from the first draft, where each was red on the wrong arm its own comment named there.
		["guard-nrl136-html-block-remainder", "<!-- a\nb --> <!-- Q1Z\nTAIL", ""],
		["guard-nrl136-closer-line-is-inline", "<!-- y --> <!-- Q6Z\nmid --> M2 <!-- Q7Z\nTAIL", "M2 <!-- Q7Z TAIL"],
		["guard-nrl136-fresh-four-space-is-code", "x\n\n    <!-- y --> <!-- Q1Z\nTAIL", "x TAIL"],
		["guard-nrl136-heading-is-inline", "# <!-- y --> <!-- Q1Z\nTAIL", "<!-- Q1Z TAIL"],
		["guard-nrl136-term2-remainder-inline", "Prose <!-- a\nb --> <!-- y --> <!-- Q1Z\nTAIL", "Prose <!-- Q1Z TAIL"],
		["guard-nrl136-list-marker-five-spaces-is-code", "-     <!-- y --> <!-- Q1Z\nTAIL", "<!-- Q1Z TAIL"],
		["guard-nrl136-closed-second-comment", "<!-- y --> V1Z\nTAIL", "V1Z TAIL"],
		["guard-nrl136-inline-code-closer", "x\n\n<!-- y --> <!-- Q5Z\nA `c --> d` E\nTAIL", "x d E TAIL"],
		["guard-nrl136-container-block-remainder", "- [ ] <!-- Q3\n```\n x --> y <!-- Z9\n```\nTAIL", "y <!-- Z9 TAIL", { skipCodeBlocks: false }],
		["guard-nrl136-q1-pct-quad-pairs-first-two", "<!-- y --> <!-- Q1Z\nA %%%% x --> SEENZ B\nTAIL", "SEENZ B TAIL"],
		["guard-nrl136-q1-multiline-pct-closes", "<!-- y --> <!-- Q1Z\nA %%x --> SEENZ\nB%% C\nTAIL", "SEENZ B%% C TAIL"],
		["guard-nrl136-q1-raw-line-closes", "<!-- y --> <!-- Q1Z\n<!-- %%x --> SEENZ%% B\nTAIL", "SEENZ%% B TAIL"],
		// TRIPWIRE, a residual NOT closed and pinned at today's output: a non-comment HTML block start (`<div>`) followed by `<!--` hides TAIL in the renderer too. NRL-137's class.
		["pin-nrl136-residual-div-opener", "<div> <!-- Q1Z\nTAIL", "<!-- Q1Z TAIL"],
	];
	for (const [id, src, expected, overrides] of nrl136) {
		const chunks = extractChunks(src, { ...OPTS, ...overrides });
		check(`NRL-136 ${id}: visible output`, chunks.map((c) => c.text).join(" ") === expected, `got: ${chunks.map((c) => c.text).join(" ")}`);
		check(`NRL-136 ${id}: sourceIndex lockstep by UTF-16 unit`, chunks.every((k) =>
			k.sourceIndex.length === k.text.length &&
			k.sourceStart === k.sourceIndex[0] &&
			k.sourceEnd === k.sourceIndex[k.text.length - 1]! + 1 &&
			k.sourceIndex.every((at, i) => at >= 0 && at < src.length && (i === 0 || at >= k.sourceIndex[i - 1]!)) &&
			unitsMatch(k.text, k.sourceIndex, src),
		));
	}
	const paced = extractChunks("Before.\n\n%%\nhidden\n%%\n\nafter.", OPTS);
	check("NRL-38 paragraph boundaries retained", paced.length === 2);
}

console.log("soft-wrapped code spans and the paragraph join space (NRL-42)");
{
	// Every fixture below is synthetic. SENTINEL marks text a renderer hides,
	// so it must never be spoken; diagnostics carry fixture IDs only.
	const cases: Array<[string, string, string, Partial<typeof OPTS>?]> = [
		// The recorded regression: a code span crossing a soft line break kept
		// its literal %% before NRL-38 and lost it after.
		["span-3line", "Before `first\n%%literal%%\nlast` after.", "Before first %%literal%% last after.", { skipInlineCode: false }],
		["span-5line", "Before `one\n%%two%%\nthree\n%%four%%\nfive` after.", "Before one %%two%% three %%four%% five after.", { skipInlineCode: false }],
		["span-html-3line", "Before `first\n<!--literal-->\nlast` after.", "Before first <!--literal--> last after.", { skipInlineCode: false }],
		["span-double-run", "Before ``one\n%%two%%\nthree`` after.", "Before one %%two%% three after.", { skipInlineCode: false }],
		["span-comment-on-closing-line", "Before `first\nmid\n%%literal%% last` after.", "Before first mid %%literal%% last after.", { skipInlineCode: false }],
		["span-second-run-on-line", "Before `a` and `b\n%%c%%\nd` after.", "Before a and b %%c%% d after.", { skipInlineCode: false }],
		// The closer lookahead is a disclosure guard, not an optimisation: an
		// unmatched run is literal text in CommonMark, so carrying an open-span
		// flag would stop the %% on the next line opening a real block comment
		// and SENTINEL would be read aloud. First paragraph proves the guard,
		// second proves the fix is still in force in the same document.
		["guard-no-closer-then-span", "Before `x\n%%\nSENTINEL\n%%\ntail.\n\nNext `first\n%%literal%%\nlast` end.", "Before x tail. Next first %%literal%% last end.", { skipInlineCode: false }],
		// A run of a different length is not a closer, so still no carry.
		["guard-run-length-mismatch", "Before `one\n%%SENTINEL%%\nthree`` after.", "Before one three after.", { skipInlineCode: false }],
		// Each of these interrupts a paragraph in CommonMark, so a code span
		// cannot reach past it and the scan must stop there.
		["guard-blank-interrupt", "Before `x\n\n%%SENTINEL%%\nafter.", "Before x after.", { skipInlineCode: false }],
		["guard-heading-interrupt", "Before `x\n# H\n%%SENTINEL%%\nlast` after.", "Before x H last after.", { skipInlineCode: false }],
		["guard-fence-interrupt", "Before `x\n```\n%%SENTINEL%%\n```\nlast` after.", "Before x last after.", { skipInlineCode: false }],
		["guard-quote-interrupt", "Before `x\n> q\n%%SENTINEL%%\nlast` after.", "Before x q last after.", { skipInlineCode: false }],
		["guard-list-interrupt", "Before `x\n- i\n%%SENTINEL%%\nlast` after.", "Before x i last after.", { skipInlineCode: false }],
		["guard-table-interrupt", "Before `x\n| a |\n%%SENTINEL%%\nlast` after.", "Before x last after.", { skipInlineCode: false }],
		["guard-setext-interrupt", "Before `x\n---\n%%SENTINEL%%\nlast` after.", "Before x last after.", { skipInlineCode: false }],
		// A table row reaches the carry site as plain paragraph text when tables
		// are spoken, and a span cannot leave its own row, so the opening line
		// is checked as well as every line scanned.
		["guard-table-row-opener", "| c `a\n%%SENTINEL%%\nb` end |", "| c a b end |", { skipInlineCode: false, skipTables: false }],
		// A comment that hides the lines after it ends the paragraph too, so a
		// run on its far side is not a closer. Read off Obsidian 1.13.7's own
		// Reading-view parser, which puts `comment` in interruptParagraph and
		// already has `html` there, so neither an opening `%%` line nor an
		// opening `<!--` can sit inside a code span. Without this the carry
		// makes the comment branch skip the opener and SENTINEL is spoken.
		["guard-block-opener-in-carry", "Before `x\n%%\nSENTINEL\n%%\ny ` z.", "Before x y z.", { skipInlineCode: false }],
		["guard-html-opener-in-carry", "Before `x\n<!--\nSENTINEL\n-->\ny ` z.", "Before x y z.", { skipInlineCode: false }],
		["guard-unclosed-block-opener-in-carry", "Before `x\n%%\nSENTINEL ` y.", "Before x", { skipInlineCode: false }],
		["guard-double-run-block-opener", "Before ``x\n%%\nSENTINEL\n%%\ny `` z.", "Before x y z.", { skipInlineCode: false }],
		["guard-indented-block-opener", "Before `x\n  %%\nSENTINEL\n  %%\ny ` z.", "Before x y z.", { skipInlineCode: false }],
		["guard-html-opener-mid-line", "Before `x\ntext <!--\nSENTINEL\n-->\ny ` z.", "Before x text y z.", { skipInlineCode: false }],
		// The other side of that rule: a comment that closes on its own line
		// hides nothing after it, so it does not end the paragraph and stays
		// literal inside the span. Obsidian agrees: its block-comment tokenizer
		// bails on a second `%` before the newline, so `%%literal%%` is never a
		// block opener, and `<!--literal-->` closes on the line.
		["span-inline-pair-stays-literal", "Before `x\n%%literal%%\ny ` z.", "Before x %%literal%% y z.", { skipInlineCode: false }],
		["span-html-pair-stays-literal", "Before `x\n<!--literal-->\ny ` z.", "Before x <!--literal--> y z.", { skipInlineCode: false }],
		// `%%` that is not at the start of its line is not a block opener, so it
		// hides nothing and the paragraph continues.
		["span-percent-after-text", "Before `x\ntext %%\ny ` z.", "Before x text %% y z.", { skipInlineCode: false }],
		// An escape leaves no unmatched run, so nothing is carried.
		["guard-escaped-backtick", "Before \\`x\n%%SENTINEL%%\nlast after.", "Before `x last after.", { skipInlineCode: false }],
		// Unchanged on d9f68ed: proof the fix is confined to the comment branch.
		["control-no-markers", "Before `first\nmiddle\nlast` after.", "Before first middle last after.", { skipInlineCode: false }],
		["control-two-line", "Before `first\nlast` after.", "Before first last after.", { skipInlineCode: false }],
		["control-single-line", "Before `first %%literal%% last` after.", "Before first %%literal%% last after.", { skipInlineCode: false }],
		// NRL-44 decision Q1: a confirmed soft-wrapped span is SILENCED when inline
		// code is skipped, which is what the toggle's name says and what a
		// single-line span already does. The region leaves exactly one space behind
		// so the words either side do not run together - the `no doubled space`
		// assertion below covers that from the other direction.
		//
		// "first" used to be spoken here, which was NRL-64 (N1). It is silent as of
		// NRL-64: extractChunks now confirms the span with codeSpanClosesLater
		// BEFORE cleanLine commits the opening line's output, so the opening line's
		// post-opener tail is part of the region like every other part of the span.
		// The expected value moved from "Before first after." as a consequence of
		// that fix, not as a weakening of this row - the single-line oracle
		// `control-single-line-skipped` below says "Before after." too.
		["pin-skipped-code", "Before `first\n%%literal%%\nlast` after.", "Before after.", { skipInlineCode: true }],
		["span-skipped-markdown-silenced", "Before `first\n**bold** #tag <https://x.com>\nlast` after.", "Before after.", { skipInlineCode: true }],
		["span-skipped-escape-silenced", "Before `first\n\\%%kept\\%%\nlast` after.", "Before after.", { skipInlineCode: true }],
		// Two lines: no wholly-silenced middle line, so this is the shape that
		// shows the closing line's region silenced on its own.
		["span-skipped-two-line", "Before `first\nlast` after.", "Before after.", { skipInlineCode: true }],
		// NRL-44 (Q3-Q5): inside a confirmed soft-wrapped span nothing is
		// re-interpreted as markdown. Each span-verbatim-* row is paired with the
		// single-line control that is its oracle: a single-line span has always
		// been verbatim and option-independent, so these rows are that same rule
		// finally reaching continuation lines, not a new rule. The enumeration
		// probe found 18 of 21 inline constructs re-interpreted here before the
		// fix, which is why the fix is one verbatim region rather than 18 guards.
		["span-verbatim-bold", "Before `first\n**bold**\nlast` after.", "Before first **bold** last after.", { skipInlineCode: false }],
		["control-single-line-bold", "Before `first **bold** last` after.", "Before first **bold** last after.", { skipInlineCode: false }],
		["span-verbatim-em-star", "Before `first\n*em*\nlast` after.", "Before first *em* last after.", { skipInlineCode: false }],
		["control-single-line-em-star", "Before `first *em* last` after.", "Before first *em* last after.", { skipInlineCode: false }],
		["span-verbatim-em-under", "Before `first\n_em_\nlast` after.", "Before first _em_ last after.", { skipInlineCode: false }],
		["control-single-line-em-under", "Before `first _em_ last` after.", "Before first _em_ last after.", { skipInlineCode: false }],
		["span-verbatim-highlight", "Before `first\n==high==\nlast` after.", "Before first ==high== last after.", { skipInlineCode: false }],
		["control-single-line-highlight", "Before `first ==high== last` after.", "Before first ==high== last after.", { skipInlineCode: false }],
		["span-verbatim-math", "Before `first\n$x + y = z$\nlast` after.", "Before first $x + y = z$ last after.", { skipInlineCode: false }],
		["control-single-line-math", "Before `first $x + y = z$ last` after.", "Before first $x + y = z$ last after.", { skipInlineCode: false }],
		["span-verbatim-mathblock", "Before `first\n$$a+b$$\nlast` after.", "Before first $$a+b$$ last after.", { skipInlineCode: false }],
		["control-single-line-mathblock", "Before `first $$a+b$$ last` after.", "Before first $$a+b$$ last after.", { skipInlineCode: false }],
		["span-verbatim-html", "Before `first\n<span>h</span>\nlast` after.", "Before first <span>h</span> last after.", { skipInlineCode: false }],
		["control-single-line-html", "Before `first <span>h</span> last` after.", "Before first <span>h</span> last after.", { skipInlineCode: false }],
		["span-verbatim-embed", "Before `first\n![[embed]]\nlast` after.", "Before first ![[embed]] last after.", { skipInlineCode: false }],
		["control-single-line-embed", "Before `first ![[embed]] last` after.", "Before first ![[embed]] last after.", { skipInlineCode: false }],
		["span-verbatim-wikilink", "Before `first\n[[wikilink]]\nlast` after.", "Before first [[wikilink]] last after.", { skipInlineCode: false }],
		["control-single-line-wikilink", "Before `first [[wikilink]] last` after.", "Before first [[wikilink]] last after.", { skipInlineCode: false }],
		["span-verbatim-footnote", "Before `first\n[^fn]\nlast` after.", "Before first [^fn] last after.", { skipInlineCode: false }],
		["control-single-line-footnote", "Before `first [^fn] last` after.", "Before first [^fn] last after.", { skipInlineCode: false }],
		["span-verbatim-image", "Before `first\n![alt](d.png)\nlast` after.", "Before first ![alt](d.png) last after.", { skipInlineCode: false }],
		["control-single-line-image", "Before `first ![alt](d.png) last` after.", "Before first ![alt](d.png) last after.", { skipInlineCode: false }],
		["span-verbatim-link", "Before `first\n[link](d.png)\nlast` after.", "Before first [link](d.png) last after.", { skipInlineCode: false }],
		["control-single-line-link", "Before `first [link](d.png) last` after.", "Before first [link](d.png) last after.", { skipInlineCode: false }],
		["span-verbatim-bareurl", "Before `first\nhttps://x.com/p\nlast` after.", "Before first https://x.com/p last after.", { skipInlineCode: false }],
		["control-single-line-bareurl", "Before `first https://x.com/p last` after.", "Before first https://x.com/p last after.", { skipInlineCode: false }],
		["span-verbatim-autolink", "Before `first\n<https://x.com>\nlast` after.", "Before first <https://x.com> last after.", { skipInlineCode: false }],
		["control-single-line-autolink", "Before `first <https://x.com> last` after.", "Before first <https://x.com> last after.", { skipInlineCode: false }],
		["span-verbatim-tag", "Before `first\n#tag\nlast` after.", "Before first #tag last after.", { skipInlineCode: false }],
		["control-single-line-tag", "Before `first #tag last` after.", "Before first #tag last after.", { skipInlineCode: false }],
		["span-verbatim-strike", "Before `first\n~~strike~~\nlast` after.", "Before first ~~strike~~ last after.", { skipInlineCode: false }],
		["control-single-line-strike", "Before `first ~~strike~~ last` after.", "Before first ~~strike~~ last after.", { skipInlineCode: false }],
		// F4: the backslash-escape branch used to fire inside the region, so a
		// code span lost the backslash a renderer keeps.
		["span-verbatim-escape-pct", "Before `first\n\\%%kept\\%%\nlast` after.", "Before first \\%%kept\\%% last after.", { skipInlineCode: false }],
		["control-single-line-escape-pct", "Before `first \\%%kept\\%% last` after.", "Before first \\%%kept\\%% last after.", { skipInlineCode: false }],
		["span-verbatim-escape-star", "Before `first\n\\*star\\*\nlast` after.", "Before first \\*star\\* last after.", { skipInlineCode: false }],
		["control-single-line-escape-star", "Before `first \\*star\\* last` after.", "Before first \\*star\\* last after.", { skipInlineCode: false }],
		// F7, the URL half. The speakUrls:false rows are the ones that prove the
		// BARE-URL branch is guarded as well as the autolink branch: guarding the
		// autolink branch alone puts a spoken stray `<` back, which is worse than
		// guarding neither (measured in NRL-39's verify phase).
		["span-verbatim-autolink-urls-off", "Before `first\n<https://x.com>\nlast` after.", "Before first <https://x.com> last after.", { skipInlineCode: false, speakUrls: false }],
		["control-single-line-autolink-urls-off", "Before `first <https://x.com> last` after.", "Before first <https://x.com> last after.", { skipInlineCode: false, speakUrls: false }],
		["span-verbatim-bareurl-urls-off", "Before `first\nhttps://x.com/p\nlast` after.", "Before first https://x.com/p last after.", { skipInlineCode: false, speakUrls: false }],
		["control-single-line-bareurl-urls-off", "Before `first https://x.com/p last` after.", "Before first https://x.com/p last after.", { skipInlineCode: false, speakUrls: false }],
		// N2: a backtick run whose length is not the carried one is content, not a
		// closer, so it is spoken literally when code is spoken and silenced with
		// the rest of the region when code is skipped.
		["span-verbatim-mismatched-run", "Before ``a\nb ` c\nd`` after.", "Before a b ` c d after.", { skipInlineCode: false }],
		["control-single-line-mismatched-run", "Before ``a b ` c d`` after.", "Before a b ` c d after.", { skipInlineCode: false }],
		["span-skipped-mismatched-run", "Before ``a\nb ` c\nd`` after.", "Before after.", { skipInlineCode: true }],
		// The tail after the carried closer is ordinary markdown again: the region
		// ends at the closer, it does not spill into the rest of the line.
		["span-tail-after-closer-is-markdown", "Before `first\nmid` **bold** after.", "Before first mid bold after.", { skipInlineCode: false }],
		// Out of scope, pinned so the ticket that owns each one changes it on
		// purpose rather than by accident - exactly as NRL-42 pinned this ticket.
		// N1 is CLOSED by NRL-64 (docs/adr/0006 clause 4, docs/adr/0019 clause 3).
		// extractChunks now runs codeSpanClosesLater BEFORE cleanLine commits the
		// opening line, and re-cleans that line with the confirmed run length, so
		// the tail after the unmatched run is part of the literal region. The
		// expected value moved from "Before a c d after." for that reason; the row
		// is the AC's named fixture, not a weakened pin. Each row below is paired
		// with the single-line span that is its oracle, the same shape NRL-44 used:
		// a single-line span has always been verbatim and option-independent, and
		// the opening line of a confirmed soft-wrapped span is now no different.
		["pin-nrl64-opening-line", "Before `a %%b%% c\nd` after.", "Before a %%b%% c d after.", { skipInlineCode: false }],
		["control-nrl64-single-line", "Before `a %%b%% c d` after.", "Before a %%b%% c d after.", { skipInlineCode: false }],
		["nrl64-opening-line-skipped", "Before `a %%b%% c\nd` after.", "Before after.", { skipInlineCode: true }],
		["control-single-line-skipped", "Before `a %%b%% c d` after.", "Before after.", { skipInlineCode: true }],
		["nrl64-double-run", "Before ``a %%b%% c\nd`` after.", "Before a %%b%% c d after.", { skipInlineCode: false }],
		["control-nrl64-double-run", "Before ``a %%b%% c d`` after.", "Before a %%b%% c d after.", { skipInlineCode: false }],
		["nrl64-triple-run", "Before ```a %%b%% c\nd``` after.", "Before a %%b%% c d after.", { skipInlineCode: false }],
		["control-nrl64-triple-run", "Before ```a %%b%% c d``` after.", "Before a %%b%% c d after.", { skipInlineCode: false }],
		["nrl64-html-comment", "Before `a <!--b--> c\nd` after.", "Before a <!--b--> c d after.", { skipInlineCode: false }],
		["control-nrl64-html-comment", "Before `a <!--b--> c d` after.", "Before a <!--b--> c d after.", { skipInlineCode: false }],
		// The general form, not a list of exempt constructs (ADR 0019): the opening
		// line's tail is verbatim for every inline construct, not just comments.
		["nrl64-markdown-literal", "Before `a **bold** #tag c\nd` after.", "Before a **bold** #tag c d after.", { skipInlineCode: false }],
		["control-nrl64-markdown-literal", "Before `a **bold** #tag c d` after.", "Before a **bold** #tag c d after.", { skipInlineCode: false }],
		// A COMPLETE span earlier on the same line is untouched; the region starts
		// at the first UNMATCHED run, and the prose between the two is still prose.
		["nrl64-two-runs-same-line", "Before `a %%b%% c` d `e %%f%% g\nh` after.", "Before a %%b%% c d e %%f%% g h after.", { skipInlineCode: false }],
		["control-nrl64-two-runs-same-line", "Before `a %%b%% c` d `e %%f%% g h` after.", "Before a %%b%% c d e %%f%% g h after.", { skipInlineCode: false }],
		// Disclosure direction, the one NRL-42's ship phase found a HIGH defect in.
		// In each of these codeSpanClosesLater finds no closer, or finds a hidden-
		// comment opener first, so NO region is armed on the opening line and the
		// block comment still hides its text. Every expected value below was
		// measured on the pre-fix tree and must not move.
		["guard-nrl64-no-closer-anywhere", "Before `a tail\n%%\nSENTINEL\n%%\nend.", "Before a tail end.", { skipInlineCode: false }],
		["guard-nrl64-opener-before-closer", "Before `a tail\n%%\nSENTINEL\n%%\nd` after.", "Before a tail d after.", { skipInlineCode: false }],
		["guard-nrl64-html-opener-before-closer", "Before `a tail\n<!--\nSENTINEL\n-->\nd` after.", "Before a tail d after.", { skipInlineCode: false }],
		["guard-nrl64-mismatched-no-closer", "Before ``a tail\nb ` c\n%%\nSENTINEL\n%%\nend.", "Before a tail b c end.", { skipInlineCode: false }],
		["guard-nrl64-stray-backtick-prose", "Before `a tail\nmore prose.\n\n%%\nSENTINEL\n%%", "Before a tail more prose.", { skipInlineCode: false }],
		["guard-nrl64-stray-backtick-prose-skipped", "Before `a tail\nmore prose.\n\n%%\nSENTINEL\n%%", "Before a tail more prose.", { skipInlineCode: true }],
		["guard-nrl64-blank-breaks-span", "Before `a %%b%% c\n\nd` after.", "Before a c d after.", { skipInlineCode: false }],
		["guard-nrl64-heading-breaks-span", "Before `a %%b%% c\n# H\nd` after.", "Before a c H d after.", { skipInlineCode: false }],
		// A carry must never be armed off a heading, a quote or a list line: a span
		// cannot leave its own block. These three pin that end to end. They do not
		// isolate the hoisted `blockType === "paragraph"` test, and saying so is
		// the point: codeSpanClosesLater already runs interruptsParagraph over the
		// opening line, which matches HEADING, BLOCKQUOTE and LIST_BULLET, so
		// deleting that test changed 0 of 9,792 measured extractions. The guard is
		// redundant belt-and-braces, and these rows stay red if EITHER of the two
		// things holding the rule up is removed.
		["guard-nrl64-opening-line-is-heading", "# Before `a %%b%% c\nd` after.", "Before a c d after.", { skipInlineCode: false }],
		["guard-nrl64-opening-line-is-quote", "> Before `a %%b%% c\n> d` after.", "Before a c d after.", { skipInlineCode: false }],
		["guard-nrl64-opening-line-is-list", "- Before `a %%b%% c\n  d` after.", "Before a c d after.", { skipInlineCode: false }],
		// The confirmation is armed AFTER the LINK_REF_DEF drop, so a definition
		// line carrying an unmatched run still hands no carry to the next line
		// (ADR 0018). Dropping the line and arming the carry would make the next
		// line a continuation of a span whose opener was never spoken.
		["guard-nrl64-linkrefdef-with-run", "[a]: `x.png\nlast ` here.", "last here.", { skipInlineCode: false }],
		// The region still ends at the carried closer, not at end of line.
		["guard-nrl64-tail-after-closer", "Before `a %%b%% c\nmid` **bold** after.", "Before a %%b%% c mid bold after.", { skipInlineCode: false }],
		// F9, NRL-63, now fixed: an image whose alt text crosses a soft line break
		// is recognised across it, so its destination is silent and speakImageAlt
		// governs the alt. The pin's VALUE moved; the row did not. Each of the
		// three below has a single-line control beside it, and the two must agree
		// character for character - that equality is the fix, not the value.
		["pin-nrl63-softwrapped-image", "A ![alt\nwords](zdestz.png) B", "A alt words B", { skipInlineCode: false }],
		["control-nrl63-single-line-image", "A ![alt words](zdestz.png) B", "A alt words B", { skipInlineCode: false }],
		["nrl63-softwrapped-image-silenced", "A ![alt\nwords](zdestz.png) B", "A B", { speakImageAlt: false }],
		["control-nrl63-single-line-image-silenced", "A ![alt words](zdestz.png) B", "A B", { speakImageAlt: false }],
		// The same scanner covers a soft-wrapped LINK, and a markdown link's
		// destination is dropped in both speakUrls positions (that setting governs
		// bare URLs and autolinks, ADR 0003), so both rows read the label only.
		["nrl63-softwrapped-link", "A [lab\nwords](zdestz.png) B", "A lab words B"],
		["nrl63-softwrapped-link-urls-on", "A [lab\nwords](zdestz.png) B", "A lab words B", { speakUrls: true }],
		["control-nrl63-single-line-link", "A [lab words](zdestz.png) B", "A lab words B"],
		// The `[ref]` tail of the reference form goes too, exactly as it does on
		// one line (srs.md R-M09).
		["nrl63-reference-form", "A ![alt\nwords][zrefz] B", "A B", { speakImageAlt: false }],
		// A label may cross several breaks; the carry holds until the `]`.
		["nrl63-three-lines-silenced", "A ![alt\nmid\nwords](zdestz.png) B", "A B", { speakImageAlt: false }],
		["nrl63-three-lines-spoken", "A ![alt\nmid\nwords](zdestz.png) B", "A alt mid words B", { speakImageAlt: true }],
		// Label content is re-cleaned, not emitted raw, so nested markup and a
		// complete comment span inside a soft-wrapped label behave as on one line.
		["nrl63-nested-markup-in-label", "A ![**alt**\n#tag words](zdestz.png) B", "A alt words B"],
		["nrl63-comment-in-label", "A ![alt %%SENTINEL%%\nwords](zdestz.png) B", "A alt words B"],
		// Prose-loss direction. A label that never closes, or whose closer is past
		// a paragraph boundary, is never recognised, so nothing is swallowed and
		// every one of these is byte-identical to the pre-NRL-63 tree - with ONE
		// carve-out: guard-nrl63-opening-line-is-list below was REPLACED IN PLACE
		// by NRL-98, which recognises a container-prefixed label, so that row is
		// no longer identical to the pre-NRL-63 tree. Its heading sibling still is.
		["guard-nrl63-never-closed", "A ![alt\nwords B\n\nlast here.", "A [alt words B last here."],
		["guard-nrl63-blank-breaks-label", "A ![alt\n\nwords](zdestz.png) B", "A [alt words](zdestz.png) B"],
		["guard-nrl63-heading-breaks-label", "A ![alt\n# H\nwords](zdestz.png) B", "A [alt H words](zdestz.png) B"],
		["guard-nrl63-comment-opener-breaks-label", "A ![alt\n%%\nSENTINEL\n%%\nwords](zdestz.png) B", "A [alt words](zdestz.png) B"],
		// The math-block stop is precise rather than blanket: a stray `$$` with no
		// closer anywhere is not a block, extractChunks does not consume it, and
		// the carry still works, so the destination is still silenced. (The
		// closed-block case cannot live in this table - see the block below.)
		["guard-nrl63-stray-math-still-carries", "PA ![alt W1 W2\n$$ stray\nW3](zdestz.png) PC", "PA PC", { speakImageAlt: false }],
		["guard-nrl63-opening-line-is-heading", "# A ![alt\nwords](zdestz.png) B", "A [alt words](zdestz.png) B"],
		// REPLACED IN PLACE by NRL-98, keeping the name, per the NRL-66/NRL-67
		// convention. It was root 1's bullet member and is now carried: module
		// 745 strips the marker and up to four leading spaces per line and
		// tokenizes the JOINED remainder, so Obsidian renders one image here and
		// the destination is an attribute it does not display. Measured at
		// e4c9c1d as "A [alt words](zdestz.png) B". Its ATX sibling above is NOT
		// replaced and must not be: a heading is one line and cannot soft-wrap.
		["guard-nrl63-opening-line-is-list", "- A ![alt\n  words](zdestz.png) B", "A alt words B"],
		// A shortcut `![alt\nwords]` carries no destination and renders literally
		// when nothing defines the reference, so the carry deliberately requires
		// `](` or `][` on the closing line and this stays spoken (ADR 0023).
		["guard-nrl63-shortcut-no-tail", "A ![alt\nwords] B", "A [alt words] B", { speakImageAlt: false }],
		// Both carries live on one line, in both directions. First: a code span
		// carried in closes, then an image opens and carries out.
		["nrl63-code-carry-then-image", "A `x\ny` z ![alt\nwords](zdestz.png) B", "A x y z alt words B", { skipInlineCode: false }],
		// Second: both open on the same line, where the code carry wins because a
		// code span binds tighter than a label. Both rows are byte-identical to
		// the pre-NRL-63 tree and pin the residual ADR 0023 records - the
		// destination is still spoken here.
		["guard-nrl63-code-wins-inside-label", "A ![alt `x\ny` words](zdestz.png) B", "A [alt x y words](zdestz.png) B", { skipInlineCode: false }],
		["guard-nrl63-code-wins-inside-label-skipped", "A ![alt `x\ny` words](zdestz.png) B", "A [alt words](zdestz.png) B"],
		// Nested bracket constructs in a label are the open R-M09 family this does
		// not close. The carry takes the FIRST unmatched opener, as the code carry
		// takes the first unmatched run, so the outer `[` claims the inner image's
		// `](`. Measured, and strictly fewer destination characters than the
		// pre-fix tree, which spoke both of them.
		["guard-nrl63-nested-label", "A [![alt\nwords](zdestz.png)](zouterz.png) B", "A [alt words ](zouterz.png) B", { speakImageAlt: false }],
		// NRL-68, closed as not-a-defect. A trailing mid-line %% is NOT a block
		// opener in Obsidian: its %% tokenizer is a block tokenizer, skips leading
		// spaces only, and then requires %% at the block start (read out of the
		// installed obsidian.asar, ADR 0006 clause 2). So HIDEME is displayed there
		// and speaking it is right. This is a GUARD, not a regression test - it
		// passes before and after NRL-68 because no code changed, and it exists so
		// the correct behaviour cannot be "fixed" back on the original bug report.
		["pin-nrl68-midline-opener-is-literal", "Plain prose %%\nHIDEME\n%%", "Plain prose %% HIDEME"],
		// The control for it: at the start of a line the same %% does open a block,
		// and the hidden text stays silent.
		["pin-nrl68-line-start-opener-hides", "%%\nHIDEME\n%%", ""],
		// The paragraph join added a second space after any line whose last
		// mapped character was already one.
		["join-inline-comment", "Before %%hidden%%\nafter.", "Before after."],
		["join-block-close-then-inline", "%%hidden\n%% before %%hidden%%\nafter.", "before after."],
		["join-comment-trailing-space", "Before %%hidden%% \nafter.", "Before after."],
		["join-crlf-unmatched-opener", "Before %% visible\r\nStill visible.", "Before %% visible Still visible."],
		["join-image", "Before ![alt](target)\nafter.", "Before after.", { speakImageAlt: false }],
		["join-image-spoken", "Before ![alt](target)\nafter.", "Before alt after.", { speakImageAlt: true }],
		["join-tag", "Before #tag\nafter.", "Before after."],
		["join-url", "Before https://example.com\nafter.", "Before after."],
		["join-single-space-unchanged", "Before %% visible\nStill visible.", "Before %% visible Still visible."],
	];
	for (const [id, src, expected, overrides] of cases) {
		const chunks = extractChunks(src, { ...OPTS, ...overrides });
		const spoken = chunks.map(c => c.text).join(" ");
		check(`NRL-42 ${id}: visible output`, spoken === expected);
		check(`NRL-42 ${id}: no doubled space`, !spoken.includes("  "));
		if (src.includes("SENTINEL")) {
			check(`NRL-42 ${id}: hidden text not disclosed`, !spoken.includes("SENTINEL"));
		}
		check(`NRL-42 ${id}: UTF-16 mapping and bounds`, chunks.every(c => {
			if (c.sourceIndex.length !== c.text.length || c.sourceStart !== c.sourceIndex[0] ||
				c.sourceEnd !== c.sourceIndex[c.text.length - 1]! + 1) return false;
			for (let i = 0; i < c.text.length; i++) {
				const at = c.sourceIndex[i]!;
				if (at < 0 || at >= src.length || (i > 0 && at < c.sourceIndex[i - 1]!)) return false;
				if (c.text[i] !== " " && src[at] !== c.text[i]) return false;
			}
			return true;
		}));
		// Raw-offset sentinel for the first word after each span or join. Each
		// of these occurs once in its fixture's source, outside any dropped
		// span, so a shifted map shows up here rather than only in the text.
		for (const word of ["after", "last", "tail", "end", "Still"]) {
			if (!expected.includes(word) || src.indexOf(word) !== src.lastIndexOf(word)) continue;
			const c = chunks.find(c => c.text.includes(word));
			check(`NRL-42 ${id}: ${word} offset`, c?.sourceIndex[c.text.indexOf(word)] === src.indexOf(word));
		}
	}
	// A confirmed span does not fold the paragraph break away.
	const paced = extractChunks("Before `x\n%%\nSENTINEL\n%%\ntail.\n\nNext `first\n%%literal%%\nlast` end.", { ...OPTS, skipInlineCode: false });
	check("NRL-42 paragraph boundaries retained", paced.length === 2);

	/*
	 * NRL-63: a display-math block between a label's opener and its closer.
	 *
	 * extractChunks consumes such a block with a `continue` that never reaches the
	 * carry site, so a carry armed on the line before it is read into
	 * carriedBracket and then dropped. Left unguarded that silences the label's
	 * words AND still speaks the destination - strictly worse than either
	 * recognising the label or not recognising it, and the one direction ADR 0023
	 * clause 3 exists to foreclose. bracketClosesLater therefore refuses to
	 * confirm across one, so this is byte-identical to the pre-NRL-63 tree in
	 * BOTH speakImageAlt positions.
	 *
	 * This cannot live in the table above. That harness asserts
	 * `src[sourceIndex[i]] === text[i]` for every non-space character, and the
	 * synthetic "equation" chunk deliberately maps all seven letters to the `$`
	 * offsets (docs/adr/0004), so it fails that clause on ANY math fixture -
	 * measured on base d1fff6e too, and with no label anywhere in the note. The
	 * length, bounds and monotonicity invariants below are the ones that do apply.
	 */
	{
		const src = "PA ![alt W1 W2\n$$\nq\n$$\nW3](zdestz.png) PC";
		for (const alt of [false, true]) {
			const chunks = extractChunks(src, { ...OPTS, speakImageAlt: alt });
			const spoken = chunks.map(c => c.text).join(" ");
			check(`NRL-63 math block breaks the label (speakImageAlt ${alt}): visible output`,
				spoken === "PA [alt W1 W2 equation W3](zdestz.png) PC");
			check(`NRL-63 math block breaks the label (speakImageAlt ${alt}): no prose lost`,
				["PA", "alt", "W1", "W2", "W3", "PC"].every(w => spoken.includes(w)));
			check(`NRL-63 math block breaks the label (speakImageAlt ${alt}): offsets sane`,
				chunks.every(c => {
					if (c.sourceIndex.length !== c.text.length) return false;
					for (let i = 0; i < c.text.length; i++) {
						const at = c.sourceIndex[i]!;
						if (at < 0 || at >= src.length || (i > 0 && at < c.sourceIndex[i - 1]!)) return false;
					}
					return true;
				}));
		}
	}

	/*
	 * NRL-44 F5, as an enforced invariant rather than a code change.
	 *
	 * opensHiddenComment tests the raw line and models no structural prefix, so a
	 * prefix that is NOT itself a paragraph interrupter would let a `%%` opener
	 * hide inside a carried span. There is no such prefix today: every family
	 * below is already in interruptsParagraph, so opensHiddenComment is only ever
	 * consulted about lines that already stop the carry search. This asserts that
	 * behaviourally - a span must not be able to carry across any of them - so
	 * adding a fifth, non-interrupting prefix family fails here loudly instead of
	 * opening a disclosure hole silently. interruptsParagraph itself is NOT
	 * touched by NRL-44 (NRL-45 depends on that).
	 *
	 * The sentinel is a CLOSED `%%` pair, which is not a block opener, so it is
	 * dropped as an inline comment when the line is ordinary markdown and spoken
	 * verbatim when the line is code-span content. Its absence is therefore proof
	 * that the line was NOT taken as code content.
	 */
	for (const [family, line] of [
		["HEADING", "# H %%SENTINEL%%"],
		["BLOCKQUOTE", "> q %%SENTINEL%%"],
		["LIST_BULLET", "- i %%SENTINEL%%"],
		["TABLE_ROW", "| a | %%SENTINEL%% |"],
	] as Array<[string, string]>) {
		const src = `Before \`x\n${line}\nlast\` after.`;
		const spoken = extractChunks(src, { ...OPTS, skipInlineCode: false, skipTables: false }).map(c => c.text).join(" ");
		check(`NRL-44 F5 ${family} is in interruptsParagraph: span cannot carry across it`, !spoken.includes("SENTINEL"), spoken);
	}
}

console.log("configurable content exclusions (NRL-21, R-M09/R-M13)");
{
	/*
	 * The content toggles only: every key of OPTS whose value is a boolean.
	 * `locale` is a string and is not a toggle, so a plain `keyof typeof OPTS`
	 * would let this sweep try to write `true` into it.
	 */
	type Key = { [K in keyof typeof OPTS]: (typeof OPTS)[K] extends boolean ? K : never }[keyof typeof OPTS];
	const say = (src: string, over: Partial<typeof OPTS> = {}): string =>
		extractChunks(src, { ...OPTS, ...over }).map((c) => c.text).join(" ");

	/*
	 * Every toggle, in both positions, on a fixture that isolates it.
	 *
	 * A fixture whose output is the same either way proves nothing about its
	 * toggle, which is the dead-switch defect this ticket exists to close. So
	 * each row asserts the two positions differ AND that flipping any of the
	 * other eight keys on the same fixture changes nothing: a toggle that
	 * quietly governs a second construct fails here.
	 */
	const toggles: Array<[Key, string, string, string]> = [
		// key, fixture, spoken with the key false, spoken with the key true
		["skipFrontmatter", "---\ntitle: Fixture\n---\nBody prose.", "title: Fixture Body prose.", "Body prose."],
		["skipCodeBlocks", "Body prose.\n\n```\nfenced code\n```", "Body prose. fenced code", "Body prose."],
		["skipInlineCode", "Body `inline code` prose.", "Body inline code prose.", "Body prose."],
		["speakUrls", "Body https://example.com/a prose.", "Body prose.", "Body example.com prose."],
		["speakImageAlt", "Body ![alt words](img.png) prose.", "Body prose.", "Body alt words prose."],
		["speakEmbeds", "Body ![[Target Note]] prose.", "Body prose.", "Body Target Note prose."],
		["stripTags", "Body #tagname prose.", "Body #tagname prose.", "Body prose."],
		["skipTables", "Body prose.\n\n| a | b |", "Body prose. | a | b |", "Body prose."],
		["skipHeadings", "# Heading Words\n\nBody prose.", "Heading Words Body prose.", "Body prose."],
	];
	const keys = toggles.map(([k]) => k);
	for (const [key, src, whenFalse, whenTrue] of toggles) {
		const off = say(src, { [key]: false });
		const on = say(src, { [key]: true });
		check(`${key} false speaks ${JSON.stringify(whenFalse)}`, off === whenFalse, `got: ${JSON.stringify(off)}`);
		check(`${key} true speaks ${JSON.stringify(whenTrue)}`, on === whenTrue, `got: ${JSON.stringify(on)}`);
		check(`${key} changes behaviour`, off !== on);
		for (const other of keys) {
			if (other === key) continue;
			for (const held of [false, true]) {
				const base = say(src, { [key]: held });
				const moved = say(src, { [key]: held, [other]: !OPTS[other] });
				check(
					`${key}=${held}: ${other} moves nothing`,
					base === moved,
					`got: ${JSON.stringify(moved)} want ${JSON.stringify(base)}`,
				);
			}
		}
	}

	// Frontmatter, spoken. Source-mapped key/value text with no YAML parse and
	// no reserialisation, so a value is heard exactly as it was written.
	const fmCases: Array<[string, string, string, string]> = [
		// id, source, spoken when skipped, spoken when read
		["fences-never-spoken", "---\ntitle: Fixture\n---\nBody prose.", "Body prose.", "title: Fixture Body prose."],
		["yaml-comment-dropped", "---\ntitle: T\n# a yaml comment\n---\nBody prose.", "Body prose.", "title: T Body prose."],
		["blank-line-dropped", "---\ntitle: T\n\nalias: A\n---\nBody prose.", "Body prose.", "title: T alias: A Body prose."],
		// Nothing is reserialised: no YAML parse, no reordering, no added words,
		// and every character keeps its own raw offset. A value does go through
		// the same inline cleaner as prose though, so bracket and emphasis
		// markup in it is stripped exactly as it would be in a paragraph. That
		// is the price of keeping URL and comment suppression inside a value,
		// which are the two things this path must not lose (ADR 0008).
		["no-reserialisation", "---\ntags: [a, b]\n---\nBody prose.", "Body prose.", "tags: a, b Body prose."],
		["value-cleaned-like-prose", "---\nnote: **bold** x\n---\nBody prose.", "Body prose.", "note: bold x Body prose."],
		["underscored-value-intact", "---\nnote: a_b_c\n---\nBody prose.", "Body prose.", "note: a_b_c Body prose."],
		["hash-in-value-kept", "---\ncolour: #ff0000\n---\nBody prose.", "Body prose.", "colour: #ff0000 Body prose."],
		["url-suppressed", "---\nsource: https://example.com/secret/path\n---\nBody prose.", "Body prose.", "source: Body prose."],
		["inline-code-literal", "---\nnote: `a_b`\n---\nBody prose.", "Body prose.", "note: a_b Body prose."],
		// A heading- or table-shaped value is metadata, not a Markdown block, so
		// the Markdown exclusions do not reach it.
		["heading-shaped-value", "---\nnote: \"# not a heading\"\n---\nBody prose.", "Body prose.", "note: \"# not a heading\" Body prose.", ],
		["table-shaped-value", "---\nnote: \"| a | b |\"\n---\nBody prose.", "Body prose.", "note: \"| a | b |\" Body prose."],
		// The recorded decision: a frontmatter line must never silence the note
		// body. An unmatched delimiter in a value is YAML text, which Obsidian
		// shows in the properties table, so it stays literal for `%%`; an
		// unmatched `<!--` ends its own line and nothing more.
		["unmatched-percent-cannot-hide-body", "---\nnote: %% tail\n---\nBody prose.", "Body prose.", "note: %% tail Body prose."],
		["unmatched-html-cannot-hide-body", "---\nnote: <!-- tail\n---\nBody prose.", "Body prose.", "note: Body prose."],
		// An unmatched backtick run is dropped and its text stays literal, as in
		// prose. The returned openCode is discarded, so the run cannot be
		// carried and the body is never treated as code content.
		["unmatched-backtick-cannot-hide-body", "---\nnote: `open\n---\nBody prose.", "Body prose.", "note: open Body prose."],
		["indented-percent-cannot-hide-body", "---\nnote:\n  %% tail\n---\nBody prose.", "Body prose.", "note: %% tail Body prose."],
		// A complete comment span is still excluded (ADR 0006).
		["complete-percent-span-suppressed", "---\nnote: %%SECRET%% visible\n---\nBody prose.", "Body prose.", "note: visible Body prose."],
		["complete-html-span-suppressed", "---\nnote: <!--SECRET--> visible\n---\nBody prose.", "Body prose.", "note: visible Body prose."],
		// Not frontmatter at all: unterminated, so it is a rule and read (ADR 0002
		// clause 4). Both positions agree, because there is no block to govern.
		["unterminated-is-not-frontmatter", "---\ntitle: x\nProse never closed.", "title: x Prose never closed.", "title: x Prose never closed."],
	];
	for (const [id, src, skipped, read] of fmCases) {
		const gotSkipped = say(src, { skipFrontmatter: true });
		const gotRead = say(src, { skipFrontmatter: false });
		check(`NRL-21 frontmatter ${id} skipped`, gotSkipped === skipped, `got: ${JSON.stringify(gotSkipped)}`);
		check(`NRL-21 frontmatter ${id} read`, gotRead === read, `got: ${JSON.stringify(gotRead)}`);
		if (src.includes("SECRET")) {
			check(`NRL-21 frontmatter ${id} never discloses a suppressed span`, !gotRead.includes("SECRET"));
		}
		// The note body is reachable either way: metadata cannot silence it.
		if (src.includes("Body prose.")) {
			check(`NRL-21 frontmatter ${id} body survives`, gotRead.includes("Body prose."), `got: ${JSON.stringify(gotRead)}`);
		}
		check(`NRL-21 frontmatter ${id} never speaks a fence`, !gotRead.includes("---"), `got: ${JSON.stringify(gotRead)}`);
	}

	// A frontmatter code span cannot reach the body: if it could, the body's `%%`
	// would be literal code and the hidden text would be read aloud.
	check(
		"NRL-21 an unmatched frontmatter backtick cannot make the body literal",
		say("---\nnote: `open\n---\nBefore %%SECRET%% after.", { skipFrontmatter: false }) === "note: open Before after.",
		say("---\nnote: `open\n---\nBefore %%SECRET%% after.", { skipFrontmatter: false }),
	);

	// Frontmatter is its own paragraph: it never merges into the first prose line.
	{
		const src = "---\ntitle: Fixture\n---\nBody prose.";
		const chunks = extractChunks(src, { ...OPTS, skipFrontmatter: false });
		check("NRL-21 frontmatter is its own chunk", chunks.length === 2 && chunks[0]?.text === "title: Fixture", JSON.stringify(chunks.map((c) => c.text)));
		check("NRL-21 frontmatter maps to its raw offsets", chunks[0]?.sourceIndex[0] === src.indexOf("title"), String(chunks[0]?.sourceIndex[0]));
		check("NRL-21 body after spoken frontmatter maps to its raw offset", chunks[1]?.sourceIndex[0] === src.indexOf("Body"), String(chunks[1]?.sourceIndex[0]));
	}

	// Markdown images. The destination and any quoted title are a path, never
	// prose, in either position.
	const imgCases: Array<[string, string, string, string]> = [
		// id, source, spoken when dropped, spoken when alt is read
		["inline", "Before ![alt words](img.png) after.", "Before after.", "Before alt words after."],
		["titled", 'Before ![alt words](img.png "The Title") after.', "Before after.", "Before alt words after."],
		["reference", "Before ![alt words][the-ref] after.", "Before after.", "Before alt words after."],
		["shortcut", "Before ![alt words] after.", "Before after.", "Before alt words after."],
		["empty-alt", "Before ![](img.png) after.", "Before after.", "Before after."],
		["nested-markup", "Before ![**bold** alt](img.png) after.", "Before after.", "Before bold alt after."],
		["comment-in-alt", "Before ![alt %%SECRET%% words](img.png) after.", "Before after.", "Before alt words after."],
		["escape-in-alt", "Before ![a\\*b](img.png) after.", "Before after.", "Before a*b after."],
		// No closing `]`, so this is not an image in either position: the `!` is
		// dropped and the single-bracket path keeps the rest as prose. Unchanged
		// by this ticket, and pinned so it stays that way.
		["unterminated", "Before ![alt words after.", "Before [alt words after.", "Before [alt words after."],
	];
	for (const [id, src, dropped, spokenAlt] of imgCases) {
		const off = say(src, { speakImageAlt: false });
		const on = say(src, { speakImageAlt: true });
		check(`NRL-21 image ${id} dropped`, off === dropped, `got: ${JSON.stringify(off)}`);
		check(`NRL-21 image ${id} alt spoken`, on === spokenAlt, `got: ${JSON.stringify(on)}`);
		for (const [label, got] of [["off", off], ["on", on]] as const) {
			check(`NRL-21 image ${id} (${label}) never speaks the destination`, !got.includes("img.png") && !got.includes("the-ref"), `got: ${JSON.stringify(got)}`);
			check(`NRL-21 image ${id} (${label}) never speaks a title`, !got.includes("The Title"), `got: ${JSON.stringify(got)}`);
			check(`NRL-21 image ${id} (${label}) never discloses a comment`, !got.includes("SECRET"), `got: ${JSON.stringify(got)}`);
		}
	}
	// The reference-form leak this ticket found by running the old module: the
	// `[ref]` tail was not consumed, so the link branch spoke the reference id.
	check("NRL-21 reference-form tail no longer leaks the reference id", !say("Before ![alt][ref] after.", { speakImageAlt: false }).includes("ref"), say("Before ![alt][ref] after.", { speakImageAlt: false }));

	/*
	 * Pinned, not fixed: a label containing another bracket construct.
	 *
	 * inlineContainerClose (extract.ts:229) skips escapes, code spans and
	 * comments but does not balance brackets, so the label of
	 * `![a [[N|l]] b](img.png)` ends at the first `]` of `]]` and the leftover
	 * `](img.png)` is spoken as prose - the destination included. That is not
	 * something this ticket introduced: every `speakImageAlt: false` string
	 * below is byte-identical to the merge base, and the pure-link form is
	 * identical on the base and here, because both branches share the scanner.
	 * What did change is that the alt is now read alongside the leftover, so
	 * the shape is audible by default. Balancing brackets means changing the
	 * scanner every inline branch calls, which is its own ticket with its own
	 * reproduction; pinning it here is what stops it moving by accident.
	 */
	const nestedLabel: Array<[string, string, string, string]> = [
		// id, source, spoken with alt dropped, spoken with alt read
		["wikilink-in-alt", "Before ![a [[N|l]] b](img.png) after.", "Before ] b](img.png) after.", "Before a N|l ] b](img.png) after."],
		["image-in-alt", "Before ![a ![b](in.png) c](img.png) after.", "Before c](img.png) after.", "Before a [b c](img.png) after."],
		["link-in-alt", "Before ![a [lab](u.html) b](img.png) after.", "Before b](img.png) after.", "Before a [lab b](img.png) after."],
		// The same scanner, reached through the link branch, which this ticket
		// did not touch: identical in both positions and on the merge base.
		["wikilink-in-link-label", "Before [a [[N|l]] b](out.html) after.", "Before a N|l ] b](out.html) after.", "Before a N|l ] b](out.html) after."],
		// `[[N]]` glued to an image is not a reference label, but the tail is
		// consumed as one, exactly as the link branch consumes it. The merge
		// base spoke `N` here; neither output is meaningful and diverging from
		// the link branch for this shape would be worse than matching it.
		["wikilink-tail", "Before ![alt][[N]] after.", "Before ] after.", "Before alt ] after."],
	];
	for (const [id, src, dropped, read] of nestedLabel) {
		check(`NRL-21 pin nested-label ${id} dropped`, say(src, { speakImageAlt: false }) === dropped, `got: ${JSON.stringify(say(src, { speakImageAlt: false }))}`);
		check(`NRL-21 pin nested-label ${id} read`, say(src, { speakImageAlt: true }) === read, `got: ${JSON.stringify(say(src, { speakImageAlt: true }))}`);
	}

	// Embeds speak a label for the local reference, never the transcluded file.
	const embedCases: Array<[string, string, string, string]> = [
		// id, source, spoken when dropped, spoken when read
		["note", "Before ![[Some Note]] after.", "Before after.", "Before Some Note after."],
		["alias", "Before ![[Some Note|the alias]] after.", "Before after.", "Before the alias after."],
		["heading", "Before ![[Some Note#Section Two]] after.", "Before after.", "Before Some Note Section Two after."],
		["block-id", "Before ![[Some Note#^abc123]] after.", "Before after.", "Before Some Note after."],
		["empty-alias", "Before ![[Some Note|]] after.", "Before after.", "Before Some Note after."],
		// Sizing is layout, not prose, and the target is a file path, so an
		// image embed with only a sizing alias says nothing at all.
		["sizing-width", "Before ![[pic.png|200]] after.", "Before after.", "Before after."],
		["sizing-both", "Before ![[pic.png|200x100]] after.", "Before after.", "Before after."],
		["sizing-upper-x", "Before ![[pic.png|200X100]] after.", "Before after.", "Before after."],
		// A file target is a destination; only a meaningful alias is prose.
		["file-no-alias", "Before ![[pic.png]] after.", "Before after.", "Before after."],
		["file-with-alias", "Before ![[pic.png|A red bicycle]] after.", "Before after.", "Before A red bicycle after."],
		["pdf-no-alias", "Before ![[report.pdf]] after.", "Before after.", "Before after."],
		["markdown-target-spoken", "Before ![[Some Note.md]] after.", "Before after.", "Before Some Note.md after."],
		["nested-markup-alias", "Before ![[T|**bold** alias]] after.", "Before after.", "Before bold alias after."],
		["comment-in-alias", "Before ![[T|alias %%SECRET%% words]] after.", "Before after.", "Before alias words after."],
		["unterminated", "Before ![[Some Note after.", "Before Some Note after.", "Before Some Note after."],
		/*
		 * A dot means a file, with no cap on the extension's length and no
		 * restriction on its characters (ADR 0008 clause 5). The earlier rule
		 * tested `/\.([A-Za-z0-9]{1,8})$/`, so an extension of nine or more
		 * characters, or one carrying a hyphen, fell through to the note-title
		 * path and read the whole filename aloud with `speakEmbeds` on. Every
		 * row below is a real extension and every one of them spoke before.
		 */
		["long-ext-webmanifest", "Before ![[document.webmanifest]] after.", "Before after.", "Before after."],
		["long-ext-storyboard", "Before ![[design.storyboard]] after.", "Before after.", "Before after."],
		["long-ext-properties", "Before ![[app.properties]] after.", "Before after.", "Before after."],
		["long-ext-jsonschema", "Before ![[schema.jsonschema]] after.", "Before after.", "Before after."],
		["long-ext-xcodeproj", "Before ![[Thing.xcodeproj]] after.", "Before after.", "Before after."],
		["long-ext-handlebars", "Before ![[page.handlebars]] after.", "Before after.", "Before after."],
		["long-ext-postscript", "Before ![[art.postscript]] after.", "Before after.", "Before after."],
		["punctuated-ext-hyphen", "Before ![[archive.tar-gz]] after.", "Before after.", "Before after."],
		["punctuated-ext-plus", "Before ![[main.c++]] after.", "Before after.", "Before after."],
		["punctuated-ext-underscore", "Before ![[data.x_y]] after.", "Before after.", "Before after."],
		["long-ext-in-folder", "Before ![[assets/deep/site.webmanifest]] after.", "Before after.", "Before after."],
		["long-ext-with-alias", "Before ![[document.webmanifest|The manifest]] after.", "Before after.", "Before The manifest after."],
		["long-ext-with-heading", "Before ![[design.storyboard#Scene One]] after.", "Before after.", "Before after."],
		// A leading-dot name is all extension and no stem, so it is a file.
		["dotfile", "Before ![[.gitignore]] after.", "Before after.", "Before after."],
		// A trailing dot has an empty extension, which is not `md`, so the
		// target is a file and stays silent rather than being read as a title.
		["trailing-dot", "Before ![[Some Note.]] after.", "Before after.", "Before after."],
		/*
		 * The cost of the rule, pinned deliberately: a note whose TITLE holds a
		 * dot is classified as a file and an embed of it says nothing. ADR 0008
		 * clause 5 chooses that direction on purpose - silence on a title is
		 * recoverable and an alias speaks it, whereas reading a path is the
		 * thing R-M09 asks us not to do. A `[[wikilink]]` to the same note is
		 * unaffected, because only the embed branch classifies a target.
		 */
		["dotted-note-title", "Before ![[Version 1.2 notes]] after.", "Before after.", "Before after."],
		["dotted-note-title-alias", "Before ![[Version 1.2 notes|the release]] after.", "Before after.", "Before the release after."],
		// Markdown is still a note in both spellings, so both are spoken.
		["markdown-long-target-spoken", "Before ![[Some Note.markdown]] after.", "Before after.", "Before Some Note.markdown after."],
		["markdown-target-uppercase", "Before ![[Some Note.MD]] after.", "Before after.", "Before Some Note.MD after."],
		// Classification trims, so a stray space around the target does not
		// turn a note into a file. Emission is untrimmed, as before.
		["markdown-target-padded", "Before ![[Some Note.md ]] after.", "Before after.", "Before Some Note.md after."],
		/*
		 * A target with NO dot at all is a note name, not a path, so it is read
		 * as the label exactly as a `[[wikilink]]` target is. That is a recorded
		 * decision (ADR 0008 clause 5), not an oversight: an extensionless file
		 * is indistinguishable from a note title, and an embed of a note must
		 * keep the wikilink parity srs.md promises.
		 */
		["no-extension-dockerfile", "Before ![[Dockerfile]] after.", "Before after.", "Before Dockerfile after."],
		["no-extension-licence", "Before ![[LICENSE]] after.", "Before after.", "Before LICENSE after."],
		/*
		 * NRL-46 / ADR 0017: the label is the target's FINAL path segment, on
		 * either separator, so the folder segments above it are never read
		 * aloud. Every row below spoke its whole path before the change; the
		 * sentinel rows exist so a regression fails by name rather than by
		 * string diff.
		 */
		["folder-nested", "Before ![[private/folder/Secret Note]] after.", "Before after.", "Before Secret Note after."],
		["folder-leading-slash", "Before ![[/Leading Slash]] after.", "Before after.", "Before Leading Slash after."],
		["folder-windows", "Before ![[C:\\Users\\me\\Secret Note]] after.", "Before after.", "Before Secret Note after."],
		["folder-mixed-sep", "Before ![[a/b\\c/Secret Note]] after.", "Before after.", "Before Secret Note after."],
		["folder-trailing-sep", "Before ![[folder/]] after.", "Before after.", "Before folder after."],
		["folder-trailing-sep-nested", "Before ![[folder/subfolder/]] after.", "Before after.", "Before subfolder after."],
		["folder-sep-only", "Before ![[/]] after.", "Before after.", "Before after."],
		["folder-sentinel", "Before ![[FOLDERSENTINEL/deep/Leaf Note]] after.", "Before after.", "Before Leaf Note after."],
		["folder-sentinel-windows", "Before ![[DRIVESENTINEL:\\FOLDERSENTINEL\\Leaf Note]] after.", "Before after.", "Before Leaf Note after."],
		/*
		 * The one row that moves isFileTarget in the DISCLOSING direction, so
		 * it is pinned deliberately. Splitting the final segment on `\` too
		 * means the only dot here lives in a FOLDER, not in the leaf, so this
		 * target is reclassified from file (silent before) to note. It is only
		 * safe because the label is simultaneously reduced to `Note`: before
		 * the change this row read "Before after." in both positions.
		 */
		["folder-windows-dotted-folder", "Before ![[C:\\v1.2\\Note]] after.", "Before after.", "Before Note after."],
		/*
		 * A URL target reduces to its host by the R-M09 URL rule (hostSpan),
		 * which is also what strips the userinfo. The dotted-leaf row stays
		 * silent because the isFileTarget guard runs first, on purpose.
		 */
		["folder-url", "Before ![[https://example.com/a/b]] after.", "Before after.", "Before example.com after."],
		["folder-url-cred", "Before ![[https://CREDSENTINEL:CREDSENTINEL@example.com/FOLDERSENTINEL/x]] after.", "Before after.", "Before example.com after."],
		["folder-url-dotted-leaf", "Before ![[https://x.com/a.png]] after.", "Before after.", "Before after."],
	];
	for (const [id, src, dropped, read] of embedCases) {
		const off = say(src, { speakEmbeds: false });
		const on = say(src, { speakEmbeds: true });
		check(`NRL-21 embed ${id} dropped`, off === dropped, `got: ${JSON.stringify(off)}`);
		check(`NRL-21 embed ${id} read`, on === read, `got: ${JSON.stringify(on)}`);
		for (const [label, got] of [["off", off], ["on", on]] as const) {
			check(`NRL-21 embed ${id} (${label}) never speaks a bracket`, !got.includes("[") && !got.includes("]"), `got: ${JSON.stringify(got)}`);
			check(`NRL-21 embed ${id} (${label}) never discloses a comment`, !got.includes("SECRET"), `got: ${JSON.stringify(got)}`);
			check(`NRL-21 embed ${id} (${label}) never speaks an image destination`, !got.includes("pic.png") && !got.includes("report.pdf"), `got: ${JSON.stringify(got)}`);
			// NRL-46: a folder segment, a drive letter and a URL's userinfo are
			// all destination-shaped, so none of them may ever be spoken.
			check(
				`NRL-46 embed ${id} (${label}) never speaks a folder, drive or credential sentinel`,
				!got.includes("FOLDERSENTINEL") && !got.includes("DRIVESENTINEL") && !got.includes("CREDSENTINEL"),
				`got: ${JSON.stringify(got)}`,
			);
		}
	}

	/*
	 * The extension rule has no upper bound, so assert that directly rather
	 * than only through the table above: a filename of any extension length
	 * except `md` / `markdown` is silent in both toggle positions, and its
	 * stem is the sentinel, so a spoken path fails here by name.
	 */
	for (let len = 1; len <= 24; len++) {
		const ext = "z".repeat(len);
		const src = `Before ![[SENTINELSTEM.${ext}]] after.`;
		for (const speakEmbeds of [false, true]) {
			const got = say(src, { speakEmbeds });
			check(`NRL-21 embed extension of ${len} char(s) is silent (speakEmbeds ${speakEmbeds})`, got === "Before after.", `got: ${JSON.stringify(got)}`);
			check(`NRL-21 embed extension of ${len} char(s) speaks no stem (speakEmbeds ${speakEmbeds})`, !got.includes("SENTINELSTEM"), `got: ${JSON.stringify(got)}`);
		}
	}

	/*
	 * NRL-46 / ADR 0017: a link label is the target's FINAL path segment.
	 *
	 * The table drives BOTH constructs from one target so the parity srs.md
	 * promises is asserted rather than assumed: emitWikiLabel is shared, and a
	 * row that diverged would fail here before it failed the embed table above.
	 * Every row also runs in both `speakUrls` positions, because a wikilink
	 * label is spoken regardless of that setting - including a URL target,
	 * whose host reduction is therefore unconditional.
	 *
	 * `embedSilent` marks the rows where the embed branch's isFileTarget guard
	 * fires first and silences the target; parity does not apply there, by
	 * design (ADR 0008 clause 5 errs towards silence).
	 */
	const linkTargets: Array<[string, string, string, boolean]> = [
		// id, target text between the brackets, spoken label, embed silent?
		["nested-folders", "private/folder/Secret Note", "Secret Note", false],
		["leading-slash", "/Leading Slash", "Leading Slash", false],
		// No-regression anchors: these two spoke the right thing before the
		// change and must keep doing so. The alias is the existing workaround
		// for the disambiguation the final-segment rule gives up.
		["single-segment", "Some Note", "Some Note", false],
		["alias-overrides", "private/folder/Secret Note|the alias", "the alias", false],
		["windows-path", "C:\\Users\\me\\Secret Note", "Secret Note", false],
		["mixed-separators", "a/b\\c/Secret Note", "Secret Note", false],
		// The disclosing-direction reclassification: silent as an embed before.
		["windows-dotted-folder", "C:\\v1.2\\Note", "Note", false],
		["trailing-separator", "folder/", "folder", false],
		["trailing-separator-nested", "folder/subfolder/", "subfolder", false],
		// Nothing left after the reduction, so nothing is spoken.
		["separator-only", "/", "", false],
		["heading-anchor", "Some Note#Section Two", "Some Note Section Two", false],
		["folder-and-heading", "private/folder/Secret Note#Section Two", "Secret Note Section Two", false],
		["folder-and-block-id", "private/folder/Secret Note#^abc123", "Secret Note", false],
		["url-userinfo", "https://CREDSENTINEL:CREDSENTINEL@example.com/a/b", "example.com", false],
		["url-www", "www.example.com/FOLDERSENTINEL/b", "example.com", false],
		["url-fragment", "https://example.com/a#frag", "example.com", false],
		["sentinel-folder", "FOLDERSENTINEL/deep/Leaf Note", "Leaf Note", false],
		["sentinel-drive", "DRIVESENTINEL:\\FOLDERSENTINEL\\Leaf Note", "Leaf Note", false],
		// isFileTarget runs before the URL rule, so a dotted final segment
		// silences the embed even though the wikilink reduces to the host.
		["url-dotted-leaf", "https://x.com/a.png", "x.com", true],
		["dotted-note-title", "Version 1.2 notes", "Version 1.2 notes", true],
	];
	for (const [id, target, label, embedSilent] of linkTargets) {
		const want = label === "" ? "Before after." : `Before ${label} after.`;
		for (const speakUrls of [false, true]) {
			const wiki = say(`Before [[${target}]] after.`, { speakUrls });
			check(`NRL-46 wikilink ${id} (speakUrls ${speakUrls})`, wiki === want, `got: ${JSON.stringify(wiki)}`);
			const on = say(`Before ![[${target}]] after.`, { speakUrls, speakEmbeds: true });
			check(
				`NRL-46 embed ${id} (speakUrls ${speakUrls}) ${embedSilent ? "is silenced by isFileTarget" : "matches the wikilink label"}`,
				on === (embedSilent ? "Before after." : want),
				`got: ${JSON.stringify(on)}`,
			);
			const off = say(`Before ![[${target}]] after.`, { speakUrls, speakEmbeds: false });
			check(`NRL-46 embed ${id} silent with speakEmbeds off (speakUrls ${speakUrls})`, off === "Before after.", `got: ${JSON.stringify(off)}`);
			for (const [pos, got] of [["wiki", wiki], ["embed on", on], ["embed off", off]] as const) {
				check(
					`NRL-46 ${id} (${pos}, speakUrls ${speakUrls}) discloses no folder, drive or credential`,
					!got.includes("FOLDERSENTINEL") && !got.includes("DRIVESENTINEL") && !got.includes("CREDSENTINEL"),
					`got: ${JSON.stringify(got)}`,
				);
			}
		}
	}

	/*
	 * NRL-66, replacing NRL-46's `pin-unterminated-by-escape` of the same two
	 * shapes IN PLACE: a wikilink or embed target ending in a backslash now
	 * closes on its `]]` and reduces to its final path segment like any other.
	 *
	 * Before this, the line held `\]]`, the shared `inlineContainerClose` ate
	 * the `\]` as an escape, no `]]` was ever found, the construct was treated
	 * as unterminated and the raw target - folder segments included - fell
	 * through to prose. `[[FOLDERSENTINEL/LEAFOK\]]` said the folder aloud,
	 * which is exactly what R-M09 and ADR 0017 promise it will not. The fix is
	 * `wikiTargetClose`, a wikilink/embed-LOCAL closing scan that skips code
	 * spans and complete comment spans the way the shared helper does but does
	 * NOT honour `\` as an escape, because inside a vault path a backslash is a
	 * separator - `isFileTarget` and `finalSegment` both already split on it.
	 *
	 * No reduction logic was added and none was needed: `finalSegment` already
	 * steps back over the trailing separator and the emission loop's
	 * `k >= segEnd && k < pathEnd` skip already drops it.
	 */
	for (const [src, want] of [
		// The two shapes NRL-46 pinned. The folder is now silent.
		["Before [[pinfolder\\Leaf Note\\]] after.", "Before Leaf Note after."],
		["Before ![[pinfolder\\Leaf Note\\]] after.", "Before Leaf Note after."],
		// The sentinel shape the NRL-46 privacy probe reported as its one
		// surviving path leak.
		["Before [[FOLDERSENTINEL/LEAFOK\\]] after.", "Before LEAFOK after."],
		["Before ![[FOLDERSENTINEL/LEAFOK\\]] after.", "Before LEAFOK after."],
		// Composition with NRL-67: newly recognised, so the target now routes
		// through emitWikiLabel and the comment-span exclusion applies to it.
		// Both the folder and the hidden text are silent.
		["Before [[a/b%%SECRET%%\\]] after.", "Before b after."],
		["Before ![[a/b%%SECRET%%\\]] after.", "Before b after."],
		["Before [[a/b<!--SECRET-->\\]] after.", "Before b after."],
	] as const) {
		const got = say(src, { speakEmbeds: true });
		check(`NRL-66 trailing-backslash target ${JSON.stringify(src)}`, got === want, `got: ${JSON.stringify(got)}`);
		check(
			`NRL-66 trailing-backslash target ${JSON.stringify(src)} discloses no folder or hidden text`,
			!got.includes("FOLDERSENTINEL") && !got.includes("SECRET") && !got.includes("pinfolder") && !got.includes("a/"),
			`got: ${JSON.stringify(got)}`,
		);
	}
	for (const src of ["Before ![[pinfolder\\Leaf Note\\]] after.", "Before ![[FOLDERSENTINEL/LEAFOK\\]] after."]) {
		const off = say(src, { speakEmbeds: false });
		check(`NRL-66 embed ${JSON.stringify(src)} silent with speakEmbeds off`, off === "Before after.", `got: ${JSON.stringify(off)}`);
	}

	/*
	 * Guards, not new behaviour: `wikiTargetClose` is deliberately LOCAL to the
	 * wikilink and embed branches, so the shared `inlineContainerClose` and
	 * every other construct that uses it must be byte-identical. All six were
	 * measured on both sides of the change and none moved. For an image, link
	 * or highlight, `\]` not closing the label is CommonMark-correct and the
	 * destination after the `]` is already dropped, so there is no privacy gain
	 * to trade against diverging from the renderer.
	 */
	for (const [src, want, over] of [
		// A `\` that is not immediately before the closer: the old and new scans
		// agree, and `\` is a path separator so the label is the final segment.
		["Before [[a\\]b]] after.", "Before ]b after.", {}],
		["Before ![alt\\](dest.png) after.", "Before [alt](dest.png) after.", {}],
		["Before [label\\](https://x.com) after.", "Before [label]( after.", {}],
		["Before ==hi\\== there== after.", "Before hi== there after.", {}],
		// A hidden or literal `]]` still cannot close the target.
		["Before `[[x/y\\]]` after.", "Before [[x/y\\]] after.", { skipInlineCode: false }],
	] as const) {
		const got = say(src, over);
		check(`NRL-66 guard (unmoved) ${JSON.stringify(src)}`, got === want, `got: ${JSON.stringify(got)}`);
	}

	/*
	 * NRL-67 pin, replacing NRL-46's pin of the same shape IN PLACE: a comment
	 * span inside a wikilink or embed TARGET is now silent, delimiters and
	 * content, and the visible text either side of it is still spoken.
	 *
	 * A link target is emitted raw rather than re-cleaned - deliberately, so the
	 * tag branch cannot eat `#Section` when stripTags is on. Before NRL-67 that
	 * also meant `cleanLine`'s comment branch never ran on a target, so a `%%`
	 * or `<!-- -->` span written inside the brackets was spoken, markers and all.
	 * NRL-46 pinned that as a pre-existing defect; NRL-67 fixes it by scanning
	 * the target for comment spans once and skipping them from the SAME raw
	 * emission loop, so every surviving character is still emitted at its own
	 * raw offset and `sourceIndex` stays in lockstep (docs/adr/0021, AGENTS.md
	 * rule 8). An unmatched opener is target-local: it silences from itself to
	 * the closing bracket and never consumes a later source line.
	 *
	 * Three things here are GUARDS on behaviour that was already correct, kept
	 * so it stops being accidental: the alias form, which has always dropped a
	 * complete span via `cleanLine`; the paired folder-is-dropped assertion from
	 * NRL-46; and the three embed shapes below, which stay SILENT because
	 * `isFileTarget` and `finalSegment` still classify the RAW target and the
	 * stripping is emission-only (ADR 0021, decision Q4). `![[a/b%%x.y%%]]` is
	 * the case that forces that rule: on a comment-stripped view its segment is
	 * `b`, no dot, a note, and the embed would START speaking - a silent-to-
	 * spoken move ADR 0008 clause 5 forbids.
	 */
	for (const [src, want] of [
		["Before [[pincomment/Leaf%%SECRET%%]] after.", "Before Leaf after."],
		["Before [[pincomment/<!--SECRET-->Leaf]] after.", "Before Leaf after."],
		["Before [[pincomment/Le%%SECRET%%af]] after.", "Before Leaf after."],
		// Unmatched: visible text before the opener survives, the rest is silent.
		["Before [[pincomment/Leaf%%SECRET]] after.", "Before Leaf after."],
		["Before [[pincomment/%%SECRET]] after.", "Before after."],
		["Before [[pincomment/Leaf<!--SECRET]] after.", "Before Leaf after."],
		// The `#` fragment leaks too, so the scan spans the whole target.
		["Before [[pincomment/Leaf#Section%%x%%]] after.", "Before Leaf Section after."],
		["Before [[pincomment/Leaf%%x%%#Section]] after.", "Before Leaf Section after."],
		["Before [[pincomment/Leaf%%x%%#^blk]] after.", "Before Leaf after."],
		// A `#^blockid` ends the label, and WHERE it ends is decided on the raw
		// target for the same reason isFileTarget and finalSegment are (ADR 0021
		// decision 5). A `#^` written inside a comment span still ends it. On a
		// comment-stripped view there is no `#^` left, so the tail after the span
		// would become audible where the base silenced it - the one direction this
		// change must never move in.
		["Before [[pincomment/Leaf%%x#^%%SECRET]] after.", "Before Leaf after."],
		["Before [[pincomment/Leaf<!--x#^-->SECRET]] after.", "Before Leaf after."],
		["Before [[pincomment/Leaf%%x#^y%%]] after.", "Before Leaf after."],
		["Before [[pincomment/Leaf#^blk%%x%%]] after.", "Before Leaf after."],
		// The scan starts at the target start, not at the final segment: a `/`
		// inside a comment makes finalSegment open the emission window on a
		// CLOSING `%%`, which a segment-local scan would read as an opener and
		// would then silence the visible `Leaf`.
		["Before [[pincomment%%/%%Leaf]] after.", "Before Leaf after."],
		// Q4: classification stays raw, so a wikilink to a file still speaks it
		// and the comment goes whichever side of the dot it was written on.
		["Before [[pincomment/Leaf%%x%%.png]] after.", "Before Leaf.png after."],
		["Before [[pincomment/Leaf.png%%x%%]] after.", "Before Leaf.png after."],
		// GUARD: already correct before NRL-67, via cleanLine on the alias.
		["Before [[pincomment/Leaf|label %%SECRET%%]] after.", "Before label after."],
	] as const) {
		for (const speakEmbeds of [false, true]) {
			const got = say(src, { speakEmbeds });
			check(
				`NRL-67 pin-comment-inside-target ${JSON.stringify(src)} (speakEmbeds ${speakEmbeds})`,
				got === want,
				`got: ${JSON.stringify(got)}`,
			);
			// NRL-46's half, kept: the folder is gone.
			check(
				`NRL-67 pin-comment-inside-target ${JSON.stringify(src)} still drops the folder (speakEmbeds ${speakEmbeds})`,
				!got.includes("pincomment"),
				`got: ${JSON.stringify(got)}`,
			);
		}
	}
	for (const [src, want] of [
		["Before ![[pincomment/Leaf%%SECRET%%]] after.", "Before Leaf after."],
		["Before ![[pincomment/<!--SECRET-->Leaf]] after.", "Before Leaf after."],
		["Before ![[pincomment/Leaf%%SECRET]] after.", "Before Leaf after."],
		["Before ![[pincomment%%/%%Leaf]] after.", "Before Leaf after."],
		["Before ![[pincomment/Leaf%%x#^%%SECRET]] after.", "Before Leaf after."],
		// GUARD, unchanged by NRL-67: a file target is a destination, so the
		// embed is silent whichever side of the dot the comment sits, and stays
		// silent when the comment is the only thing holding the dot.
		["Before ![[pincomment/Leaf%%x%%.png]] after.", "Before after."],
		["Before ![[pincomment/Leaf.png%%x%%]] after.", "Before after."],
		["Before ![[pincomment/Leaf%%x.y%%]] after.", "Before after."],
		// GUARD: the alias path is untouched.
		["Before ![[pincomment/Leaf|label %%SECRET%%]] after.", "Before label after."],
	] as const) {
		const got = say(src, { speakEmbeds: true });
		check(
			`NRL-67 pin-comment-inside-target ${JSON.stringify(src)} (speakEmbeds true)`,
			got === want,
			`got: ${JSON.stringify(got)}`,
		);
		check(
			`NRL-67 pin-comment-inside-target ${JSON.stringify(src)} still drops the folder (speakEmbeds true)`,
			!got.includes("pincomment"),
			`got: ${JSON.stringify(got)}`,
		);
		// The same source with embeds off speaks neither the label nor the comment.
		const off = say(src, { speakEmbeds: false });
		check(
			`NRL-67 pin-comment-inside-target ${JSON.stringify(src)} (speakEmbeds false)`,
			off === "Before after.",
			`got: ${JSON.stringify(off)}`,
		);
	}
	// A comment opened inside a target is target-local and must never hide the
	// lines below it (ADR 0006 clause 5). Measured true before NRL-67 too; this
	// pins that the scan did not change it.
	{
		const got = say("Before [[pincomment/Leaf%%SECRET]] after.\nNext prose line.");
		check(
			"NRL-67 an unmatched opener in a target does not escape to the next line",
			got === "Before Leaf after. Next prose line.",
			`got: ${JSON.stringify(got)}`,
		);
	}

	// The two constructs are governed by different keys, which is the whole
	// reason the embed branch is ordered ahead of the image branch.
	{
		const mixed = "A ![alt words](img.png) and ![[Target Note]] B.";
		check("NRL-21 speakImageAlt does not move embeds", say(mixed, { speakImageAlt: true, speakEmbeds: false }) === "A alt words and B.", say(mixed, { speakImageAlt: true, speakEmbeds: false }));
		check("NRL-21 speakEmbeds does not move markdown images", say(mixed, { speakImageAlt: false, speakEmbeds: true }) === "A and Target Note B.", say(mixed, { speakImageAlt: false, speakEmbeds: true }));
		check("NRL-21 both on", say(mixed, { speakImageAlt: true, speakEmbeds: true }) === "A alt words and Target Note B.", say(mixed, { speakImageAlt: true, speakEmbeds: true }));
		check("NRL-21 both off", say(mixed, { speakImageAlt: false, speakEmbeds: false }) === "A and B.", say(mixed, { speakImageAlt: false, speakEmbeds: false }));
	}

	// Options are read at call time only, so a settings change applies on the
	// next read and never rewrites a queue the Player is already holding.
	{
		const src = "Body ![alt words](img.png) prose.";
		const live = { ...OPTS, speakImageAlt: false };
		const first = extractChunks(src, live);
		const firstText = first.map((c) => c.text).join(" ");
		live.speakImageAlt = true;
		check("NRL-21 already-extracted chunks are unaffected by a later flip", first.map((c) => c.text).join(" ") === firstText && firstText === "Body prose.", firstText);
		check("NRL-21 the next extraction sees the new value", extractChunks(src, live).map((c) => c.text).join(" ") === "Body alt words prose.");
	}

	/*
	 * sourceIndex lockstep over every combination of the nine toggles.
	 *
	 * 2^9 = 512 runs per fixture, which is cheap and removes the guesswork about
	 * which combination was actually covered. Indexing is numeric and
	 * UTF-16-based, not `[...text]`, because a spread iterates code points and
	 * would silently skip the second unit of a surrogate pair.
	 *
	 * No math in the corpus: "equation" is a synthetic word whose characters map
	 * to the `$` delimiters by design (ADR 0004), so the character-identity
	 * assertion does not apply to it.
	 */
	const corpus: Array<[string, string]> = [
		["frontmatter", "---\ntitle: A Note\ntags: [a, b]\nsource: https://example.com/a/b\n# yaml comment\n---\nBody prose here."],
		["fenced", "Intro line here.\n\n```js\nconst x = 1;\n```\n\nOutro line here."],
		["indented", "Intro line here.\n\n    indented code here\n\nOutro line here."],
		["inline-code", "Call `git commit -m x` to save it all now."],
		["links", "See [the docs](https://example.com/p) and [ref][r] and https://bare.example.org/x now."],
		["wikilinks", "Go to [[Some Note|the alias]] and [[Other#Head]] and [[Third#^abc]] now."],
		["embeds", "Here ![[Some Note]] and ![[pic.png|200x100]] and ![[pic.png|A bicycle]] end."],
		["embed-file-shapes", "Here ![[site.webmanifest]] and ![[archive.tar-gz]] and ![[Dockerfile]] and ![[Version 1.2 notes|the release]] end."],
		["images", 'Here ![alt words](img.png "Title") and ![ref alt][r] and ![shortcut] end.'],
		["table", "Lead in here.\n\n| a | b |\n| - | - |\n| c | d |\n\nLead out here."],
		["headings", "# Top Heading\n\nBody one here.\n\n## Sub Heading\n\nBody two here."],
		["tags", "Body with #tag/nested and #other here now."],
		["autolinks", "Mail <me@example.com> and site <https://example.com/x> now."],
		["comments", "Before %%hidden%% after.\n\n<!--\nblock hidden\n-->\nTail prose here."],
		["soft-code-span", "Before `first\n%%literal%%\nlast` after."],
		["mixed", "---\nkey: value\n---\n# H One\n\nText `c` and ![a](i.png) and ![[E]] and #t and https://x.com/y here.\n\n| p | q |"],
		// NRL-46: a reduced label emits from part-way into the target, so its
		// offsets are the shape most likely to drift out of lockstep.
		["link-folder-targets", "Go to [[private/folder/Secret Note]] and ![[a/b/Deep Note]] and [[/Leading Slash]] and [[folder/]] now."],
		["link-odd-targets", "See [[https://user:pw@example.com/a/b]] and [[C:\\Users\\me\\Secret Note]] and ![[C:\\v1.2\\Note]] now."],
		// NRL-45: a dropped definition line emits nothing at all, so the chunks
		// either side of it must still hold monotonic offsets across the gap.
		["link-ref-defs", 'ZBEFOREZ para here.\n\n[theref]: zdestz.png "ZTITLEZ"\n\nUses [label][theref] and [theref] here.\n\n> [qref]: <q dest.png> \'QT\'\n\nZAFTERZ para here.'],
		["link-ref-def-negatives", '[see also]: not a definition, just a sentence\n\nZPROSEZ line here.\n[theref]: zdestz.png "ZTITLEZ"\n\n[a [b] c]: x.png\n\n[^1]: ZFOOTZ body here.'],
		// NRL-44: the literal region of a confirmed soft-wrapped span emits every
		// non-space character at its true offset and collapses each whitespace run
		// to one space carrying the offset of that run's FIRST character, so these
		// are the rows most likely to break monotonicity or character identity. No
		// inline math on the continuation lines of these rows for the reason given
		// above - inside the region `$x$` is verbatim, not "equation", so it is
		// safe here, and the mathblock row proves it.
		["span-markdown-in-region", "Before `first\n**bold** ==h== $x$ ~~s~~\nlast` after."],
		["span-escape-and-urls-in-region", "Before `first\n\\%%k\\%% <https://x.com> https://y.com/p\nlast` after."],
		["span-constructs-in-region", "Before `first\n[[w]] ![[e]] [l](d.png) ![a](d.png) [^f] #t <span>h</span>\nlast` after."],
		["span-mismatched-run-in-region", "Before ``a\nb ` c\nd`` after."],
	];
	let sweepRuns = 0;
	let sweepBad = "";
	for (const [id, src] of corpus) {
		for (let mask = 0; mask < 1 << keys.length; mask++) {
			const over: Partial<typeof OPTS> = {};
			for (let b = 0; b < keys.length; b++) over[keys[b]!] = (mask & (1 << b)) !== 0;
			sweepRuns += 1;
			for (const c of extractChunks(src, { ...OPTS, ...over })) {
				const fail = (why: string): void => {
					if (sweepBad === "") sweepBad = `${id} mask=${mask}: ${why}`;
				};
				if (c.sourceIndex.length !== c.text.length) fail("length");
				if (c.text.length > 0 && c.sourceStart !== c.sourceIndex[0]) fail("sourceStart");
				if (c.text.length > 0 && c.sourceEnd !== c.sourceIndex[c.text.length - 1]! + 1) fail("sourceEnd");
				for (let i = 0; i < c.text.length; i++) {
					const at = c.sourceIndex[i]!;
					if (!Number.isInteger(at) || at < 0 || at >= src.length) fail(`bounds at ${i}`);
					if (i > 0 && at < c.sourceIndex[i - 1]!) fail(`non-monotonic at ${i}`);
					// Numeric UTF-16 comparison: charCodeAt, not a spread.
					if (c.text.charCodeAt(i) !== 32 && src.charCodeAt(at) !== c.text.charCodeAt(i)) {
						fail(`char at ${i}`);
					}
				}
			}
		}
	}
	check(`NRL-21 sourceIndex lockstep over ${sweepRuns} option combinations`, sweepBad === "", sweepBad);
	// The product is spelled out deliberately: it is the did-the-sweep-really-run
	// pin, so a corpus row added or lost must edit this literal rather than
	// silently change what "every combination" means. 16 rows at NRL-21, plus
	// the two NRL-46 link-target rows, plus the two NRL-45
	// link-reference-definition rows, plus the four NRL-44 literal-region rows.
	check("NRL-21 sweep really ran every combination", sweepRuns === corpus.length * (1 << keys.length) && sweepRuns === 24 * 512, String(sweepRuns));
}

console.log("NRL-28 Unicode sentence segmentation and grapheme-safe splitting (R-M10)");
{
	const texts = (src: string, opts = OPTS): string[] => extractChunks(src, opts).map((c) => c.text);
	const same = (got: string[], want: string[]): boolean =>
		got.length === want.length && got.every((x, i) => x === want[i]);

	/*
	 * A lone surrogate is a chunk an engine cannot pronounce and a highlight
	 * cannot land on. Written out rather than using String.isWellFormed, which
	 * is ES2024 and this repo's lib is ES2022.
	 */
	const wellFormed = (s: string): boolean => {
		for (let i = 0; i < s.length; i++) {
			const u = s.charCodeAt(i);
			if (u >= 0xd800 && u <= 0xdbff) {
				const next = s.charCodeAt(i + 1);
				if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
				i += 1;
			} else if (u >= 0xdc00 && u <= 0xdfff) {
				return false;
			}
		}
		return true;
	};

	// Node has Intl.Segmenter, so the test can hold ICU itself as the oracle
	// for what a grapheme cluster is, independently of src/text/segment.ts.
	const GR = new Intl.Segmenter(undefined, { granularity: "grapheme" });
	const clusterCount = (s: string): number => [...GR.segment(s)].length;
	/** A piece that opens with a combining mark was cut out of a cluster. */
	const opensMidCluster = (s: string): boolean => {
		if (s.length === 0) return false;
		const first = [...GR.segment(s)][0]!.segment;
		return /^[\p{Grapheme_Extend}\p{Emoji_Modifier}\u200d]/u.test(first);
	};

	/*
	 * Offset lockstep, numeric and UTF-16-based. Never `[...k.text]`, for the
	 * reason spelled out on unitsMatch: on an astral fixture a spread's index
	 * stops matching the sourceIndex slot, it compares a two-unit string
	 * against a one-unit one, and it leaves the trailing slots unread. Two of
	 * the fixtures below are astral. Returns the first failure, or "".
	 */
	const lockstepBad = (src: string, opts = OPTS): string => {
		for (const k of extractChunks(src, opts)) {
			if (k.sourceIndex.length !== k.text.length) return "length";
			if (k.text.length > 0 && k.sourceStart !== k.sourceIndex[0]) return "sourceStart";
			if (k.text.length > 0 && k.sourceEnd !== k.sourceIndex[k.text.length - 1]! + 1) return "sourceEnd";
			for (let i = 0; i < k.text.length; i++) {
				const at = k.sourceIndex[i]!;
				if (!Number.isInteger(at) || at < 0 || at >= src.length) return `bounds at ${i}`;
				if (i > 0 && at < k.sourceIndex[i - 1]!) return `non-monotonic at ${i}`;
				if (k.text.charCodeAt(i) !== 32 && src.charCodeAt(at) !== k.text.charCodeAt(i)) return `char at ${i}`;
			}
		}
		return "";
	};

	// (a) Chinese. Full-width terminators and no inter-sentence space, so the
	// ASCII-terminator-plus-whitespace regex can never see a boundary here.
	const zh1 = "\u8fd9\u662f\u7b2c\u4e00\u53e5\u3002";
	const zh2 = "\u8fd9\u662f\u7b2c\u4e8c\u53e5\u3002";
	const zh3 = "\u7b2c\u4e09\u53e5\u7ed3\u675f\u4e86\u3002";
	const zh = zh1 + zh2 + zh3;
	check("NRL-28 Chinese splits at the full-width stop", same(texts(zh), [zh1, zh2, zh3]), JSON.stringify(texts(zh)));
	check("NRL-28 Chinese offsets stay in lockstep", lockstepBad(zh) === "", lockstepBad(zh));

	// (b) Japanese.
	const ja1 = "\u3053\u308c\u306f\u4e00\u6587\u76ee\u3067\u3059\u3002";
	const ja2 = "\u3053\u308c\u306f\u4e8c\u6587\u76ee\u3067\u3059\u3002";
	const ja = ja1 + ja2;
	check("NRL-28 Japanese splits at the full-width stop", same(texts(ja), [ja1, ja2]), JSON.stringify(texts(ja)));
	check("NRL-28 Japanese offsets stay in lockstep", lockstepBad(ja) === "", lockstepBad(ja));

	/*
	 * (c) Right-to-left. The exact shape of the fix: the Arabic question mark
	 * U+061F is a boundary only ICU knows about, so it survives, while the
	 * ASCII "." boundary is still erased by mergeShort exactly as it is today.
	 * Both halves matter - keeping every new boundary would repace English.
	 */
	const ar1 = "\u0647\u0630\u0627 \u0646\u0635 \u0639\u0631\u0628\u064a.";
	const ar2 = "\u0648\u0647\u0630\u0627 \u0633\u0624\u0627\u0644\u061f";
	const ar3 = "\u0648\u0647\u0630\u0627 \u0627\u0644\u0623\u062e\u064a\u0631.";
	const ar = [ar1, ar2, ar3].join(" ");
	check(
		"NRL-28 Arabic keeps the U+061F boundary and still merges the ASCII one",
		same(texts(ar), [`${ar1} ${ar2}`, ar3]),
		JSON.stringify(texts(ar)),
	);
	check("NRL-28 Arabic offsets stay in lockstep", lockstepBad(ar) === "", lockstepBad(ar));

	// (d) Astral emoji across the hard cut. The EMOJI drop test reads one
	// UTF-16 unit, so a lone surrogate matches none of its ranges and an astral
	// emoji survives cleanLine; a BMP one would simply be dropped before it
	// ever reached the splitter. The trailing-U+FE0F shape is dropped and is
	// out of scope here.
	const emoji = "a".repeat(219) + "\u{1f600}" + "b".repeat(10) + ".";
	const emojiChunks = extractChunks(emoji, OPTS);
	check(
		"NRL-28 no chunk is cut through a surrogate pair",
		emojiChunks.every((c) => wellFormed(c.text)),
		emojiChunks.map((c) => `${c.text.length}u`).join(","),
	);
	check("NRL-28 the astral emoji survives whole in one chunk", emojiChunks.some((c) => c.text.includes("\u{1f600}")));
	check("NRL-28 emoji offsets stay in lockstep", lockstepBad(emoji) === "", lockstepBad(emoji));

	// (e) Combining sequence across the hard cut.
	const comb = "a".repeat(219) + "e\u0301" + "b".repeat(10) + ".";
	const combChunks = extractChunks(comb, OPTS);
	check(
		"NRL-28 no chunk opens with an orphaned combining mark",
		combChunks.every((c) => !opensMidCluster(c.text)),
		combChunks.map((c) => `${c.text.length}u`).join(","),
	);
	check("NRL-28 combining offsets stay in lockstep", lockstepBad(comb) === "", lockstepBad(comb));

	/*
	 * (f) The cap is a target, not a guarantee: a single grapheme cluster can
	 * be longer than it, so the only honest rule is "at most 220 units unless
	 * the whole piece is one cluster". Replaces an older assertion that allowed
	 * 240, which no code path could reach.
	 */
	const capBad = (src: string, opts = OPTS): string => {
		for (const c of extractChunks(src, opts)) {
			if (c.text.length > 220 && clusterCount(c.text) !== 1) return `${c.text.length}u / ${clusterCount(c.text)} clusters`;
		}
		return "";
	};

	// (g) One grapheme longer than the cap. It must be preserved rather than
	// cut or dropped, and the loop must still terminate.
	const zalgo = `a${"\u0301".repeat(300)} tail.`;
	const zalgoChunks = extractChunks(zalgo, OPTS);
	check("NRL-28 an oversized single grapheme is emitted whole", zalgoChunks[0]?.text.length === 301, `${zalgoChunks[0]?.text.length}`);
	check("NRL-28 that piece really is one cluster", clusterCount(zalgoChunks[0]?.text ?? "") === 1);
	check("NRL-28 the split still terminates and keeps the tail", zalgoChunks.map((c) => c.text).join("|").endsWith("tail."), JSON.stringify(zalgoChunks.map((c) => c.text.length)));
	check("NRL-28 cap holds on the oversized-grapheme fixture", capBad(zalgo) === "", capBad(zalgo));
	check("NRL-28 zalgo offsets stay in lockstep", lockstepBad(zalgo) === "", lockstepBad(zalgo));

	// (h) The ticket's "Worse" paragraph: a long spaceless CJK paragraph used
	// to be cut at exactly 220 units, mid-sentence. Every piece must now end at
	// a sentence terminator.
	const cjkPara = zh1.repeat(60);
	const cjkChunks = extractChunks(cjkPara, OPTS);
	check(
		"NRL-28 a long CJK paragraph is never cut mid-sentence",
		cjkChunks.every((c) => c.text.endsWith("\u3002")),
		`${cjkChunks.length} chunks, first ${cjkChunks[0]?.text.length}u`,
	);
	check("NRL-28 long CJK offsets stay in lockstep", lockstepBad(cjkPara) === "", lockstepBad(cjkPara));

	// (i) A single CJK sentence past the cap still has to be hard-split, and
	// that split must be grapheme-safe even with no space anywhere in it.
	const cjkLong = "\u8fd9".repeat(300) + "\u3002";
	const cjkLongChunks = extractChunks(cjkLong, OPTS);
	check("NRL-28 an oversized spaceless sentence is split", cjkLongChunks.length > 1, `${cjkLongChunks.length}`);
	check("NRL-28 its pieces respect the cap", capBad(cjkLong) === "", capBad(cjkLong));
	check("NRL-28 its pieces are well formed", cjkLongChunks.every((c) => wellFormed(c.text) && !opensMidCluster(c.text)));
	check("NRL-28 oversized sentence offsets stay in lockstep", lockstepBad(cjkLong) === "", lockstepBad(cjkLong));

	/*
	 * (j) The word-boundary preference must not produce a runt.
	 *
	 * It only runs when the window holds no space past the halfway mark, and
	 * `"hi "` followed by 300 unbroken characters is exactly that: the only
	 * word boundary in the window is at 3. Without the same halfway floor the
	 * space branch uses, this chunked as 3 + 220 + 81 where the cap alone gave
	 * 220 + 84. Found by running the real module against the merge base, not
	 * by any fixture in the suite, so it is pinned here.
	 */
	const runt = `hi ${"x".repeat(300)}.`;
	check(
		"NRL-28 a lone early word boundary does not beat the cap",
		extractChunks(runt, OPTS).map((c) => c.text.length).join(",") === "220,84",
		extractChunks(runt, OPTS).map((c) => c.text.length).join(","),
	);
	check(
		"NRL-28 that shape is identical without a segmenter too",
		extractChunks(runt, OPTS, noSegmenters).map((c) => c.text.length).join(",") === "220,84",
		extractChunks(runt, OPTS, noSegmenters).map((c) => c.text.length).join(","),
	);

	/*
	 * (k) English prose is not the same thing as ASCII prose.
	 *
	 * The ICU-only guard asks whether the last non-whitespace character before
	 * a boundary is at or above U+0080, and its comment says it is testing the
	 * terminator. Those are the same character only when nothing follows the
	 * terminator. Obsidian's smart punctuation turns a straight closing quote
	 * into a curly one, and the legacy regex's closer class is ASCII-only
	 * (`["')\]]*`), so `stop." ` breaks and `stop.” ` does not. Without this
	 * the curly form gained an ICU-only boundary that mergeShort then refused
	 * to fold, and `“First.” “Second.” “Third.” Tail text here now.` spoke as
	 * four utterances of 8, 9, 8 and 19 units where the straight-quoted form
	 * spoke as one of 47. Measured against the merge base fb71812 by bundling
	 * both extractors.
	 *
	 * The rule: walking back over a final or closing punctuation mark as well
	 * as over whitespace reaches the terminator the comment always meant, so a
	 * boundary with an ASCII terminator is rejected however it is punctuated.
	 * `》`, `」` and `）` still ride on the non-ASCII terminator underneath
	 * them, which is what keeps CJK working.
	 */
	const quoted = (q: [string, string]): string =>
		`${q[0]}First.${q[1]} ${q[0]}Second.${q[1]} ${q[0]}Third.${q[1]} Tail text here now.`;
	const straight = quoted(['"', '"']);
	const curly = quoted(["\u201c", "\u201d"]);
	// Both of these are one 47-unit chunk on the merge base. The straight form
	// gets there by finding three legacy boundaries and folding all three;
	// the curly form by finding none at all.
	check("NRL-28 straight-quoted English is one chunk, as before", same(texts(straight), [straight]), JSON.stringify(texts(straight).map((c) => c.length)));
	check("NRL-28 curly-quoted English is one chunk, not four runts", same(texts(curly), [curly]), JSON.stringify(texts(curly).map((c) => c.length)));
	for (const [id, closer] of [["curly double", "\u201d"], ["curly single", "\u2019"], ["guillemet", "\u00bb"], ["single guillemet", "\u203a"], ["fullwidth paren", "\uff09"]] as const) {
		const s = `He said \u201cstop.${closer} Then he left the room quietly and slowly.`;
		check(`NRL-28 a ${id} closer leaves English where the merge base had it`, same(texts(s), [s]), JSON.stringify(texts(s)));
	}
	// The ASCII closer still breaks, exactly as it always has: the legacy
	// regex owns that boundary and nothing here touches it.
	const asciiCloser = "He said \u201cstop.\" Then he left the room quietly and slowly.";
	check(
		"NRL-28 an ASCII closer still breaks where the legacy regex says",
		same(texts(asciiCloser), ["He said \u201cstop.\"", "Then he left the room quietly and slowly."]),
		JSON.stringify(texts(asciiCloser)),
	);
	check(
		"NRL-28 the guard still admits a non-ASCII terminator behind a closer",
		same(texts(`\u4ed6\u8bf4\u300c${zh1}\u300d${zh2}`), [`\u4ed6\u8bf4\u300c${zh1}\u300d`, zh2]),
		JSON.stringify(texts(`\u4ed6\u8bf4\u300c${zh1}\u300d${zh2}`)),
	);

	/*
	 * (l) The word branch may not undercut the space branch by one unit.
	 *
	 * NRL-28 verification finding B1. `splitOversized` asks the space branch
	 * first, and it rejects the last space in the window when that space sits
	 * at or before `MAX_CHUNK_CHARS * 0.5`. ICU then reports a word boundary
	 * one unit further on, because a word starts immediately after a space,
	 * and the word branch accepted it: a break the space branch had just
	 * judged too early at offset 110 came back at 111. The piece that came out
	 * was the same 110 units of text plus the space that had been rejected
	 * with it, so the two branches disagreed about a single cut they were both
	 * looking at, and only in the position where `Intl.Segmenter` exists.
	 *
	 * Every expected string below is the merge base fb71812's own output,
	 * measured by bundling its extractor. The branch produced `111,110`,
	 * `111,220,80`, `111,128` and `219,111,128` instead.
	 */
	/** Prose of exactly n units, never ending in a space, so the only space near the cap is the planted one. */
	const prose = (n: number): string => {
		const body = "the quick brown fox jumps over the lazy dog and then runs on ".repeat(10);
		const cut = body.slice(0, n);
		return cut.endsWith(" ") ? `${cut.slice(0, n - 1)}x` : cut;
	};
	const hex128 = "0123456789abcdef".repeat(8);
	check("NRL-28 the B1 lead really is 110 units and does not end in a space", prose(110).length === 110 && !prose(110).endsWith(" "));
	check("NRL-28 the B1 token really is 128 units with no space in it", hex128.length === 128 && !hex128.includes(" "));
	const b1Fixtures: Array<[string, string, string]> = [
		["a space at exactly 110 with a short tail", `${"a".repeat(110)} ${"b".repeat(110)}`, "220,1"],
		["a space at exactly 110 with a long tail", `${"a".repeat(110)} ${"b".repeat(300)}`, "220,191"],
		["ordinary prose then one long unbroken token", `${prose(110)} ${hex128}`, "220,19"],
		["the same shape at a non-zero cursor", `${"b".repeat(219)} ${prose(110)} ${hex128}`, "219,220,19"],
	];
	for (const [id, src, want] of b1Fixtures) {
		check(`NRL-28 ${id} splits where the merge base split it`, extractChunks(src, OPTS).map((c) => c.text.length).join(",") === want, extractChunks(src, OPTS).map((c) => c.text.length).join(","));
	}

	/*
	 * The same thing swept rather than sampled, which is the lesson B1 taught:
	 * the earlier probes clustered around the halfway mark and still missed
	 * the one offset that fires. With no segmenter the union collapses to the
	 * legacy set and the word branch has no boundaries to offer, so the
	 * no-segmenter position *is* the merge base's algorithm on ASCII input
	 * (block (c) below pins that equivalence separately). Sweeping the planted
	 * space across every offset in the window and demanding the two positions
	 * agree therefore compares this branch against the old behaviour at every
	 * offset, not near one.
	 */
	let b1Runs = 0;
	let b1Bad = "";
	for (const prefix of ["", `${"b".repeat(219)} `]) {
		for (const tail of [110, 300]) {
			for (let at = 0; at <= 219; at++) {
				const src = `${prefix}${"a".repeat(at)} ${"b".repeat(tail)}`;
				const withSeg = extractChunks(src, OPTS).map((c) => c.text.length).join(",");
				const without = extractChunks(src, OPTS, noSegmenters).map((c) => c.text.length).join(",");
				b1Runs += 1;
				if (withSeg !== without && b1Bad === "") b1Bad = `prefix ${prefix.length}u tail ${tail}u space at ${at}: [${withSeg}] vs [${without}]`;
			}
		}
	}
	check(`NRL-28 every space offset in the window splits the same in both positions (${b1Runs} shapes)`, b1Bad === "", b1Bad);
	check("NRL-28 the B1 sweep really ran every offset", b1Runs === 2 * 2 * 220, String(b1Runs));

	/*
	 * (m) What the word branch *does* change on ASCII, pinned so it cannot
	 * drift either way.
	 *
	 * The B1 repair's differential found 58,835 differences from the merge
	 * base over 661,262 comparisons, and every one of them is text in which
	 * some 220-unit window holds no space past its halfway mark - a 400-unit
	 * unbroken token, not prose. There the space branch has nothing to offer
	 * and the word branch cuts at a real boundary instead of blindly at the
	 * cap, which is what it exists for. The same corpus found zero
	 * differences over 4,000 generated English prose and markdown fixtures.
	 * ADR 0009's "ASCII text is byte-identical" was therefore wrong and now
	 * says this instead; these two assertions are what stop the distinction
	 * being lost again.
	 */
	const spaceless = `${"a".repeat(110)},${"b".repeat(300)}`;
	check(
		"NRL-28 an unbroken ASCII run is cut at its punctuation, not at the cap",
		extractChunks(spaceless, OPTS).map((c) => c.text.length).join(",") === "111,220,80",
		extractChunks(spaceless, OPTS).map((c) => c.text.length).join(","),
	);
	check(
		"NRL-28 with no segmenter that same run is cut at the cap, as the merge base cuts it",
		extractChunks(spaceless, OPTS, noSegmenters).map((c) => c.text.length).join(",") === "220,191",
		extractChunks(spaceless, OPTS, noSegmenters).map((c) => c.text.length).join(","),
	);
	// And wherever it fires, the floor still holds: no non-final piece under
	// 111 units over every punctuation mark at every offset in the window.
	let floorRuns = 0;
	let floorBad = "";
	for (const mark of [",", ";", "-", "/", "(", ")", "[", "]", "\"", "@", "#", "$", "%", "&", "+", "=", "<", ">", "|", "~", "^"]) {
		for (let at = 0; at <= 240; at++) {
			const pieces = extractChunks(`${"a".repeat(at)}${mark}${"b".repeat(300)}`, OPTS);
			floorRuns += 1;
			for (let i = 0; i < pieces.length - 1; i++) {
				if (pieces[i]!.text.length <= 110 && floorBad === "") floorBad = `${JSON.stringify(mark)} at ${at}: piece ${i} is ${pieces[i]!.text.length}u`;
			}
		}
	}
	check(`NRL-28 the halfway floor holds wherever the word branch fires (${floorRuns} shapes)`, floorBad === "", floorBad);

	// The cap rule over every fixture in this section at once.
	const corpus = [zh, ja, ar, emoji, comb, zalgo, cjkPara, cjkLong, runt, curly, straight, ...b1Fixtures.map(([, src]) => src)];
	check("NRL-28 cap holds over every fixture", corpus.every((s) => capBad(s) === ""), corpus.map((s) => capBad(s)).join("|"));
	check("NRL-28 lockstep holds over every fixture", corpus.every((s) => lockstepBad(s) === ""), corpus.map((s) => lockstepBad(s)).join("|"));
	check(
		"NRL-28 no fixture produces a malformed or mid-cluster piece",
		corpus.every((s) => extractChunks(s, OPTS).every((c) => wellFormed(c.text) && !opensMidCluster(c.text))),
	);
}

/*
 * NRL-28, the other segmenter position.
 *
 * This Node has Intl.Segmenter, so without an injected source the fallback
 * would never execute in this suite at all and its first run would be on a
 * user's WebView. `noSegmenters` is how it gets exercised, and it is a value
 * rather than a deleted global so nothing here can leak into a later block.
 */
console.log("NRL-28 the no-segmenter position and the offline fallbacks (R-M10)");
{
	const NATIVE = new Intl.Segmenter(undefined, { granularity: "grapheme" });
	const nativeGraphemes = (s: string): number[] =>
		[...NATIVE.segment(s)].map((p) => p.index).filter((at) => at > 0);

	// (a) The legacy rule is the old regex, unchanged, and is still what the
	// fallback path uses on its own.
	check("NRL-28 legacy rule breaks after a terminator plus space", legacySentenceBoundaries("One two. Three four.").join(",") === "9");
	check("NRL-28 legacy rule needs the whitespace", legacySentenceBoundaries("One.Two").length === 0);
	check("NRL-28 legacy rule keeps a trailing closer", legacySentenceBoundaries('He said "stop." Then left.').join(",") === "16");
	check("NRL-28 legacy rule finds nothing in CJK", legacySentenceBoundaries("\u8fd9\u662f\u7b2c\u4e00\u53e5\u3002\u8fd9\u662f\u7b2c\u4e8c\u53e5\u3002").length === 0);
	check(
		"NRL-28 with no sentence segmenter the union is exactly the legacy set",
		sentenceBoundaries("One two. Three four.", "en", noSegmenters).every((b) => b.legacy) &&
			sentenceBoundaries("One two. Three four.", "en", noSegmenters).map((b) => b.at).join(",") === "9",
	);
	check(
		"NRL-28 with no sentence segmenter CJK has no boundary at all",
		sentenceBoundaries("\u8fd9\u662f\u7b2c\u4e00\u53e5\u3002\u8fd9\u662f\u7b2c\u4e8c\u53e5\u3002", "en", noSegmenters).length === 0,
	);

	/*
	 * (b) The offline UAX 29 breaker, against ICU as the oracle. These are the
	 * shapes that a naive code-point walk gets wrong: it would keep a surrogate
	 * pair together and nothing else.
	 */
	const graphemeFixtures: Array<[string, string]> = [
		["regional indicator pair", "\u{1f1ec}\u{1f1e7}"],
		["three regional indicators", "\u{1f1ec}\u{1f1e7}\u{1f1fa}"],
		["ZWJ family of three", "\u{1f468}\u200d\u{1f469}\u200d\u{1f466}"],
		["301-unit single cluster", `a${"\u0301".repeat(300)}`],
		["variation selector", "\u2764\ufe0f"],
		["keycap", "1\ufe0f\u20e3"],
		["skin tone", "\u{1f44d}\u{1f3fd}"],
		["tag sequence flag", "\u{1f3f4}\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}"],
		["hangul jamo", "\u1100\u1161\u11a8"],
		["CRLF", "a\r\nb"],
		["devanagari conjunct", "\u0915\u094d\u0937\u093f"],
		["bengali conjunct", "\u0995\u09cd\u09b7"],
		["ZWNJ blocks the conjunct", "\u0915\u200c\u094d\u0915"],
		/*
		 * NRL-28 verification finding B2. UAX 29 gives ZWJ InCB=Extend, so a
		 * ZWJ sitting inside an Indic conjunct run must not end it; the
		 * breaker classed it as Grapheme_Cluster_Break=ZWJ and the GB9c state
		 * update then cleared the run, putting a boundary in front of the
		 * second consonant where ICU has none. ZWJ inside a conjunct is a real
		 * orthographic control in these scripts, not a degenerate shape.
		 */
		["devanagari conjunct with a ZWJ", "\u0915\u094d\u200d\u0915"],
		["telugu conjunct with a ZWJ", "\u0c15\u0c4d\u200d\u0c15"],
		["bengali conjunct with a ZWJ", "\u0995\u09cd\u200d\u0995"],
		["khmer coeng with a ZWJ", "\u1780\u17d2\u200d\u1780"],
		["malayalam conjunct with a ZWJ", "\u0d15\u0d4d\u200d\u0d15"],
		["a ZWJ before the linker", "\u0915\u200d\u094d\u0915"],
		["two ZWJ inside the conjunct", "\u0915\u094d\u200d\u200d\u0915"],
		["a consonant joined by ZWJ with no linker", "\u0915\u200d\u0915"],
		["ZWNJ after the linker still ends the run", "\u0915\u094d\u200c\u0915"],
		["prepended concatenation mark", "\u0600\u0661"],
		["thai sara am", "\u0e01\u0e33"],
		["doubled ZWJ", "\u0e01\u2764\u200d\u200d\u{1f600}\u2764"],
		["lone high surrogate", "\ud83d"],
		["lone low surrogate", "\ude00"],
		["plain ascii", "hello world"],
		["CJK", "\u8fd9\u662f\u7b2c\u4e00\u53e5\u3002"],
		["arabic", "\u0647\u0630\u0627 \u0646\u0635"],
		["empty", ""],
	];
	for (const [id, s] of graphemeFixtures) {
		check(
			`NRL-28 offline grapheme breaker agrees with ICU on ${id}`,
			uax29GraphemeBoundaries(s).join(",") === nativeGraphemes(s).join(","),
			`offline [${uax29GraphemeBoundaries(s)}] icu [${nativeGraphemes(s)}]`,
		);
	}
	check(
		"NRL-28 the 301-unit sequence really is one cluster, so the cap cannot hold",
		uax29GraphemeBoundaries(`a${"\u0301".repeat(300)}`).length === 0,
	);

	/*
	 * B2 swept rather than sampled, over the whole cross product of the
	 * breaker's own linker and consonant tables. ICU is the oracle: a
	 * hardcoded expectation here would only pin what this module currently
	 * does, and what is claimed is agreement with the platform.
	 */
	{
		const linkers = [0x094d, 0x09cd, 0x0acd, 0x0b4d, 0x0c4d, 0x0d4d, 0x1039, 0x17d2, 0x1a60, 0x1b44];
		const consonants = [0x0915, 0x0995, 0x0a95, 0x0b15, 0x0c15, 0x0d15, 0x1000, 0x1780, 0x1a20, 0x1b13];
		let conjunctRuns = 0;
		let conjunctBad = "";
		for (const linker of linkers) {
			for (const first of consonants) {
				for (const second of consonants) {
					for (const inner of ["\u200d", "\u200d\u200d", "\u0300\u200d", "\u200d\u0300", "", "\u200c"]) {
						const s = String.fromCodePoint(first) + String.fromCodePoint(linker) + inner + String.fromCodePoint(second);
						conjunctRuns += 1;
						const offline = uax29GraphemeBoundaries(s).join(",");
						const native = nativeGraphemes(s).join(",");
						if (offline !== native && conjunctBad === "") {
							conjunctBad = `${[...s].map((c) => c.codePointAt(0)!.toString(16)).join(" ")}: offline [${offline}] icu [${native}]`;
						}
					}
				}
			}
		}
		check(`NRL-28 the offline breaker agrees with ICU on every conjunct shape (${conjunctRuns})`, conjunctBad === "", conjunctBad);
		check("NRL-28 the conjunct sweep really ran the whole cross product", conjunctRuns === 10 * 10 * 10 * 6, String(conjunctRuns));
	}

	/*
	 * (c) Whole-extractor equivalence on ASCII. This is the acceptance
	 * criterion "the existing extract fixtures pass unchanged", made
	 * structural: with no segmenter at all the union collapses to the legacy
	 * set, so ASCII output must be identical in both positions, byte for byte
	 * and offset for offset.
	 */
	const asciiCorpus: Array<[string, string]> = [
		["frontmatter", "---\ntitle: A Note\ntags: [a, b]\nsource: https://example.com/a/b\n# yaml comment\n---\nBody prose here."],
		["fenced", "Intro line here.\n\n```js\nconst x = 1;\n```\n\nOutro line here."],
		["inline-code", "Call `git commit -m x` to save it all now."],
		["links", "See [the docs](https://example.com/p) and [ref][r] and https://bare.example.org/x now."],
		["wikilinks", "Go to [[Some Note|the alias]] and [[Other#Head]] and [[Third#^abc]] now."],
		["embeds", "Here ![[Some Note]] and ![[pic.png|200x100]] and ![[pic.png|A bicycle]] end."],
		["images", 'Here ![alt words](img.png "Title") and ![ref alt][r] and ![shortcut] end.'],
		["table", "Lead in here.\n\n| a | b |\n| - | - |\n| c | d |\n\nLead out here."],
		["headings", "# Top Heading\n\nBody one here.\n\n## Sub Heading\n\nBody two here."],
		["comments", "Before %%hidden%% after.\n\n<!--\nblock hidden\n-->\nTail prose here."],
		["soft-code-span", "Before `first\n%%literal%%\nlast` after."],
		["callout-marker", "[!note] Callout body text here."],
		["abbreviations", "Dr. Smith arrived. See e.g. the thing. He lives in the U.S.A. now."],
		["ellipsis", "Wait... then what happened next in this rather long story of ours?"],
		["long-hard-split", `One two three. Four five six. ${"word ".repeat(120).trim()}.`],
		["math", "Before $$\nx = 1\n$$ after."],
		// NRL-28 B1: a space at exactly cursor + MAX_CHUNK_CHARS * 0.5. The
		// word branch used to accept the ICU boundary one unit past it, so
		// these three split differently in the two positions where every other
		// ASCII fixture splits identically.
		["b1-space-at-110-short-tail", `${"a".repeat(110)} ${"b".repeat(110)}`],
		["b1-space-at-110-long-tail", `${"a".repeat(110)} ${"b".repeat(300)}`],
		["b1-space-at-110-non-zero-cursor", `${"b".repeat(219)} ${"a".repeat(110)} ${"b".repeat(300)}`],
	];
	const sameChunks = (src: string): string => {
		const a = extractChunks(src, OPTS);
		const b = extractChunks(src, OPTS, noSegmenters);
		if (a.length !== b.length) return `count ${a.length} vs ${b.length}`;
		for (let i = 0; i < a.length; i++) {
			const x = a[i]!;
			const y = b[i]!;
			if (x.text !== y.text) return `text[${i}]`;
			if (x.sourceStart !== y.sourceStart) return `sourceStart[${i}]`;
			if (x.sourceEnd !== y.sourceEnd) return `sourceEnd[${i}]`;
			if (x.sourceIndex.join(",") !== y.sourceIndex.join(",")) return `sourceIndex[${i}]`;
		}
		return "";
	};
	let asciiChecked = 0;
	for (const [id, src] of asciiCorpus) {
		check(`NRL-28 ${id} fixture is ASCII-only, so the guard provably cannot fire`, !/[^\u0000-\u007f]/.test(src));
		check(`NRL-28 ${id} is byte-identical with and without a segmenter`, sameChunks(src) === "", sameChunks(src));
		asciiChecked += 1;
	}
	check("NRL-28 the ASCII equivalence corpus really ran", asciiChecked === asciiCorpus.length && asciiChecked === 19, String(asciiChecked));

	/*
	 * (d) The honest consequence of having no segmenter: CJK collapses back to
	 * one chunk. R-M10's "MAY fall back to paragraphs or safe-sized chunks" is
	 * what licenses that, and pinning it here stops the fallback quietly
	 * growing an English-shaped rule for CJK later.
	 */
	const zh = "\u8fd9\u662f\u7b2c\u4e00\u53e5\u3002\u8fd9\u662f\u7b2c\u4e8c\u53e5\u3002\u7b2c\u4e09\u53e5\u7ed3\u675f\u4e86\u3002";
	check("NRL-28 without a segmenter CJK is one chunk again", extractChunks(zh, OPTS, noSegmenters).length === 1);
	check("NRL-28 with one it is three", extractChunks(zh, OPTS).length === 3);

	/*
	 * (e) Grapheme safety does not depend on ICU. With no segmenter these cuts
	 * are placed by uax29GraphemeBoundaries alone.
	 */
	const wellFormed = (s: string): boolean => {
		for (let i = 0; i < s.length; i++) {
			const u = s.charCodeAt(i);
			if (u >= 0xd800 && u <= 0xdbff) {
				const next = s.charCodeAt(i + 1);
				if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
				i += 1;
			} else if (u >= 0xdc00 && u <= 0xdfff) {
				return false;
			}
		}
		return true;
	};
	const emoji = "a".repeat(219) + "\u{1f600}" + "b".repeat(10) + ".";
	const comb = "a".repeat(219) + "e\u0301" + "b".repeat(10) + ".";
	const zalgo = `a${"\u0301".repeat(300)} tail.`;
	const fallbackEmoji = extractChunks(emoji, OPTS, noSegmenters);
	check("NRL-28 fallback never cuts a surrogate pair", fallbackEmoji.every((c) => wellFormed(c.text)), fallbackEmoji.map((c) => c.text.length).join(","));
	check(
		"NRL-28 fallback never orphans a combining mark",
		extractChunks(comb, OPTS, noSegmenters).every((c) => !/^[\p{Grapheme_Extend}\p{Emoji_Modifier}\u200d]/u.test(c.text)),
	);
	check("NRL-28 fallback keeps an oversized cluster whole", extractChunks(zalgo, OPTS, noSegmenters)[0]?.text.length === 301);
	check(
		"NRL-28 fallback still terminates on every fixture",
		[emoji, comb, zalgo, zh].every((s) => extractChunks(s, OPTS, noSegmenters).length > 0),
	);

	/*
	 * (f) Locale tolerance. appLocale() reads Obsidian's UI language, which is
	 * not contractually a well-formed BCP 47 tag, and Intl.Segmenter throws
	 * RangeError on a bad one. A bad tag must cost the locale, never the
	 * segmentation.
	 */
	check("NRL-28 a malformed locale tag does not throw", (() => {
		try {
			return extractChunks(zh, { ...OPTS, locale: "en_US" }).length === 3;
		} catch {
			return false;
		}
	})());
	check("NRL-28 a regional tag is accepted as given", extractChunks(zh, { ...OPTS, locale: "zh-cn" }).length === 3);
	check("NRL-28 platformSegmenters really has segmenters here", platformSegmenters.sentence("en") !== undefined && platformSegmenters.grapheme() !== undefined);
	check("NRL-28 noSegmenters really has none", noSegmenters.sentence("en") === undefined && noSegmenters.grapheme() === undefined && noSegmenters.word("en") === undefined);
}

console.log("NRL-50 blockType is real, not a constant (R-M11)");
{
	/*
	 * The block scan already computed which construct a line belongs to and threw
	 * the answer away, keeping only a boolean. This pins the value it should have
	 * kept, in order, across the block kinds the scan actually matches.
	 *
	 * Both segmenter positions, because blockType is seeded per chunk inside
	 * splitSentences and a different segmentation produces a different number of
	 * chunks per block. One position passing would not show the other regressing.
	 *
	 * The fixture deliberately spans the four classification routes rather than
	 * just AT Heading and two list items: an ATX heading (the HEADING match), a
	 * plain paragraph (the else), two bullets (LIST_BULLET), two quotes
	 * (BLOCKQUOTE), a setext pair (the flushParagraph route, which is the only
	 * way a buffered paragraph becomes a heading), a second paragraph, and a $$
	 * display-math block (the "other" route). A fixture missing any of them
	 * would let that one route rot without a single red line here.
	 */
	const src = [
		"# Heading one",
		"",
		"a prose paragraph that runs on for a while so the segmenter has something to chew on here",
		"",
		"- a list item",
		"- another list item",
		"",
		"> a quoted line",
		"> a second quoted line",
		"",
		"Setext heading here",
		"-----------------",
		"",
		"a paragraph after the setext heading",
		"",
		"$$",
		"x = 1 + 1",
		"$$",
		"",
	].join("\n");

	const want = [
		"heading",
		"paragraph",
		"list",
		"list",
		"quote",
		"quote",
		"heading",
		"paragraph",
		"other",
	];

	for (const [label, seg] of [
		["no segmenter", noSegmenters],
		["a segmenter", platformSegmenters],
	] as const) {
		const chunks = extractChunks(src, OPTS, seg, "Notes/blocks.md");
		const got = chunks.map((c) => c.blockType);
		check(
			`NRL-50 blockType sequence with ${label}`,
			got.length === want.length && got.every((b, i) => b === want[i]),
			`got ${JSON.stringify(got)} want ${JSON.stringify(want)} over ${JSON.stringify(chunks.map((c) => c.text))}`,
		);
		// Guard, not the point: if the segmentation itself moves, the sequence
		// above fails for the wrong reason and this says which part moved.
		check(`NRL-50 the fixture still yields nine chunks with ${label}`, chunks.length === 9, String(chunks.length));
		check(
			`NRL-50 every chunk carries its file with ${label}`,
			chunks.every((c) => c.filePath === "Notes/blocks.md"),
		);
	}

	/*
	 * The classification is per source construct, not per document: a document
	 * that is mostly prose must still mark its structural chunks. Before this,
	 * one line - the unconditional assignment in the identity post-pass -
	 * overwrote whatever the block scan had worked out, and the cost was a
	 * blockType that was "paragraph" for headings, quotes and lists too.
	 */
	const oneHeading = extractChunks("# Only a heading here\n", OPTS, noSegmenters, "Notes/one.md");
	check("NRL-50 a document that is only a heading is not all-paragraph", oneHeading[0]?.blockType === "heading", String(oneHeading[0]?.blockType));

	/*
	 * A quoted list item matches both matchers, and the outer construct wins:
	 * BLOCKQUOTE is peeled before LIST_BULLET looks, the same order the
	 * existing `if (!q) inList = true` draws. Without the guard the two rules
	 * would both fire and the last write would decide, which is the inner one.
	 */
	const quotedList = extractChunks("> - a quoted list item\n", OPTS, noSegmenters, "Notes/ql.md");
	check("NRL-50 a quoted list item is a quote, not a list", quotedList[0]?.blockType === "quote", String(quotedList[0]?.blockType));

	/*
	 * A lazy continuation of a list or quote matches nothing on its own line, so
	 * "paragraph" is the honest answer rather than a missed classification. It
	 * is chunk 1, not 0: the item above it is a real list chunk. Pinned so that
	 * if a later change starts tracking the container, the change is deliberate
	 * instead of silent.
	 */
	const lazy = extractChunks("- first item\nlazy continuation\n", OPTS, noSegmenters, "Notes/lazy.md");
	check("NRL-50 the item above is a list", lazy[0]?.blockType === "list", String(lazy[0]?.blockType));
	check("NRL-50 a lazy list continuation is a paragraph", lazy[1]?.blockType === "paragraph", String(lazy[1]?.blockType));
	const lazyQuote = extractChunks("> quoted first line\nlazy continuation of the quote\n", OPTS, noSegmenters, "Notes/lazyq.md");
	check("NRL-50 the quoted line above is a quote", lazyQuote[0]?.blockType === "quote", String(lazyQuote[0]?.blockType));
	check("NRL-50 a lazy quote continuation is a paragraph", lazyQuote[1]?.blockType === "paragraph", String(lazyQuote[1]?.blockType));

	/*
	 * The routes that deliberately do not reclassify. Verbatim code and
	 * frontmatter enter the paragraph buffer through the default, and a table
	 * row is stripped rather than spoken at this default. All three are
	 * "paragraph" by choice, not by omission, so they are pinned too.
	 */
	const spoken = extractChunks("Intro line.\n\n```js\nconst x = 1;\n```\n\nOutro line.\n", { ...OPTS, skipCodeBlocks: false }, noSegmenters, "Notes/code.md");
	check("NRL-50 a spoken fenced block is a paragraph", spoken.some((c) => c.text === "const x = 1;") && spoken.find((c) => c.text === "const x = 1;")?.blockType === "paragraph", spoken.map((c) => `${c.blockType}:${c.text}`).join("|"));
	const fm = extractChunks("---\ntitle: A Note\n---\nBody prose here.\n", { ...OPTS, skipFrontmatter: false }, noSegmenters, "Notes/fm.md");
	check("NRL-50 spoken frontmatter is a paragraph", fm.every((c) => c.blockType === "paragraph"), fm.map((c) => `${c.blockType}:${c.text}`).join("|"));

	/*
	 * Offset lockstep, restated on the fixture that now classifies its blocks.
	 * blockType is derived from which matcher fired on the raw line and never
	 * touches an index entry, so adding it must not move one.
	 */
	check(
		"NRL-50 sourceIndex still locksteps on the block fixture",
		extractChunks(src, OPTS, platformSegmenters, "Notes/blocks.md").every(
			(c) => unitsMatch(c.text, c.sourceIndex, src, (text) => text === "equation"),
		),
	);
}

/*
 * NRL-47 / ADR 0014: word granularity inside a CJK sentence.
 *
 * Before this ticket a whole run of Han, Kana or Hangul matched `findWords`'
 * single regex as ONE span, so `allocateWordTimings` gave that span the entire
 * chunk duration and the highlight never advanced inside a CJK sentence.
 * `extractChunks` now precomputes `chunk.wordSpans` for those chunks, and the
 * spans below are the observable form of that.
 *
 * `spansOf` deliberately goes through the same `?? findWords` fallback
 * `allocateWordTimings` uses, so these counts are what the player really gets
 * rather than what the field happens to hold.
 */
console.log("NRL-47 CJK word spans");
{
	const spansOf = (c: SpeechChunk) => c.wordSpans ?? findWords(c.text);
	const one = (raw: string) => extractChunks(raw, OPTS, platformSegmenters, "Notes/cjk.md");

	// F-zh. Three sentences, ICU("en") segments 这是第一句 as 这/是/第/一句.
	const zh = one("这是第一句。这是第二句。第三句结束了。");
	check("NRL-47 F-zh three chunks", zh.length === 3, `got ${zh.length}`);
	check(
		"NRL-47 F-zh every Chinese sentence is several spans",
		zh.every((c) => spansOf(c).length >= 3),
		zh.map((c) => spansOf(c).length).join(","),
	);

	// F-ja. Mixed kanji, hiragana and katakana: 日本語/の/テキスト/を/読み上げ/ます.
	const ja = one("日本語のテキストを読み上げます。");
	check("NRL-47 F-ja one chunk", ja.length === 1, `got ${ja.length}`);
	check("NRL-47 F-ja six spans", spansOf(ja[0]!).length === 6, `got ${spansOf(ja[0]!).length}`);

	/*
	 * F-ko, UNSPACED. V8's ICU ships no Korean word dictionary - measured on
	 * node v24.21.0, `안녕하세요세계반갑습니다` is ONE word segment under "ko",
	 * "en" and "und" alike - so this case is carried by the extra Hangul rule
	 * rather than by ICU: a Hangul run is cut at its grapheme boundaries, one
	 * span per syllable block. Twelve syllables, and the trailing "." stays
	 * glued to the last one because the regex span already included it.
	 */
	const koUnspaced = one("안녕하세요세계반갑습니다.");
	check(
		"NRL-47 F-ko unspaced Hangul is one span per syllable",
		spansOf(koUnspaced[0]!).length === 12,
		`got ${spansOf(koUnspaced[0]!).length}`,
	);

	/*
	 * Spaced Korean moves too, and that is intended: the Hangul rule is applied
	 * uniformly, so 안녕하세요/세계/반갑습니다 becomes 5 + 2 + 5 syllable spans
	 * rather than 3 word spans. Pinned so it can only change deliberately.
	 * Acceptance criterion 2 names Latin, Cyrillic, Greek and Arabic as the
	 * scripts that must not move; Korean is not among them.
	 */
	const koSpaced = one("안녕하세요 세계 반갑습니다");
	check(
		"NRL-47 spaced Hangul is pinned at per-syllable spans",
		spansOf(koSpaced[0]!).length === 12,
		`got ${spansOf(koSpaced[0]!).length}`,
	);

	/*
	 * F-mixed. A span that glues Latin to CJK does change, deliberately: it was
	 * never a Latin word span, it was a Latin word stuck to a CJK one.
	 */
	const mixed = one("ABC中文DEF");
	check("NRL-47 F-mixed splits at the script run", spansOf(mixed[0]!).length === 3, `got ${spansOf(mixed[0]!).length}`);

	/*
	 * F-weight. Once a sentence is several spans they have to be weighted, or
	 * the highlight still drifts inside it. `weightOf` counted ASCII vowel
	 * groups only and so returned 1 syllable for any CJK span of any width;
	 * it now adds one syllable per Han/Kana/Hangul code point. Compare a
	 * one-unit span against a three-unit one in the same chunk. Mirrors the
	 * "multi-syllable word outranks single vowel" check in engine.test.ts.
	 */
	const weight = one("日本語の話。");
	const wSpans = spansOf(weight[0]!);
	const widest = wSpans.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a), wSpans[0]!);
	const narrowest = wSpans.reduce((a, b) => (b.end - b.start < a.end - a.start ? b : a), wSpans[0]!);
	check(
		"NRL-47 F-weight a wide Han span outweighs a narrow one",
		widest.end - widest.start > narrowest.end - narrowest.start,
		wSpans.map((s) => `${s.word}:${s.end - s.start}`).join("|"),
	);

	/*
	 * P1. Offset lockstep, non-negotiable 8. Fixtures that really strip
	 * markdown, so `sourceIndex` is not the identity map and the assertion has
	 * teeth.
	 *
	 * Two forms, and the difference matters. The per-character form is the
	 * invariant: every code unit of every span names the raw unit its
	 * `sourceIndex` entry claims. The slice form is stronger and holds only for
	 * a span that does not straddle stripped syntax - on main the single span
	 * over `**日本語**の…` covered the `**` gap and could not satisfy it, and
	 * subdividing at script-run boundaries is what removes the straddle here.
	 * So the slice form is a real fail-first case on these fixtures rather than
	 * a general law; the per-character form is the general law.
	 */
	for (const raw of ["**日本語**のテキストを読み上げます", "[[链接|这是第一句。]]", "*안녕하세요세계반갑습니다*"]) {
		const chunks = one(raw);
		let unitsOk = true;
		for (const c of chunks) {
			for (const s of spansOf(c)) {
				for (let i = s.start; i < s.end; i++) {
					if (raw.charCodeAt(c.sourceIndex[i]!) !== c.text.charCodeAt(i)) unitsOk = false;
				}
			}
		}
		check(`NRL-47 P1 every span unit maps to its raw unit ${JSON.stringify(raw)}`, unitsOk);
		const bad = chunks.flatMap((c) =>
			spansOf(c).filter(
				(s) => raw.slice(c.sourceIndex[s.start]!, c.sourceIndex[s.end - 1]! + 1) !== c.text.slice(s.start, s.end),
			),
		);
		check(`NRL-47 P1 spans slice back to raw markdown ${JSON.stringify(raw)}`, bad.length === 0, `${bad.length} bad`);
	}

	/*
	 * P2. Partition invariant. Subdivision may only cut an existing regex span:
	 * it may not widen one, reorder them, or gain or lose a single character.
	 */
	const P2 = [
		"这是第一句。这是第二句。第三句结束了。",
		"日本語のテキストを読み上げます。",
		"안녕하세요세계반갑습니다.",
		"ABC中文DEF",
		"**日本語**のテキストを読み上げます",
		"The quick brown fox jumps over a lazy dog.",
	];
	for (const raw of P2) {
		let ok = true;
		for (const c of one(raw)) {
			const spans = spansOf(c);
			const plain = findWords(c.text);
			if (spans.some((s) => s.end <= s.start || s.start < 0 || s.end > c.text.length)) ok = false;
			if (spans.some((s, i) => i > 0 && s.start < spans[i - 1]!.end)) ok = false;
			if (spans.some((s) => s.word !== c.text.slice(s.start, s.end))) ok = false;
			const joined = spans.map((s) => c.text.slice(s.start, s.end)).join("");
			if (joined !== plain.map((s) => c.text.slice(s.start, s.end)).join("")) ok = false;
		}
		check(`NRL-47 P2 subdivision partitions the regex spans ${JSON.stringify(raw)}`, ok);
	}

	/*
	 * P4. Grapheme safety, scoped to the boundaries subdivision INTRODUCES.
	 * The Hangul rule cuts at grapheme boundaries for exactly this reason, and
	 * ICU's own word boundaries are cluster boundaries too.
	 *
	 * Scoped deliberately rather than asserted over every boundary, because the
	 * regex at words.ts already produces boundaries that are not cluster
	 * boundaries and always has - see the pin below. Asserting the unscoped
	 * form would fail on main and after the fix alike, and would be measuring
	 * the wrong thing.
	 */
	for (const raw of ["안녕하세요세계반갑습니다.", "コーヒーを飲みます。", "这是第一句。", "가́나́다́"]) {
		let ok = true;
		for (const c of one(raw)) {
			const allowed = new Set([0, c.text.length, ...graphemeBoundaries(c.text, platformSegmenters)]);
			const old = new Set(findWords(c.text).flatMap((s) => [s.start, s.end]));
			for (const s of spansOf(c)) {
				for (const at of [s.start, s.end]) {
					if (!old.has(at) && !allowed.has(at)) ok = false;
				}
			}
		}
		check(`NRL-47 P4 every introduced boundary is a grapheme boundary ${JSON.stringify(raw)}`, ok);
	}

	/*
	 * Pre-existing and untouched by NRL-47, written down so it is not mistaken
	 * for a regression here: a combining mark is neither `\p{L}` nor `\p{N}`,
	 * so the `findWords` regex ends a word at one and cuts inside the grapheme
	 * cluster. `가́나́다́` is three clusters and gives three
	 * one-unit spans on main and after this change alike, each ending inside
	 * its own cluster. Degenerate text only; no natural prose reaches it.
	 */
	const combining = one("가́나́다́");
	check(
		"NRL-47 pre-existing: the regex still ends a span at a combining mark",
		spansOf(combining[0]!).length === 3 &&
			spansOf(combining[0]!).every((s) => s.end - s.start === 1),
		spansOf(combining[0]!).map((s) => `${s.start}-${s.end}`).join("|"),
	);

	/*
	 * Decision 1: with no `Intl.Segmenter` the word layer keeps today's single
	 * span per CJK sentence. R-S03 is a SHOULD, so degrading to sentence
	 * granularity stays in spec, and there is no useful offline word rule to
	 * fall back on (see the comment on `wordBoundaries`).
	 */
	const noSeg = extractChunks("日本語のテキストを読み上げます。", OPTS, noSegmenters, "Notes/cjk.md");
	check(
		"NRL-47 no segmenter leaves wordSpans absent",
		noSeg.every((c) => c.wordSpans === undefined),
	);

	/*
	 * The identity half of acceptance criterion 2, at the chunk level: a chunk
	 * holding no Han, Kana or Hangul gains no `wordSpans` field at all, so its
	 * shape and its memory are exactly what they were and the regex remains the
	 * whole rule. The timing-level form of this is in engine.test.ts (P5).
	 */
	const others = [
		"The quick brown fox jumps over a lazy dog.",
		"Съешь ещё этих мягких французских булок.",
		"Ο γρήγορος καφέ αλεπού πηδάει.",
		"نص حكيم له سر قاطع وذو شأن.",
		"well-known U.S.A. e.g. dont’t over.",
	];
	for (const raw of others) {
		const chunks = one(raw);
		check(
			`NRL-47 non-CJK text gains no wordSpans ${JSON.stringify(raw)}`,
			chunks.every((c) => c.wordSpans === undefined),
		);
	}
}

// NRL-118: the renderer block scan itself. Each expectation is [start line,
// last covered line] of every `%%` block comment, read off Obsidian 1.13.7's
// own parser executed out of the installed bundle (the mdast comment node's
// start line, and the line of its last character by source offset). These pin
// the three rules a column model got wrong, plus the bundle's own wrapper that
// refuses a `[^` definition label and remark's per-line offset table.
console.log("NRL-118 renderer block scan (obsidianBlocks.ts)");
{
	const scan = (src: string): string => JSON.stringify((rendererPercentBlocks(src) ?? []).map((b) => [b.startLine, b.lastLine]));
	const cases: Array<[string, string, Array<[number, number]>]> = [
		["different depth opens a new block", ">> %%\n%% SECRET", [[0, 0], [1, 1]]],
		["min-indent dedent with the `1.` phantom column keeps the tab line lazy", "1. > %%\n   \tSECRET", [[0, 1]]],
		["`1)` has no phantom column, so the tab line is code and ends the quote", "1) > %%\n   \tSECRET", [[0, 0]]],
		["a refused marker still counts its column, so the item continues", "-   %% x\n\n   ---\nSECRET", [[0, 3]]],
		["more than four columns continues an item whatever its content column", "> - \n  \t- %%\n     # SECRET", [[1, 2]]],
		["a `[^` label is never a definition", "[^id\n***\n%%\n+  \n***]:$$\n------(1.", [[2, 5]]],
		["a plain label is, and swallows the `%%` line", "[id\n***\n%%\n+  \n***]:$$\n------(1.", []],
		["a whitespace line the item stripped belongs to the comment", "  - %% QaQ\n    ", [[0, 1]]],
		["a callout title line is tokenized on its own", "> [!note] %%\n> x", [[0, 0]]],
		["no container: closed by the next `%%`", "%%\n%% SECRET", [[0, 1]]],
		["CRLF keeps line numbers", "a\r\n> %%\r\nb", [[1, 2]]],
	];
	for (const [name, src, want] of cases) check(`NRL-118 scan: ${name}`, scan(src) === JSON.stringify(want), scan(src));
	check("NRL-118 scan: a lone carriage return gives no answer", rendererPercentBlocks("a\rb") === null);
	check("NRL-118 scan: nesting past the depth bound gives no answer", rendererPercentBlocks(">".repeat(70) + " %%\nx") === null);
	const closedFlag = rendererPercentBlocks("%%\n%% SECRET")?.[0]?.closed === true && rendererPercentBlocks(">> %%\n%% SECRET")?.[0]?.closed === false;
	check("NRL-118 scan: `closed` tells a closer from a container end", closedFlag);
}

/*
 * NRL-114. THE PEEL'S OWN QUOTE MARKER RULE, AND THE LOOP INVARIANT THAT
 * LICENSES `quotes` AS A BUDGET.
 *
 * Obsidian's blockquote tokenizer (module 6234) consumes the `>` and then
 * advances over at most one character, and that character must be a SPACE
 * (`t.charAt(D)===a&&D++` with `a = " "`). Our shared `BLOCKQUOTE` allows any
 * single whitespace character, so `>` + TAB + `%%` lost its tab for us and kept
 * it for the renderer, which hid text Obsidian displays. NRL-114 narrows the
 * PEEL only - `QUOTE_LEVEL_PEEL` and `QUOTE_PREFIX_PEEL` - and leaves
 * `BLOCKQUOTE` byte-identical for `interruptsParagraph`, the `listDedented`
 * pass, the `setextContent` listInRun scan and the `inList` end test. That is
 * the NRL-98 precedent verbatim: feed the UNCHANGED predicate a different
 * string rather than moving the shared one.
 *
 * These checks read `src/text/extract.ts` as TEXT, the way release.test.ts
 * reads the workflow, because the thing being pinned is a relationship between
 * two literals and a set of call sites and none of it is reachable through the
 * module's one export. Every extractor THROWS rather than returning empty, so
 * a parser that stops matching fails the suite instead of passing vacuously.
 *
 * The behavioural half of the same invariant lives in the NRL-38 table above:
 * a mutation that narrows the counter and leaves the all-levels gate wide turns
 * nine of its fixtures red (listed beside
 * pin-nrl114-nested-tab-space-budget-invariant, which itself no longer moves on
 * that mutation on 9132c3b), which is what stops the textual check being the
 * only thing standing between a green suite and a half-adopted fix.
 */
console.log("NRL-114 the peel's quote marker rule and its loop invariant (R-M08)");
{
	const __filename114 = fileURLToPath(import.meta.url);
	const ROOT114 = path.resolve(path.dirname(__filename114), "../..");
	const SRC114 = fs.readFileSync(path.join(ROOT114, "src/text/extract.ts"), "utf8");

	/**
	 * The source text of `const <name> = /<body>/;`, as written. THROWS on a
	 * miss: a soft return would make every check below pass on a file that no
	 * longer holds the constant at all.
	 */
	function regexLiteral(name: string): string {
		const m = SRC114.match(new RegExp(`^const ${name} = /(.*)/;$`, "m"));
		if (!m) throw new Error(`NRL-114: no top-level regex literal named ${name} in src/text/extract.ts`);
		return m[1]!;
	}

	const levelBody = regexLiteral("QUOTE_LEVEL_PEEL");
	const prefixBody = regexLiteral("QUOTE_PREFIX_PEEL");
	const sharedBody = regexLiteral("BLOCKQUOTE");

	// (a) THE COMPOSITION. The all-levels form must be LITERALLY the one-level
	// form repeated, or `containerPrefix`'s documented guarantee - "the
	// iteration consumes exactly q[0]" - stops holding and `quotes` stops being
	// a sound peel budget. Measured on the half-fix that narrows the counter
	// only: `>\t>\tx` gives the gate `end = 4` while the walk stops at `at = 3`,
	// so `chars` advances four characters that no counted level consumed.
	check(
		"NRL-114 (a) QUOTE_PREFIX_PEEL is literally one QUOTE_LEVEL_PEEL repeated",
		levelBody.startsWith("^") && prefixBody === `^(?:${levelBody.slice(1)})+`,
		`level=${levelBody} prefix=${prefixBody}`,
	);

	// (b) PEEL-LOCALITY. The shared constant must still be the WIDE CommonMark
	// one. If it narrows, `interruptsParagraph` moves, which moves
	// `codeSpanClosesLater` and collides with ADR 0019's F5 guard.
	check("NRL-114 (b) the shared BLOCKQUOTE is still the wide any-whitespace rule", sharedBody === "^(?:\\s{0,3}>\\s?)+");
	// A SPACE, and a lone CR, and nothing else. The CR is measured rather than
	// assumed: it is a line TERMINATOR for the renderer, so consuming it puts the
	// next construct at offset 0 of our body exactly as the renderer puts it at a
	// line start, and leaving it in place newly SPEAKS author-hidden text in 32,256
	// of the census reconstruction's 5,160,960 sentinel-cells (re-measured on 9132c3b).
	check("NRL-114 (b) the peel's one-level rule allows a space or a lone CR only", levelBody === "^\\s{0,3}>[ \\r]?");

	// (c) THE CALL SITES. Four peel sites must read the peel constants, and the
	// four deliberate NON-sites must still read the shared one. A mutation that
	// leaves the constants alone and points one site back at `BLOCKQUOTE` is
	// invisible to (a) and (b), and it is exactly the half-fix shape.
	const SITES: ReadonlyArray<readonly [string, string]> = [
		["containerPrefix all-levels gate", "const q = line.slice(chars).match(QUOTE_PREFIX_PEEL);"],
		["containerPrefix per-level counter", "const level = QUOTE_LEVEL_PEEL.exec(line.slice(at, end));"],
		["peelQuotes budget spend", "const level = QUOTE_LEVEL_PEEL.exec(rest);"],
		["isSetextContentLine line prefix", "const q = line.match(QUOTE_PREFIX_PEEL);"],
		["isSetextContentLine next prefix", "const nq = next.match(QUOTE_PREFIX_PEEL);"],
	];
	for (const [what, text] of SITES) {
		check(`NRL-114 (c) peel site reads the peel rule: ${what}`, SRC114.includes(text));
	}
	const NON_SITES: ReadonlyArray<readonly [string, string]> = [
		["interruptsParagraph", "BLOCKQUOTE.test(line) ||"],
		["listDedented quote peel", 'const body = raw.replace(BLOCKQUOTE, "");'],
		["setextContent listInRun peel", 'const quotePeeled = raw.replace(BLOCKQUOTE, "");'],
		["inList end test", "BLOCKQUOTE.test(raw))"],
	];
	for (const [what, text] of NON_SITES) {
		check(`NRL-114 (c) non-site still reads the shared BLOCKQUOTE: ${what}`, SRC114.includes(text));
	}
	// `BLOCKQUOTE_LEVEL` is renamed rather than duplicated: its only two readers
	// were the peel. An unused narrow twin beside a live wide one is how two
	// readings of the same thing start disagreeing again.
	check(
		"NRL-114 (c) no BLOCKQUOTE_LEVEL code reference survives the rename",
		!SRC114.split("\n").some((l) => l.includes("BLOCKQUOTE_LEVEL") && !l.trimStart().startsWith("*")),
	);

	// (d) THE PROPERTY, run over a constructed corpus of prefix lines rather
	// than over one hand-picked example. Iterating the one-level rule from
	// offset 0 must consume exactly what the all-levels rule matched, for every
	// line. Non-vacuity is asserted: a corpus that matched nothing anywhere
	// would make this green for the wrong reason.
	const LEVEL114 = new RegExp(levelBody);
	const PREFIX114 = new RegExp(prefixBody);
	const WS114 = ["", " ", "  ", "   ", "    ", "\t", "\t ", " \t", "\t\t", " ", "\r", "\v", "　"];
	const MARK114 = [">", ">>", "> >", "> > >", "   >", ">\t>", "- >", "> -", "  >"];
	const lines114: string[] = [];
	for (const m of MARK114) for (const w of WS114) for (const body of ["%%", "<!--", "x", "![alt](d.png)", ""]) lines114.push(m + w + body);
	let mismatch114 = 0;
	let nonEmpty114 = 0;
	let firstBad114 = "";
	for (const line of lines114) {
		const p = line.match(PREFIX114);
		const want = p ? p[0].length : 0;
		if (want > 0) nonEmpty114 += 1;
		let at = 0;
		for (;;) {
			const lv = LEVEL114.exec(line.slice(at, want));
			if (!lv || lv[0].length === 0) break;
			at += lv[0].length;
		}
		if (at !== want) {
			mismatch114 += 1;
			if (!firstBad114) firstBad114 = `${JSON.stringify(line)} want ${want} walked ${at}`;
		}
	}
	check(
		`NRL-114 (d) the per-level walk consumes exactly the all-levels match over ${lines114.length} prefix lines`,
		mismatch114 === 0,
		firstBad114,
	);
	check(
		"NRL-114 (d) the property corpus is non-vacuous (most lines carry a real prefix)",
		nonEmpty114 > lines114.length / 2,
		`nonEmpty=${nonEmpty114} of ${lines114.length}`,
	);
}

console.log("fence opener/closer honour the renderer's three-space cap (NRL-156, NRL-132, R-M08)");
{
	/**
	 * sourceIndex lockstep: equal length to the text, and every non-space
	 * character maps to the same raw character at a monotonic, in-bounds
	 * offset. Mirrors the house `unitsMatch`/lockstep convention used
	 * throughout this file.
	 */
	function lockstepOk(src: string, chunks: SpeechChunk[]): boolean {
		for (const c of chunks) {
			if (c.sourceIndex.length !== c.text.length) return false;
			for (let i = 0; i < c.text.length; i++) {
				const at = c.sourceIndex[i]!;
				if (c.text[i] === " ") continue;
				if (at < 0 || at >= src.length) return false;
				if (src[at] !== c.text[i]) return false;
				if (i > 0 && at < c.sourceIndex[i - 1]!) return false;
			}
		}
		return true;
	}

	const cases: Array<[string, string, string, Partial<typeof OPTS>?]> = [
		// NRL-156's own repro: a 4-space-led ``` after an open paragraph is a
		// lazy continuation for the renderer (module 8607: at most three spaces,
		// no tab), not a fence, so the <!-- block beneath it is never swallowed
		// as fence content and its HTML comment (HIDDENA) stays hidden. Base
		// (pre-fix) speaks "Intro. <!-- === HIDDENA --> Tail." under default
		// options - a disclosure.
		["nrl156-headline-disclosure", "Intro.\n    ```\n \t<!--\n===\nHIDDENA\n-->\nTail.", "Intro. Tail."],
		[
			"nrl156-headline-disclosure-codeoff",
			"Intro.\n    ```\n \t<!--\n===\nHIDDENA\n-->\nTail.",
			"Intro. Tail.",
			{ skipCodeBlocks: false },
		],
		// NRL-132's own three repro cases, folded in per the clarification: the
		// opposite (prose-loss) face of the same root. Base speaks only the
		// opening line in all three, because the wrongly-opened fence never
		// finds a closer and swallows everything after it, VISIBLE1/VISIBLE2
		// included.
		["nrl132-4-space-lead", "Before x.\n    ```\nVISIBLE1\n\nVISIBLE2", "Before x. VISIBLE1 VISIBLE2"],
		["nrl132-6-space-lead", "Before x.\n      ```\nVISIBLE1\n\nVISIBLE2", "Before x. VISIBLE1 VISIBLE2"],
		["nrl132-8-space-lead-in-list-item", "- Item x.\n\n        ```\n  VISIBLE1\n\nVISIBLE2", "Item x. VISIBLE1 VISIBLE2"],
		// Closer cap (NRL-132's own AC: "closer rule is also at most three
		// spaces"): a 4-space-led ``` inside an already-open, zero-indent fence
		// is fence CONTENT, not a closer, so it must not end the fence early.
		// The real closer two lines later (zero indent) does end it.
		[
			"nrl132-closer-cap-four-space-is-content-not-closer",
			"Before.\n```\ncode1\n    ```\ncode2\n```\nAfter.",
			"Before. code1 ``` code2 After.",
			{ skipCodeBlocks: false },
		],
		// The opener's two branches are asymmetric on purpose (fenceOpensAt):
		// a FRESH block tolerates a lead that is not a leading four spaces or a
		// tab, so a one-space-then-tab lead still opens a fresh-block fence -
		// a shape a single `{0,3}`-style cap would wrongly reject. Confirmed
		// against the real Obsidian 1.13.7 renderer (oracle111/parser.cjs,
		// harness at ~/.local/share/note-reader-local/obsidian-parser-harness):
		// " \t```" over "code1" over "```" at document start renders one
		// <pre><code>code1</code></pre>.
		["nrl156-fresh-block-space-tab-lead-still-opens", "\n \t```\ncode1\n```\nAfter.", "code1 After.", { skipCodeBlocks: false }],
		// The CONTINUATION branch is strict (spaces only, 0-3): the same
		// one-space-then-tab lead, after an open paragraph, must NOT open.
		// Renderer-confirmed: the ``` line and "middle" stay in one <p>.
		[
			"nrl156-continuation-space-tab-lead-does-not-open",
			"Before x.\n \t```\nmiddle\nAfter.",
			"Before x. middle After.",
			{ skipCodeBlocks: false },
		],
		// Controls: a zero-indent fence is unaffected by any of this.
		["control-zero-indent-fence-codeoff", "Before.\n```\ncode1\ncode2\n```\nAfter.", "Before. code1 code2 After.", { skipCodeBlocks: false }],
		["control-zero-indent-fence-codeon", "Before.\n```\ncode1\ncode2\n```\nAfter.", "Before. After."],
	];
	for (const [id, src, expected, overrides] of cases) {
		const chunks = extractChunks(src, { ...OPTS, ...overrides });
		const spoken = chunks.map((c) => c.text).join(" ");
		check(`NRL-156/NRL-132 ${id}: visible output`, spoken === expected, spoken);
		if (src.includes("HIDDENA")) {
			check(`NRL-156/NRL-132 ${id}: hidden text not disclosed`, !spoken.includes("HIDDENA"));
		}
		check(`NRL-156/NRL-132 ${id}: sourceIndex lockstep`, lockstepOk(src, chunks));
	}

	// sourceIndex lockstep is non-vacuous: four mutators, each shown able to
	// FAIL the checker on at least one of the fixtures above, so a green run
	// above is not a checker that can never go red (the house convention:
	// drop-one-entry/length, shift-all-by-one/bounds+identity,
	// swap-two-entries/monotonic+identity, negate-one/monotonic+bounds).
	{
		const sample = cases[2]!; // nrl132-4-space-lead, has a real, non-trivial index
		const chunks = extractChunks(sample[1], { ...OPTS, ...sample[3] });
		const c = chunks[0]!;
		let dropOneFails = 0;
		let shiftFails = 0;
		let swapFails = 0;
		let negateFails = 0;
		const base = c.sourceIndex;
		const mutantOk = (mutated: number[]): boolean => {
			const text = c.text;
			if (mutated.length !== text.length) return false;
			for (let i = 0; i < text.length; i++) {
				const at = mutated[i]!;
				if (text[i] === " ") continue;
				if (at < 0 || at >= sample[1].length) return false;
				if (sample[1][at] !== text[i]) return false;
				if (i > 0 && at < mutated[i - 1]!) return false;
			}
			return true;
		};
		// drop-one-entry: wrong length, must fail.
		if (!mutantOk(base.slice(1))) dropOneFails += 1;
		// shift-all-by-one: every entry +1, may go out of bounds or break identity.
		if (!mutantOk(base.map((n) => n + 1))) shiftFails += 1;
		// swap-two-entries: breaks monotonicity (and usually identity too).
		if (base.length >= 2) {
			const swapped = base.slice();
			const tmp = swapped[0]!;
			swapped[0] = swapped[swapped.length - 1]!;
			swapped[swapped.length - 1] = tmp;
			if (!mutantOk(swapped)) swapFails += 1;
		}
		// negate-one: a single entry forced to -1, breaks monotonicity and bounds.
		// Picked on a non-space character of the text, since the checker
		// deliberately skips spaces (a synthesised space exists in neither
		// input), so negating a space's own index would not move anything.
		if (base.length >= 2) {
			const text = c.text;
			let idx = -1;
			for (let i = 1; i < text.length; i++) {
				if (text[i] !== " ") {
					idx = i;
					break;
				}
			}
			if (idx !== -1) {
				const negated = base.slice();
				negated[idx] = -1;
				if (!mutantOk(negated)) negateFails += 1;
			}
		}
		check("NRL-156/NRL-132 sourceIndex checker is non-vacuous: drop-one-entry fails", dropOneFails > 0);
		check("NRL-156/NRL-132 sourceIndex checker is non-vacuous: shift-all-by-one fails", shiftFails > 0);
		check("NRL-156/NRL-132 sourceIndex checker is non-vacuous: swap-two-entries fails", swapFails > 0);
		check("NRL-156/NRL-132 sourceIndex checker is non-vacuous: negate-one fails", negateFails > 0);
		check("NRL-156/NRL-132 sourceIndex checker passes on the real (unmutated) output", mutantOk(base));
	}

	// Mechanism proof: the three sites the plan found to be proven no-ops
	// (FENCE only ever reached at lead="" there) must still read the bare
	// FENCE constant, not fenceOpensAt - if one of them starts reading
	// fenceOpensAt, that is a deliberate change needing its own re-measurement,
	// not a silent drift.
	const __filename156 = fileURLToPath(import.meta.url);
	const ROOT156 = path.resolve(path.dirname(__filename156), "../..");
	const SRC156 = fs.readFileSync(path.join(ROOT156, "src/text/extract.ts"), "utf8");
	const noOpSites: ReadonlyArray<readonly [string, string]> = [
		["listItemContent/listDedented run-end", "(blankBefore || (!quoted && (HEADING.test(body) || FENCE.test(body) || HR.test(body))))"],
		["main-loop list-end test", "(wasBlank || HEADING.test(raw) || FENCE.test(raw) || HR.test(raw) || BLOCKQUOTE.test(raw))"],
	];
	for (const [what, text] of noOpSites) {
		check(`NRL-156 no-op site unchanged (still reads bare FENCE): ${what}`, SRC156.includes(text));
	}
	// The three sites that DO change must call the new shared predicate.
	const fixedSites: ReadonlyArray<readonly [string, string]> = [
		["containerViews fence detection", "const fence = fenceOpensAt(fenceLead, wasOpen) ? t.match(/^[ \\t]*(`{3,}|~{3,})/) : null;"],
		["endsTerm2Block", "(fenceOpensAt(line.match(/^[ \\t]*/)![0], paraLinesAbove > 0) && FENCE.test(line)) ||"],
		["main-loop opener", 'if (fenceOpensAt(fenceLead, wasPara) && FENCE.test(raw)) {'],
	];
	for (const [what, text] of fixedSites) {
		check(`NRL-156 fixed site calls fenceOpensAt: ${what}`, SRC156.includes(text));
	}
	// The narrowing (interruptsParagraphExceptBareMarker) must use the capped
	// constant, not the bare any-indent FENCE.
	check(
		"NRL-156 interruptsParagraphExceptBareMarker narrowed to FENCE_CONTINUATION",
		SRC156.includes("FENCE_CONTINUATION.test(line) ||"),
	);
	check("NRL-156 FENCE_CONTINUATION is capped at three spaces", SRC156.includes("const FENCE_CONTINUATION = /^ {0,3}(```|~~~)/;"));
}

console.log("a whitespace-only line holding a tab is a lazy continuation of an open paragraph (NRL-158, R-M08)");
{
	/**
	 * sourceIndex lockstep, the same house convention `lockstepOk` already
	 * establishes in the NRL-156 block above: equal length to the text, and
	 * every non-space character maps to the same raw character at a
	 * monotonic, in-bounds offset. Named distinctly only so a grep for this
	 * ticket's own checks is unambiguous; the rule is identical.
	 */
	function lockstepOk158(src: string, chunks: SpeechChunk[]): boolean {
		for (const c of chunks) {
			if (c.sourceIndex.length !== c.text.length) return false;
			for (let i = 0; i < c.text.length; i++) {
				const at = c.sourceIndex[i]!;
				if (c.text[i] === " ") continue;
				if (at < 0 || at >= src.length) return false;
				if (src[at] !== c.text[i]) return false;
				if (i > 0 && at < c.sourceIndex[i - 1]!) return false;
			}
		}
		return true;
	}

	// PINS. Harness-measured against Obsidian 1.13.7's real parser and
	// renderer (oracle: `WT`/`GT` in ~/.local/share/note-reader-local/
	// obsidian-parser-harness, app.js sha256 8efbf581...9898): module 8607
	// reads ANY whitespace-only line holding a tab, anywhere in the run, as a
	// lazy continuation of the paragraph it follows - never the blank line
	// that would end it. Leading-space count before the tab does not matter,
	// and a CR-terminated tab line behaves identically. Each note is the
	// ticket's own repro (`Intro.` / a whitespace-only tab line / a tab-led
	// `<!--` block whose `===`/`HIDDENA`/`-->` the renderer hides inside the
	// one continuing paragraph) with the blank line's own shape varied. Every
	// row is RED against base (speaks the hidden `=== HIDDENA --> t.` because
	// the old unconditional `.trim() === ""` test flushes "Intro." on the
	// blank line, which wrongly marks the following `\t<!--` line as following
	// a blank line, misfiring the indented-code-open guard and reaching
	// `opensHtmlBlock` as a fresh block, which never closes the comment and
	// hides the rest of the note to end of input).
	const pins: Array<[string, string, string]> = [
		["bare-tab-blank-continues-paragraph", "Intro.\n\t\n\t<!--\n===\nHIDDENA\n--> t.", "Intro. t."],
		["tab-space-blank-continues-paragraph", "Intro.\n\t \n\t<!--\n===\nHIDDENA\n--> t.", "Intro. t."],
		["two-tabs-blank-continues-paragraph", "Intro.\n\t\t\n\t<!--\n===\nHIDDENA\n--> t.", "Intro. t."],
		["cr-terminated-tab-blank-continues-paragraph", "Intro.\n\t\r\n\t<!--\n===\nHIDDENA\n--> t.", "Intro. t."],
	];
	for (const [id, src, expected] of pins) {
		const chunks = extractChunks(src, OPTS);
		const spoken = chunks.map((c) => c.text).join(" ");
		check(`NRL-158 pin-${id}: visible output`, spoken === expected, spoken);
		check(`NRL-158 pin-${id}: HIDDENA not disclosed`, !spoken.includes("HIDDENA"));
		check(`NRL-158 pin-${id}: sourceIndex lockstep`, lockstepOk158(src, chunks));
	}

	// GUARDS, axis 1: no paragraph is open before the whitespace-only tab
	// line, so module 8607's lazy-continuation rule never applies and the
	// line is ordinary blank - exactly as the harness census found. Each is
	// measured BYTE-IDENTICAL between base and the fix (same mechanism as the
	// pre-existing `guard-nrl155-module134-*` rows: the `\t<!--` that follows
	// is swallowed whole by our own INDENTED_CODE branch, a pre-existing,
	// out-of-scope miss unrelated to the blank-line question this ticket
	// answers). Counted as nothing; red on neither arm; present so a future
	// change to the blank-line rule cannot silently start reaching into the
	// "no paragraph open" axis without a test naming it.
	const guardsNoParagraphOpen: Array<[string, string, string]> = [
		["doc-start-bare-tab-blank", "\t\n\t<!--\n===\nHIDDENA\nmore", "=== HIDDENA more"],
		["after-heading-bare-tab-blank", "# Head\n\t\n\t<!--\n===\nHIDDENA\nmore", "Head === HIDDENA more"],
		["after-hr-bare-tab-blank", "Intro.\n\n***\n\t\n\t<!--\n===\nHIDDENA\nmore", "Intro. === HIDDENA more"],
		["after-fence-bare-tab-blank", "```\ncode\n```\n\t\n\t<!--\n===\nHIDDENA\nmore", "=== HIDDENA more"],
		["after-real-blank-bare-tab-blank", "Intro.\n\n\t\n\t<!--\n===\nHIDDENA\nmore", "Intro. === HIDDENA more"],
	];
	for (const [id, src, expected] of guardsNoParagraphOpen) {
		const spoken = extractChunks(src, OPTS)
			.map((c) => c.text)
			.join(" ");
		check(`NRL-158 guard-${id}: unchanged (no paragraph open)`, spoken === expected, spoken);
	}

	// GUARDS, axis 2: containers. The plan's own harness census found quote
	// and list behaviour genuinely different from the top-level rule above (a
	// bare line with no `>`/marker at all ends the container regardless of a
	// tab, and a quote/list line carrying its OWN marker interacts with the
	// renderer's setext/html precedence in ways the top-level rule does not
	// model) and scoped it OUT: `wasPara` is only ever true for a top-level
	// plain-paragraph line, never for a quote/list line, and the fix is
	// additionally gated on this line's own `blockType === "paragraph"` so a
	// fresh container marker can never be misread as a lazy continuation of
	// whatever came before it. Every row here is measured BYTE-IDENTICAL
	// between base and the fix - containers are untouched, not merely
	// unbroken - and is not a claim that the value matches the renderer.
	const guardsContainer: Array<[string, string, string]> = [
		["quote-marker-tab-blank-no-comment", "Intro.\n> \t\n> more.", "Intro. more."],
		["quote-tab-blank-then-comment", "Intro.\n> \t\n> <!--\n> ===\n> HIDDENA\n> --> t.", "Intro. <!-- === HIDDENA --> t."],
		["list-tab-blank-then-comment", "Intro.\n- \t\n  <!--\n  ===\n  HIDDENA\n  --> t.", "Intro. t."],
		["quote-real-paragraph-tab-blank-continues-plain", "> Before x.\n> \t\n> more.", "Before x. more."],
	];
	for (const [id, src, expected] of guardsContainer) {
		const spoken = extractChunks(src, OPTS)
			.map((c) => c.text)
			.join(" ");
		check(`NRL-158 guard-${id}: unchanged (container, out of scope)`, spoken === expected, spoken);
	}

	// PIN: two consecutive tab-only blank lines before the next real text.
	// The joined TEXT alone cannot tell base from the fix here (both happen
	// to read "Intro. Next.", since there is nothing between the two notes to
	// speak differently) - what differs is the CHUNK STRUCTURE and the
	// sourceIndex map, which is exactly why the plan called this shape out by
	// name for the lockstep proof. Base flushes "Intro." at the first tab
	// line (2 chunks); the fix keeps the paragraph open across BOTH swallowed
	// lines and appends "Next." through the same join-space synthesis every
	// other soft-wrapped continuation uses (1 chunk, one synthetic gap
	// offset).
	{
		const src = "Intro.\n\t\n\t\nNext.";
		const chunks = extractChunks(src, OPTS);
		const spoken = chunks.map((c) => c.text).join(" ");
		check("NRL-158 pin-double-tab-blank: visible output", spoken === "Intro. Next.", spoken);
		check("NRL-158 pin-double-tab-blank: merges into exactly one chunk", chunks.length === 1, String(chunks.length));
		check("NRL-158 pin-double-tab-blank: sourceIndex lockstep", lockstepOk158(src, chunks));
	}

	// sourceIndex lockstep is non-vacuous: four mutators, each shown able to
	// FAIL the checker on the double-tab-blank chunk above (a real,
	// non-trivial index with a synthetic gap in it), per the house convention
	// (drop-one-entry/length, shift-all-by-one/bounds+identity,
	// swap-two-entries/monotonic+identity, negate-one/monotonic+bounds).
	{
		const src = "Intro.\n\t\n\t\nNext.";
		const chunks = extractChunks(src, OPTS);
		const c = chunks[0]!;
		const base = c.sourceIndex;
		const mutantOk = (mutated: number[]): boolean => {
			const text = c.text;
			if (mutated.length !== text.length) return false;
			for (let i = 0; i < text.length; i++) {
				const at = mutated[i]!;
				if (text[i] === " ") continue;
				if (at < 0 || at >= src.length) return false;
				if (src[at] !== text[i]) return false;
				if (i > 0 && at < mutated[i - 1]!) return false;
			}
			return true;
		};
		let dropOneFails = 0;
		let shiftFails = 0;
		let swapFails = 0;
		let negateFails = 0;
		// drop-one-entry: wrong length, must fail.
		if (!mutantOk(base.slice(1))) dropOneFails += 1;
		// shift-all-by-one: every entry +1, may go out of bounds or break identity.
		if (!mutantOk(base.map((n) => n + 1))) shiftFails += 1;
		// swap-two-entries: breaks monotonicity (and usually identity too).
		if (base.length >= 2) {
			const swapped = base.slice();
			const tmp = swapped[0]!;
			swapped[0] = swapped[swapped.length - 1]!;
			swapped[swapped.length - 1] = tmp;
			if (!mutantOk(swapped)) swapFails += 1;
		}
		// negate-one: a single entry forced to -1, breaks monotonicity and
		// bounds. Picked on a non-space character of the text past index 0,
		// since the checker deliberately skips spaces (the synthesised gap
		// exists in neither input), so negating a space's own index would not
		// move anything.
		if (base.length >= 2) {
			const text = c.text;
			let idx = -1;
			for (let i = 1; i < text.length; i++) {
				if (text[i] !== " ") {
					idx = i;
					break;
				}
			}
			if (idx !== -1) {
				const negated = base.slice();
				negated[idx] = -1;
				if (!mutantOk(negated)) negateFails += 1;
			}
		}
		check("NRL-158 sourceIndex checker is non-vacuous: drop-one-entry fails", dropOneFails > 0);
		check("NRL-158 sourceIndex checker is non-vacuous: shift-all-by-one fails", shiftFails > 0);
		check("NRL-158 sourceIndex checker is non-vacuous: swap-two-entries fails", swapFails > 0);
		check("NRL-158 sourceIndex checker is non-vacuous: negate-one fails", negateFails > 0);
		check("NRL-158 sourceIndex checker passes on the real (unmutated) output", mutantOk(base));
	}

	// Mechanism proof, the same convention as the NRL-156 block's
	// `fixedSites`/`noOpSites` checks: the fix is one named predicate shared
	// by the three sites the plan identified, not three independent patches.
	// If one of these call sites stops reading `blankEndsParagraph`, that is
	// a deliberate change needing its own re-measurement, not a silent drift.
	const __filename158 = fileURLToPath(import.meta.url);
	const ROOT158 = path.resolve(path.dirname(__filename158), "../..");
	const SRC158 = fs.readFileSync(path.join(ROOT158, "src/text/extract.ts"), "utf8");
	check(
		"NRL-158 shared predicate blankEndsParagraph is defined",
		/function blankEndsParagraph\(line: string, paragraphOpen: boolean\): boolean \{/.test(SRC158),
	);
	const fixedSites158: ReadonlyArray<readonly [string, string]> = [
		["htmlParaOpen precompute (site 1)", "blankEndsParagraph(view, wasOpen)"],
		["main-loop blank test (site 2)", 'const blank = blankEndsParagraph(raw, wasPara);'],
		["paragraph-flush test (site 3)", "blockType === \"paragraph\" && !blankEndsParagraph(body, wasPara)"],
	];
	for (const [what, text] of fixedSites158) {
		check(`NRL-158 fixed site calls blankEndsParagraph: ${what}`, SRC158.includes(text));
	}
	// Confirms the plan's own invariant by construction rather than by luck:
	// `prevPara` is never left true by this fix for a line whose OWN
	// blockType is quote/list, so it can never disagree with `prevContainer`
	// (set unconditionally for those blockTypes a few lines above this
	// check). Measured byte-identical with and without this guard on every
	// fixture in this file; kept anyway because the invariant should hold by
	// construction, not by the corpus this ticket happened to try.
	check(
		"NRL-158 paragraph-flush fix is gated on this line's own blockType, not only on wasPara",
		SRC158.includes('if (blockType === "paragraph" && !blankEndsParagraph(body, wasPara)) {'),
	);
}

console.log("NRL-162 Fix round 1: a %%-opener-shaped line cannot shrink the item's own dedent");
// Expectations from the installed Obsidian 1.13.7 WT/GT, not from our scanner.
// Ship's own critique input: four %% lines at indents 5/2/1/3, no other
// non-blank line in the item (A..E are column 0, already excluded by the
// pre-existing c > 0 term). The pre-NRL-162 max-only answer is ALREADY
// correct here - letting the %% lines' own indent shrink levelP (the first
// Fix round's mistake) breaks the pairing instead of improving it.
for (const marker of ["-", "+", "*", "1.", "1)", "- [x]", "- [ ]"]) {
	const src = `${marker} item\n     %%\nA\n  %%\nB\n %%\nC\n   %%\nD\nE`;
	const expected = marker.startsWith("1") ? "item C" : "item B D E";
	for (const skipCodeBlocks of [false, true]) {
		const spoken = extractChunks(src, { ...OPTS, skipCodeBlocks }).map(c => c.text).join(" ");
		check(`NRL-162 item-extent-multiple-pairs ${marker} code=${skipCodeBlocks}`, spoken === expected, spoken);
	}
}

console.log("a max-budgeted list dedent can over-dedent past a line's real indent, creating a false %% opener that pairs with a real closer (NRL-162, R-M08)");
{
	/**
	 * sourceIndex lockstep, the same house convention as `lockstepOk158`
	 * above: equal length to the text, and every non-space character maps to
	 * the same raw character at a monotonic, in-bounds offset.
	 */
	function lockstepOk162(src: string, chunks: SpeechChunk[]): boolean {
		for (const c of chunks) {
			if (c.sourceIndex.length !== c.text.length) return false;
			for (let i = 0; i < c.text.length; i++) {
				const at = c.sourceIndex[i]!;
				if (c.text[i] === " ") continue;
				if (at < 0 || at >= src.length) return false;
				if (src[at] !== c.text[i]) return false;
				if (i > 0 && at < c.sourceIndex[i - 1]!) return false;
			}
		}
		return true;
	}

	// PINS. Harness-measured against Obsidian 1.13.7's real parser and
	// renderer (oracle: `WT`/`GT` in ~/.local/share/note-reader-local/
	// obsidian-parser-harness, app.js sha256 8efbf581...9898). `listDedented`
	// budgeted a list item's dedent at module 5540's MAXIMUM content indent
	// (module 745's `M`) rather than the real `p` module 5540 actually uses -
	// the MINIMUM indent over the item's own non-blank lines. Over-dedenting
	// removes MORE lead than Obsidian does, which can turn a line Obsidian
	// keeps as literal prose into a FALSE block-start opener for us. The
	// ticket's own repro is both directions of that one false opener at
	// once: it pairs with a REAL later closer (the bare `%%`), so the note's
	// OWN unclosed tail (`ZT1Z`, which Obsidian hides because the real
	// opener's comment runs to end of note) is wrongly SPOKEN (disclosure),
	// and the text the false opener wrongly swallowed (`ZH3Z`/`ZH4Z`, which
	// Obsidian shows because that line never opens anything there) is wrongly
	// HIDDEN (prose loss). Every row is RED against the unfixed
	// max-only pass (`extract-base.cjs` bundled at this branch's base
	// 6f34e8d, before this ticket's edit).
	const pins: Array<[string, string, string]> = [
		["ticket-repro", "- item ZA0Z\n x ZM1Z\n      %% ZH1Z\nZH2Z\n     %% ZH3Z\nZH4Z\n%%\nZT1Z", "item ZA0Z x ZM1Z %% ZH1Z ZH2Z %% ZH3Z ZH4Z"],
		// A genuine prose shrink (` x`) COEXISTING with a %% pair, the shape
		// Ship's zero-shallow-line regression input does not cover: harness-
		// verified (`node ground_truth_nrl162c.cjs`) that the real renderer
		// shows SECRET and hides TAIL here, which needs the first %% (indent
		// 5) to fail open under the shrunk p=1 (residual 4) while the second
		// (indent 3) still opens with no closer (residual 2). The broken
		// Fix-round-1 attempt got this one right already (its %%-exclusion
		// bug only showed on items with no OTHER shrink candidate at all,
		// like Ship's own input above) - pinned here as the case that must
		// keep working once %% lines are excluded from shrink candidacy.
		["shallow-plus-percent-pair", "- item\n x\n     %%\nSECRET\n   %%\nTAIL", "item x %% SECRET"],
		// The reversed position: the shallow line sits BETWEEN the pair
		// rather than before it. Harness-verified the same way: SECRET shown,
		// `x` shown, TAIL hidden (the second %%, indent 3, opens with no
		// closer; the first, indent 5, still fails open under p=1).
		["shallow-between-percent-pair", "- item\n     %%\nSECRET\n x\n   %%\nTAIL", "item %% SECRET x"],
		// The same shrink under the two OTHER `itemHeadCols` paths - an ordered
		// marker's digit-plus-delimiter width and a task checkbox's extra
		// `[ ] ` - each with its own content-indent arithmetic that the real p
		// must be measured AFTER, not instead of.
		["ordered-marker-min", "1. item\n x\n     %%\nSECRET", "item x %% SECRET"],
		["task-marker-min", "- [ ] item\n x\n     %%\nSECRET", "item x %% SECRET"],
		// The item's real p still shrinks correctly when a LATER line is a
		// quote nested inside it - NRL-114's own quote-peel (which strips the
		// `>` before this pass ever sees the line) runs first, so the peeled
		// body is exactly what this pass records, matching NRL-114's existing
		// scope rather than widening it.
		["quote-in-list-min", "- item\n x\n  > Plain\n  >      %%\n  > SECRET", "item x Plain %% SECRET"],
		// `%%` and `<!--` mixed in one note: the fix closes the `%%`
		// disclosure (the false opener no longer reaches a real closer two
		// lines later) without disturbing the SEPARATE `<!--` predicate's own
		// answer for the construct that follows it (D-73-4; see the control
		// below for that predicate's own pre-existing, untouched residual).
		["mixed-constructs", "- item ZA0Z\n x ZM1Z\n     %% ZH1Z\nZH2Z\n%%\n     <!-- ZH3Z\nZH4Z\n--> ZT1Z", "item ZA0Z x ZM1Z %% ZH1Z ZH2Z"],
	];
	for (const [id, src, expected] of pins) {
		const chunks = extractChunks(src, OPTS);
		const spoken = chunks.map((c) => c.text).join(" ");
		check(`NRL-162 pin-${id}: visible output`, spoken === expected, spoken);
		check(`NRL-162 pin-${id}: sourceIndex lockstep`, lockstepOk162(src, chunks));
	}

	// GUARDS and CONTROLS, all measured against the real renderer and all
	// BYTE-IDENTICAL between the unfixed max-only pass and the fix - a
	// modest, freshly-built census over the mixed `%%`/`<!--` list shape the
	// ticket's own "Measured by the critique" section names, signed per cell
	// rather than combined into one number (AGENTS.md's own warning against
	// re-quoting a cited, non-enumerated corpus - here, the critique's
	// uncited 2,156,544-cell count - applies in full; this corpus is built
	// fresh and is the one actually run).
	const guards: Array<[string, string, string]> = [
		// THE COUNTER-EXAMPLE THAT DISQUALIFIED A SINGLE COLUMN SUBTRACTION
		// WHEN NRL-117 SHIPPED, re-run here because nested p-vs-max interaction
		// is exactly where that single-subtraction arm was shown to disclose:
		// module 745 nests, so the dedent runs once per level, and a smaller
		// real p at the OUTER level could in principle change what the INNER
		// level's own view (and so its own real p) sees. It does not move
		// here: outer's real p (2, unchanged - the marker lines for both
		// items already reach the max) leaves the inner level's own view
		// exactly as the max-only pass did, so this guard is unmoved.
		["nested-double-tab-correctly-hides", "- outer\n  - inner\n\t\t%%\nSECRET", "outer inner"],
		// The adversarial form of that same question: a one-space lazy line
		// at the OUTER level, so the outer's real p DOES shrink (2 -> 1,
		// confirmed by the pin above at one level of nesting), checked here
		// with a SECOND, nested level present. Unmoved in both directions:
		// the inner marker's own max still exceeds what the outer's shrunk p
		// leaves behind, so the final residual for the `%%` line is identical
		// to the max-only pass's on both sides of this corpus.
		["nested-min-outer-unmoved", "- outer\n x\n  - inner\n     %%\nSECRET", "outer x inner"],
		["nested-min-inner-unmoved", "- outer\n  - inner\n   x\n     %%\nSECRET", "outer inner x"],
		["three-level-min-mid-unmoved", "- outer\n  - mid\n   x\n    - inner\n            %%\nSECRET", "outer mid x inner %% SECRET"],
		// CONTROL: no shrink opportunity at all (every non-blank line's
		// indent is >= the max), so real p equals the max and the pass's
		// output cannot move - the refusal-only proof's own base case.
		["no-shrink-control", "- item\n   x\n     %%\nSECRET", "item x"],
		// CONTROL: `walkLeadItem`'s own exclusions for computing p. A blank
		// line (`line.trim() === ""`) and a ZERO-indent line (`c > 0` guards
		// the shrink) each contribute nothing to the minimum, matching
		// module 5540 exactly; both stay unmoved because nothing shrinks.
		["min-from-blank-excluded-control", "- item\n\n     %%\nSECRET", "item"],
		["min-from-zero-indent-excluded-control", "- item\nx\n     %%\nSECRET", "item x"],
		// CONTROL: the `<!--` twin. `opensHtmlBlock` reads a SEPARATE model
		// (NRL-115's `rendererLeads`) and is untouched by this ticket
		// (D-73-4); this shape is already wrong on the unfixed pass (it does
		// not yet match the renderer's own `item ZA0Z x ZM1Z <!-- ZH1Z ZH2Z
		// ZT1Z`), a PRE-EXISTING residual of that other predicate, and it
		// stays wrong in exactly the same way on the fix - 0 cells moved,
		// confirming the two predicates stayed structurally separate.
		// NRL-166 fix round 1 closed that residual from the comment side: the first
		// `<!--`'s body holds the second, so only the second is a comment, and the
		// output is now the renderer's own text.
		["html-twin-control", "- item ZA0Z\n x ZM1Z\n      <!-- ZH1Z\nZH2Z\n     <!-- ZH3Z\nZH4Z\n--> ZT1Z", "item ZA0Z x ZM1Z <!-- ZH1Z ZH2Z ZT1Z"],
	];
	for (const [id, src, expected] of guards) {
		const spoken = extractChunks(src, OPTS)
			.map((c) => c.text)
			.join(" ");
		check(`NRL-162 guard-${id}: unchanged`, spoken === expected, spoken);
	}

	// sourceIndex lockstep is non-vacuous: four mutators, each shown able to
	// FAIL the checker on the ticket's own repro's second chunk (a real,
	// non-trivial index spanning a dropped list marker and dropped `%%`
	// pairs), per the house convention (drop-one-entry/length,
	// shift-all-by-one/bounds+identity, swap-two-entries/monotonic+identity,
	// negate-one/monotonic+bounds).
	{
		const src = "- item ZA0Z\n x ZM1Z\n      %% ZH1Z\nZH2Z\n     %% ZH3Z\nZH4Z\n%%\nZT1Z";
		const chunks = extractChunks(src, OPTS);
		const c = chunks[1]!;
		const base = c.sourceIndex;
		const mutantOk = (mutated: readonly number[]): boolean => {
			const text = c.text;
			if (mutated.length !== text.length) return false;
			for (let i = 0; i < text.length; i++) {
				const at = mutated[i]!;
				if (text[i] === " ") continue;
				if (at < 0 || at >= src.length) return false;
				if (src[at] !== text[i]) return false;
				if (i > 0 && at < mutated[i - 1]!) return false;
			}
			return true;
		};
		let dropOneFails = 0;
		let shiftFails = 0;
		let swapFails = 0;
		let negateFails = 0;
		// drop-one-entry: wrong length, must fail.
		if (!mutantOk(base.slice(1))) dropOneFails += 1;
		// shift-all-by-one: every entry +1, may go out of bounds or break identity.
		if (!mutantOk(base.map((n) => n + 1))) shiftFails += 1;
		// swap-two-entries: breaks monotonicity (and usually identity too).
		if (base.length >= 2) {
			const swapped = base.slice();
			const tmp = swapped[0]!;
			swapped[0] = swapped[swapped.length - 1]!;
			swapped[swapped.length - 1] = tmp;
			if (!mutantOk(swapped)) swapFails += 1;
		}
		// negate-one: a single entry forced to -1, breaks monotonicity and
		// bounds. Picked on a non-space character past index 0, since the
		// checker deliberately skips spaces.
		if (base.length >= 2) {
			const text = c.text;
			let idx = -1;
			for (let i = 1; i < text.length; i++) {
				if (text[i] !== " ") {
					idx = i;
					break;
				}
			}
			if (idx !== -1) {
				const negated = base.slice();
				negated[idx] = -1;
				if (!mutantOk(negated)) negateFails += 1;
			}
		}
		check("NRL-162 sourceIndex checker is non-vacuous: drop-one-entry fails", dropOneFails > 0);
		check("NRL-162 sourceIndex checker is non-vacuous: shift-all-by-one fails", shiftFails > 0);
		check("NRL-162 sourceIndex checker is non-vacuous: swap-two-entries fails", swapFails > 0);
		check("NRL-162 sourceIndex checker is non-vacuous: negate-one fails", negateFails > 0);
		check("NRL-162 sourceIndex checker passes on the real (unmutated) output", mutantOk(base));
	}

	// Mechanism proof: the fix is the two-phase record-then-refold pass
	// described on `listDedented`'s own comment, not a one-line column
	// subtraction (which NRL-117 already measured as disclosing 7,168 cells
	// in the nested-tab shape above).
	const __filename162 = fileURLToPath(import.meta.url);
	const ROOT162 = path.resolve(path.dirname(__filename162), "../..");
	const SRC162 = fs.readFileSync(path.join(ROOT162, "src/text/extract.ts"), "utf8");
	check("NRL-162 levelP seeds at the max and only shrinks", SRC162.includes("if (residualHere < prevP) levelP.set(id, residualHere);"));
	check(
		"NRL-162 a %%-opener-shaped line is excluded from the shrink (Ship's multi-pair regression)",
		SRC162.includes('view.replace(/^[ \\t]+/, "").startsWith("%%")'),
	);
	check("NRL-162 fallback levels are excluded from the shrink", SRC162.includes("fallbackLevelIds.add(id);"));
	check(
		"NRL-162 Phase 2 replays each line's chain against the final levelP, not the max",
		SRC162.includes("for (const id of chainIds[k]!) view = view.slice(listDedentCut(view, levelP.get(id)!));"),
	);
}

console.log("");
if (failures > 0) {
	console.log(`${failures} FAILURE(S)`);
	process.exit(1);
}
console.log("all extract tests passed");
