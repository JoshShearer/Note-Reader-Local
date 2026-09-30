import { extractChunks } from "../src/text/extract.ts";
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
	add("Line one\nline two\n===\nBody.", ["Line one line two", "Body."]);
	add("Line one\nline two\n===\nBody.", ["Body."], HEAD_OFF, " (skipHeadings)");
	add("Intro.\n\nMy Title\n===   \nBody.", ["Intro.", "My Title", "Body."]);
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
	 * after `inComment` is assigned, so a title carrying an unclosed `<!--`
	 * still opens the comment that hides the rest of the note. Dropping the line
	 * earlier would make text the author hid audible.
	 */
	expect('[a]: x.png "<!--"\n\nZSECRETZ sentence here.', []);
	expect('[a]: x.png "<!--"\n\nZSECRETZ sentence here.\n\n-->\n\nZAFTERZ here.', ["ZAFTERZ here."]);

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
		["obsidian-inside-html-block", "Before <!--\n%%\n```\n$$\n--> after.\nVisible.", "Before after. Visible."],
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
		// "first" is still spoken, and that is NRL-64 (N1), not a defect in this
		// fix: the literal region covers continuation lines and the closing line
		// only. cleanLine runs on the OPENING line before codeSpanClosesLater has
		// confirmed the span, so at that moment `\`first` is an unmatched run, and
		// an unmatched run is literal text in CommonMark - silencing its tail
		// without the confirmation would delete visible prose from any line that
		// simply contains a stray backtick. Confirming before cleaning is the
		// per-line-loop restructure NRL-64 owns.
		["pin-skipped-code", "Before `first\n%%literal%%\nlast` after.", "Before first after.", { skipInlineCode: true }],
		["span-skipped-markdown-silenced", "Before `first\n**bold** #tag <https://x.com>\nlast` after.", "Before first after.", { skipInlineCode: true }],
		["span-skipped-escape-silenced", "Before `first\n\\%%kept\\%%\nlast` after.", "Before first after.", { skipInlineCode: true }],
		// Two lines: no wholly-silenced middle line, so this is the shape that
		// shows the closing line's region silenced on its own.
		["span-skipped-two-line", "Before `first\nlast` after.", "Before first after.", { skipInlineCode: true }],
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
		["span-skipped-mismatched-run", "Before ``a\nb ` c\nd`` after.", "Before a after.", { skipInlineCode: true }],
		// The tail after the carried closer is ordinary markdown again: the region
		// ends at the closer, it does not spill into the rest of the line.
		["span-tail-after-closer-is-markdown", "Before `first\nmid` **bold** after.", "Before first mid bold after.", { skipInlineCode: false }],
		// Out of scope, pinned so the ticket that owns each one changes it on
		// purpose rather than by accident - exactly as NRL-42 pinned this ticket.
		// N1, NRL-64: on the span's OPENING line a complete %%...%% after the
		// unmatched run is still dropped. cleanLine runs on the opening line
		// before codeSpanClosesLater has confirmed the span, so fixing it means
		// confirming before cleaning, which is a restructure of the per-line loop.
		["pin-nrl64-opening-line", "Before `a %%b%% c\nd` after.", "Before a c d after.", { skipInlineCode: false }],
		// F9, NRL-63: an image whose alt text crosses a soft line break is not
		// recognised as an image at all, so its destination is spoken as prose.
		["pin-nrl63-softwrapped-image", "A ![alt\nwords](zdestz.png) B", "A [alt words](zdestz.png) B", { skipInlineCode: false }],
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
	 * NRL-46 pin, a PRE-EXISTING defect this ticket did NOT fix.
	 *
	 * A target ending in a backslash immediately before the closer means the
	 * line holds `\]]`. inlineContainerClose never finds a `]]`, so the whole
	 * `[[` is treated as unterminated, the brackets are dropped, and the target
	 * is then read as ordinary prose - through the escape branch, which eats the
	 * backslashes and speaks the folder segment and one literal `]`. The
	 * final-segment reduction never runs, because the wikilink branch never
	 * fires. Measured byte-identical on the merge base 789d3c2 and on this
	 * working tree by bundling both extractors, so it is not merge drift and it
	 * is out of this ticket's scope; pinned so it can only change deliberately.
	 */
	for (const src of ["Before [[pinfolder\\Leaf Note\\]] after.", "Before ![[pinfolder\\Leaf Note\\]] after."]) {
		for (const speakEmbeds of [false, true]) {
			const got = say(src, { speakEmbeds });
			check(
				`NRL-46 pin-unterminated-by-escape ${JSON.stringify(src)} (speakEmbeds ${speakEmbeds})`,
				got === "Before pinfolderLeaf Note]] after.",
				`got: ${JSON.stringify(got)}`,
			);
		}
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

console.log("");
if (failures > 0) {
	console.log(`${failures} FAILURE(S)`);
	process.exit(1);
}
console.log("all extract tests passed");
