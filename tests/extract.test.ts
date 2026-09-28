import { extractChunks } from "../src/text/extract.ts";

const OPTS = {
	stripTags: true,
	skipUrls: true,
	skipCode: true,
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

console.log("skipTables (not skipCode) governs whether table rows are dropped");
{
	const src = ["Before table.", "| a | b |", "| - | - |", "After table."].join("\n");

	const tablesSkipped = extractChunks(src, { ...OPTS, skipCode: false, skipTables: true });
	check(
		"table dropped when skipTables is true, regardless of skipCode",
		!tablesSkipped.some((c) => c.text.includes("|")),
	);

	const tablesKept = extractChunks(src, { ...OPTS, skipCode: true, skipTables: false });
	check(
		"table kept when skipTables is false, regardless of skipCode",
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

	// NRL-8 owns callouts; a single bracket must still take the old path.
	const callout = spokenOf("[!note] Callout body text here.");
	check("single-bracket [!note] path unchanged", callout === "!note Callout body text here.", `got: ${JSON.stringify(callout)}`);

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
		"[!note] Callout body text here.", "Line one [[A|b]] and\n![[img.png]] then [[C#D]] end.", ...Object.keys(headings)];
	for (const src of fixtures) {
		check(`sourceIndex lockstep for ${JSON.stringify(src)}`, lockstep(src));
	}
}

console.log("");
if (failures > 0) {
	console.log(`${failures} FAILURE(S)`);
	process.exit(1);
}
console.log("all extract tests passed");
