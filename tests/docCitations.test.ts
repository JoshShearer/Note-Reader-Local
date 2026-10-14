/**
 * Every `pin-*` / `guard-*` fixture name cited in a document of record resolves
 * to a fixture under tests/ (NRL-150).
 *
 * This repo's method for not re-breaking a fixed shape is the named pin, and a
 * later ticket reads an ADR, sees "pinned as `pin-x`" and believes the shape is
 * covered. ADR 0035 and srs.md cited two such names that had never existed in
 * tests/ (before NRL-150 added this file, `git log -S` found nothing for them on
 * any ref; this file's own synthetic literals now match it, so read that claim
 * as "outside tests/docCitations.test.ts"): a citation to a pin that does
 * not exist is worse than none, because it stops the next ticket building its
 * own tripwire. NRL-131's fixtures were labelled TRIPWIRE and later renamed or
 * folded by NRL-115 and NRL-118, and the prose kept the name it first invented.
 * This suite is the mechanical gate for the class, with the same shape as
 * tests/adrNumbers.test.ts and tests/suiteRegistry.test.ts: assert a claim made
 * in prose against the tree.
 *
 * HONEST LIMITS, stated rather than hidden:
 *   - It is only as good as EXTRACT_NAME. A regex that matches nothing would
 *     pass every doc, so section 1 asserts the extractor finds a known-present
 *     name in a synthetic string AND in the real tree, and section 2 asserts
 *     that a deliberately bogus cited name FAILS the resolver. Without them a
 *     tidy-up of the regex could turn this file into a pass over zero matches.
 *   - "Resolves" means the cited name is a whole-token occurrence in some
 *     tests/**.ts file (a fixture id, a label, or a comment naming it), or is a
 *     FAMILY STEM: a cited `pin-nrl120` or `pin-nrl115-*` resolves when some
 *     token in tests/ starts with `<name>-`. The stem rule is deliberately
 *     lenient because ADRs cite families that way. It is not satisfied by a
 *     name that merely shares a prefix without a hyphen boundary.
 *   - A token in a comment counts, so this proves the name is findable, not
 *     that the fixture asserts what the prose says. That is a review question.
 *   - Names built at run time (`pin-${id}`) are invisible to a literal search,
 *     so a document must cite a name a reader can grep for.
 *   - It does not check that a name is cited next to the right ticket.
 *
 * Scope: docs/**.md, srs.md, AGENTS.md, CONTEXT.md and README.md. Section 5
 * (NRL-152) also asserts that no `srs.md` line-number citation survives in
 * src/, tests/ or those documents: a line number goes stale the next time srs.md
 * gains a paragraph, a requirement ID plus heading does not.
 *
 * A name hard-wrapped at a hyphen across a line break is joined before
 * extraction (NRL-152). Without that, the extractor stopped at the break and the
 * truncated head resolved as a family stem, so a wrong tail passed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Bundled to tests/.build/docCitations.test.mjs, so the repo root is two
// levels up, the same as tests/adrNumbers.test.ts.
const ROOT = path.resolve(__dirname, "../..");

/**
 * A fixture name: `pin-` or `guard-`, then hyphen-joined lowercase words. The
 * lookbehind stops a match starting mid-word (`skip-pin-x`, `-pin-x`); the
 * lookahead refuses to stop inside a word. A trailing hyphen from a glob such
 * as `pin-nrl115-unmasked-*` is not part of the name, which is what makes the
 * family-stem rule below apply.
 */
const EXTRACT_NAME = /(?<![\w-])(?:pin|guard)-[a-z0-9]+(?:-[a-z0-9]+)*(?![\w])/gi;

/**
 * Cited names that are deliberately allowed to stay unresolved, keyed by the
 * file that cites them. Each entry is scoped to an exact occurrence count AND to
 * the record paragraph: every occurrence must sit in a paragraph containing
 * `recordMarker`, so a later citation of the same dead name as a live pin ("Pinned
 * as `<name>`" elsewhere in the file) fails instead of riding the allowance.
 * Section 4 fails if an entry no longer matches, so the list cannot rot into a
 * blanket pass. Empty entries are not accepted.
 */
interface Allowance {
	file: string;
	name: string;
	reason: string;
	/** Exact number of times the name occurs in the file. */
	count: number;
	/** Text every paragraph holding the name must contain. */
	recordMarker: string;
}
const NRL150_RECORD = "never appeared in `tests/`";
const NRL150_REASON =
	"NRL-150 records here that this name was invented and never written; the ADR must be able to say so by name.";
const ALLOWED_UNRESOLVED: Allowance[] = [
	{
		file: "docs/adr/0035-peeling-a-quote-nested-in-a-list-item.md",
		name: "pin-nrl131-nested-tab-comment-overhides",
		reason: NRL150_REASON,
		count: 1,
		recordMarker: NRL150_RECORD,
	},
	{
		file: "docs/adr/0035-peeling-a-quote-nested-in-a-list-item.md",
		name: "pin-nrl131-nested-percent-note-scope",
		reason: NRL150_REASON,
		count: 1,
		recordMarker: NRL150_RECORD,
	},
];

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
	if (cond) console.log(`  ok   ${name}`);
	else {
		failures += 1;
		console.log(`  FAIL ${name} ${detail}`);
	}
}

// --- Helpers (pure over strings, so section 2 can drive them synthetically) --

/**
 * Re-join a name that a hard wrap split after a hyphen. Only text that is
 * already inside a `pin-`/`guard-` name is joined, so ordinary prose that ends a
 * line in a hyphen is left alone. Repeated until stable for a name wrapped twice.
 */
const WRAPPED_NAME = /((?<![\w-])(?:pin|guard)-[a-z0-9]+(?:-[a-z0-9]+)*-)[ \t]*\r?\n[ \t]*(?=[a-z0-9])/gi;
function joinWrappedNames(text: string): string {
	let prev = text;
	for (;;) {
		const next = prev.replace(WRAPPED_NAME, "$1");
		if (next === prev) return next;
		prev = next;
	}
}

function extractNames(text: string): string[] {
	return [...joinWrappedNames(text).matchAll(EXTRACT_NAME)].map((m) => m[0]);
}

/** Does `name` resolve against the set of tokens found under tests/? */
function resolves(name: string, testTokens: ReadonlySet<string>): boolean {
	if (testTokens.has(name)) return true;
	for (const t of testTokens) if (t.startsWith(`${name}-`)) return true;
	return false;
}

/**
 * Does the allowance still describe `text` exactly: the name occurs `count`
 * times, and each occurrence is inside a paragraph that carries the record
 * marker? Pure over a string so section 4 can mutate the real document.
 */
function allowanceHolds(text: string, a: Allowance): boolean {
	const joined = joinWrappedNames(text);
	const paragraphs = joined.split(/\n[ \t]*\n/);
	let seen = 0;
	for (const para of paragraphs) {
		const here = extractNames(para).filter((n) => n === a.name).length;
		if (here === 0) continue;
		if (!para.replace(/\s+/g, " ").includes(a.recordMarker)) return false;
		seen += here;
	}
	return seen === a.count;
}

function walk(dir: string, skip: ReadonlySet<string>): string[] {
	const out: string[] = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (skip.has(e.name)) continue;
		const p = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...walk(p, skip));
		else if (e.isFile()) out.push(p);
	}
	return out;
}

function readText(p: string): string {
	return fs.readFileSync(p, "utf8");
}

const SKIP_DIRS = new Set(["node_modules", ".build", ".git"]);
const rel = (p: string): string => path.relative(ROOT, p).split(path.sep).join("/");

const docFiles = [
	...walk(path.join(ROOT, "docs"), SKIP_DIRS).filter((f) => /\.md$/i.test(f)),
	...["srs.md", "AGENTS.md", "CONTEXT.md", "README.md"]
		.map((f) => path.join(ROOT, f))
		.filter((f) => fs.existsSync(f)),
];
// This file is excluded: it spells bogus and missing names as synthetic inputs,
// and scanning it would let those literals resolve themselves.
const SELF = path.join(ROOT, "tests", "docCitations.test.ts");
const testFiles = walk(path.join(ROOT, "tests"), SKIP_DIRS).filter(
	(f) => /\.(ts|mts|mjs)$/.test(f) && f !== SELF,
);

const testTokens = new Set<string>();
for (const f of testFiles) for (const n of extractNames(readText(f))) testTokens.add(n);

/** file (repo-relative) -> distinct cited names. */
const cited = new Map<string, Set<string>>();
for (const f of docFiles) cited.set(rel(f), new Set(extractNames(readText(f))));

// --- 1. Non-vacuity: the extractor finds a known-present name ---------------
console.log("extractor is not vacuous");
const KNOWN = "guard-nrl118-lazy-line-closes-in-nested-quote";
check(
	"extractNames finds a known name in a synthetic string",
	extractNames(`prose \`${KNOWN}\`, and \`pin-x-y\`.`).join("|") === `${KNOWN}|pin-x-y`,
);
check("extractNames does not match mid-word (skip-pin-x)", extractNames("skip-pin-x and a-guard-y").length === 0);
check(
	"extractNames drops a glob's trailing hyphen",
	extractNames("`pin-nrl115-unmasked-*`").join("|") === "pin-nrl115-unmasked",
);
check("tests/ was scanned and yielded names", testFiles.length > 0 && testTokens.size > 0, `files ${testFiles.length}`);
check(`the real tests/ tree holds ${KNOWN}`, testTokens.has(KNOWN));
check("docs/ and srs.md were scanned", docFiles.some((f) => rel(f) === "srs.md") && docFiles.some((f) => rel(f).startsWith("docs/adr/")));
check(
	"the real docs cite a known-present name (ADR 0035 cites it)",
	cited.get("docs/adr/0035-peeling-a-quote-nested-in-a-list-item.md")?.has(KNOWN) === true,
);

// --- 2. Mutation guard: a bogus cited name fails the resolver ----------------
console.log("resolver rejects what it should");
check("resolves() accepts a present name", resolves(KNOWN, testTokens));
check(
	"resolves() REJECTS a bogus name",
	!resolves("pin-nrl150-this-name-does-not-exist-anywhere", testTokens),
);
check(
	"resolves() REJECTS the two names NRL-150 found missing",
	!resolves("pin-nrl131-nested-tab-comment-overhides", testTokens) &&
		!resolves("pin-nrl131-nested-percent-note-scope", testTokens),
);
check(
	"family stem resolves, a bare shared prefix does not",
	resolves("pin-nrl118-per-item-opener", testTokens) && !resolves("pin-nrl118-per-item-open", testTokens),
);
const WRAPPED_REAL = "pin-nrl117-shallower-than-content-indent-still-silenced";
const wrappedSet = new Set([WRAPPED_REAL]);
check(
	"a name hard-wrapped at a hyphen is joined before extraction",
	extractNames("see `pin-nrl117-shallower-than-content-\n   indent-still-silenced`.").join("|") === WRAPPED_REAL,
);
check(
	"a correctly wrapped real name resolves",
	extractNames("see `pin-nrl117-shallower-than-content-\nindent-still-silenced`").every((n) => resolves(n, wrappedSet)),
);
check(
	"a wrapped name with a bogus tail FAILS (it used to pass as a stem)",
	extractNames("see `pin-nrl117-shallower-than-content-\n   indent-bogus-tail`").every((n) => !resolves(n, wrappedSet)),
);
check(
	"prose ending a line in a hyphen is not joined into a name",
	extractNames("a well-\nknown fact, and pin-x-y\nnext").join("|") === "pin-x-y",
);
check(
	"a synthetic dead citation is reported unresolved",
	extractNames("see `pin-zz-dead-name`").every((n) => !resolves(n, new Set([KNOWN]))),
);

// --- 3. The real check: every cited name resolves ---------------------------
console.log("cited names resolve under tests/");
const allowed = (file: string, name: string): boolean =>
	ALLOWED_UNRESOLVED.some(
		(a) => a.file === file && a.name === name && allowanceHolds(readText(path.join(ROOT, file)), a),
	);
let totalCited = 0;
for (const [file, names] of cited) {
	for (const name of names) {
		totalCited += 1;
		if (resolves(name, testTokens) || allowed(file, name)) continue;
		check(`${file} cites ${name}`, false, "- no fixture, label or comment under tests/ names it");
	}
}
check("at least one citation was checked", totalCited > 0);
if (failures === 0) console.log(`  ok   every cited name resolves or is allowlisted (${totalCited} citation sites)`);

// --- 4. The allowlist cannot rot --------------------------------------------
console.log("allowlist entries are live and justified");
for (const a of ALLOWED_UNRESOLVED) {
	check(`allowlist reason present: ${a.name}`, a.reason.trim().length > 0);
	check(`allowlist entry is still cited in ${a.file}: ${a.name}`, cited.get(a.file)?.has(a.name) === true);
	check(`allowlist entry is still unresolved (else drop it): ${a.name}`, !resolves(a.name, testTokens));
	const real = readText(path.join(ROOT, a.file));
	check(`allowlist entry matches its exact count and record paragraph: ${a.name}`, allowanceHolds(real, a));
	// Mutation: a second, live-sounding citation of the dead name must NOT ride the allowance.
	check(
		`a second "Pinned as" citation of ${a.name} fails the allowance`,
		!allowanceHolds(`${real}\n\nPinned as \`${a.name}\`.\n`, a),
	);
	check(
		`a second citation inside the record paragraph still fails the count: ${a.name}`,
		!allowanceHolds(real.replace(a.recordMarker, `${a.recordMarker} \`${a.name}\``), a),
	);
	// Mutation: the allowed occurrences moved out of the record paragraph (count unchanged)
	// must fail, which is what the paragraph scoping in allowanceHolds() is for.
	const moved = `${real.split(a.name).join("(name removed)")}${`\n\nPinned as \`${a.name}\`.\n`.repeat(a.count)}`;
	check(
		`the allowed count moved out of the record paragraph fails: ${a.name}`,
		extractNames(moved).filter((n) => n === a.name).length === a.count && !allowanceHolds(moved, a),
	);
}

// --- 5. No srs.md line-number citation survives (NRL-152) -------------------
console.log("no srs.md line-number citations");
// `srs.md:` followed by a digit, with an optional backtick or space. A requirement
// ID plus heading, a function name or a quoted sentence is the durable anchor.
const SRS_LINE_CITATION = /srs\.md[`*]?:\s?\d/g;
const srsScan = [
	...walk(path.join(ROOT, "src"), SKIP_DIRS).filter((f) => /\.(ts|mts|mjs|js)$/.test(f)),
	...testFiles,
	...docFiles,
].filter((f) => f !== SELF && fs.existsSync(f));
const srsOffenders: string[] = [];
for (const f of new Set(srsScan)) {
	const n = (readText(f).match(SRS_LINE_CITATION) ?? []).length;
	if (n > 0) srsOffenders.push(`${rel(f)} (${n})`);
}
check(
	"the detector matches a synthetic line-number citation",
	("see `srs.md:250` and (srs.md:1197-1207)".match(SRS_LINE_CITATION) ?? []).length === 2,
);
check(
	"the detector ignores an anchored citation",
	!new RegExp(SRS_LINE_CITATION.source).test("(srs.md, R-M02 Linux Support)"),
);
check("src/ was scanned", srsScan.some((f) => rel(f).startsWith("src/")));
check("src/, tests/ and the documents hold no srs.md line-number citation", srsOffenders.length === 0, srsOffenders.join(", "));

if (failures > 0) {
	console.log(`\n${failures} doc citation check(s) FAILED`);
	process.exitCode = 1;
} else {
	console.log("\nall doc citation tests passed");
}
