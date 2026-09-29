import { extractChunks } from "../src/text/extract.ts";

// Mirrors DEFAULT_SETTINGS, so a fixture written without overrides asserts what
// a user with untouched settings actually hears.
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
		cChunks.every((k) => [...k.text].every((ch, i) => ch === " " || c[k.sourceIndex[i]!] === ch)),
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
				[...k.text].every((ch, i) => ch === " " || src[k.sourceIndex[i]!] === ch),
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
				[...k.text].every((ch, i) => ch === " " || src[k.sourceIndex[i]!] === ch),
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
				[...k.text].every((ch, i) => {
					if (ch === " " || src[k.sourceIndex[i]!] === ch) return true;
					const at = k.text.lastIndexOf("equation", i);
					return at !== -1 && i < at + 8 && src[k.sourceIndex[i]!] === "$";
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
				[...k.text].every((ch, i) => ch === " " || src[k.sourceIndex[i]!] === ch),
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

console.log("angle-bracket autolinks (NRL-39)");
{
	const urlsOn = { ...OPTS, speakUrls: true };
	const spokenWith = (src: string, opts: typeof OPTS): string =>
		extractChunks(src, opts).map((c) => c.text).join(" ");
	const lockstepWith = (src: string, opts: typeof OPTS): boolean =>
		extractChunks(src, opts).every(
			(k) =>
				k.sourceIndex.length === k.text.length &&
				[...k.text].every((ch, i) => ch === " " || src[k.sourceIndex[i]!] === ch),
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
		// Out of scope (see the ticket): a soft-wrapped span is not silenced by
		// skipInlineCode. Pinned so its own ticket changes it deliberately.
		["pin-skipped-code", "Before `first\n%%literal%%\nlast` after.", "Before first last after.", { skipInlineCode: true }],
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
}

console.log("configurable content exclusions (NRL-21, R-M09/R-M13)");
{
	type Key = keyof typeof OPTS;
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
	check("NRL-21 sweep really ran every combination", sweepRuns === corpus.length * (1 << keys.length) && sweepRuns === 16 * 512, String(sweepRuns));
}

console.log("");
if (failures > 0) {
	console.log(`${failures} FAILURE(S)`);
	process.exit(1);
}
console.log("all extract tests passed");
