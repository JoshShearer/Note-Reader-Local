import { extractChunks } from "../src/text/extract.ts";

const OPTS = {
	stripTags: true,
	speakUrls: false,
	skipCodeBlocks: true,
	skipInlineCode: true,
	skipTables: true,
	skipHeadings: false,
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

console.log("images are dropped entirely");
{
	const src = "Before ![alt text](img.png) after.";
	const chunks = extractChunks(src, OPTS);
	const spoken = chunks.map((c) => c.text).join(" ");
	check("no alt text", !spoken.includes("alt text"), `got: ${spoken}`);
	check("no image path", !spoken.includes("img.png"), `got: ${spoken}`);
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
	const embedSpoken = spokenOf(embed);
	check("![[Note]] is dropped cleanly", embedSpoken === "Before after the embed.", `got: ${JSON.stringify(embedSpoken)}`);
	check("![[Note]] leaves no stray bracket or target", !embedSpoken.includes("]") && !embedSpoken.includes("Some Note"), `got: ${JSON.stringify(embedSpoken)}`);

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

console.log("");
if (failures > 0) {
	console.log(`${failures} FAILURE(S)`);
	process.exit(1);
}
console.log("all extract tests passed");
