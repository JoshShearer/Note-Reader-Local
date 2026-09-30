/**
 * ADR number uniqueness and heading agreement (NRL-70).
 *
 * ADR numbers are allocated as "the next free number when the branch is cut".
 * With several worktrees running at once, two lanes routinely pick the same
 * number, and git cannot tell: the filenames differ
 * (`0014-cjk-word-granularity.md` vs `0014-final-path-segment-as-a-link-label.md`),
 * so the merge is reported CLEAN and `main` ends up holding two ADR 0014s. That
 * happened three times in one run, all inside NRL-46, and was caught only
 * because a verify phase happened to list `docs/adr/` on both sides by hand.
 *
 * Second check, same ticket: NRL-46's eventual renumber to 0017 had to edit the
 * document's own H1 by hand. Nothing would have caught a filename that said one
 * number while the heading said another, which is a worse state than a
 * duplicate because every citation elsewhere resolves to a file that disagrees
 * with itself.
 *
 * What this test CANNOT do, stated plainly because it is the accepted limit and
 * not an oversight: it reads the working tree only, so it cannot see a number
 * already claimed by an unmerged branch. It fires at rebase or PR time, when
 * renumbering is still cheap, rather than at the moment of allocation. No
 * allocator script was written (NRL-70 decision 1); a helper nothing forces
 * anyone to run is no guarantee. It also does not descend into a subdirectory
 * of docs/adr/, so a duplicate parked in docs/adr/drafts/ is not compared
 * against the flat ones; whether to recurse is a separate open question, and
 * until it is answered a subdirectory is reported as unclassifiable rather than
 * skipped, so the choice cannot be made silently by creating one.
 *
 * Discovery is deliberately case-insensitive on the extension and deliberately
 * exhaustive over the directory. `0017-rival.MD` is a real duplicate of ADR
 * 0017's number on every filesystem this repo is cloned on, and an earlier
 * version of this file matched `.md` case-sensitively, so that file was not an
 * ADR candidate, not an unexpected file, and not counted: the suite printed
 * "all ADR numbering tests passed" and exited 0 with the duplicate sitting in
 * the tree. Every entry now lands in exactly one of three classes - ADR,
 * allowlisted, or a named FAIL - so there is no fourth class that passes
 * quietly.
 *
 * Two deliberate non-assertions:
 *   - Contiguity is NOT asserted. `main` legitimately held 0001-0014 and
 *     0016-0019 while an unmerged lane held 0015, so a no-gap check would have
 *     been red on a healthy tree.
 *   - No exact file count is asserted, for the same reason: concurrent lanes add
 *     ADRs, and a hardcoded total would go red on every one of them.
 *
 * The heading regex is deliberately tolerant. 19 of the 20 ADRs present when
 * this was written use `# NNNN. Title`, but 0015 alone uses
 * `# 0015 - speech-dispatcher voice attribution ...` (a hyphen, no period), so
 * a strict `^# (\d{4})\.` would be red on a clean tree.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Bundled to tests/.build/adrNumbers.test.mjs, so the repo root is two levels
// up, the same as tests/release.test.ts.
const ROOT = path.resolve(__dirname, "../..");
const ADR_DIR = path.join(ROOT, "docs/adr");

/**
 * The extension is matched case-insensitively; the rest is not relaxed. A name
 * that is not `NNNN-something` is not parsed as an ADR at all - it becomes a
 * named failure instead, which is the loud outcome a genuinely non-ADR file
 * should get.
 */
const ADR_FILENAME = /^\d{4}-.+\.md$/i;
const ADR_HEADING = /^#\s*0*(\d{4})\b/;
/**
 * Entries that are allowed to live in docs/adr/ without being ADRs. Empty
 * today, measured: every file there is an ADR. It exists so that adding a
 * docs/adr/README.md is a one-line change rather than a mystery failure.
 */
const NON_ADR_FILES = new Set<string>([]);

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
	if (cond) console.log(`  ok   ${name}`);
	else {
		failures += 1;
		console.log(`  FAIL ${name} ${detail}`);
	}
}

// Every entry, not only the ones ending in a lowercase ".md". Filtering here is
// what made an uppercase extension invisible, so the classification happens
// below where an entry that fits no class produces a failure.
const entries = fs
	.readdirSync(ADR_DIR, { withFileTypes: true })
	.sort((a, b) => a.name.localeCompare(b.name));

const adrs: string[] = [];
/** One line per entry that is neither an ADR nor allowlisted, naming the file. */
const unclassified: string[] = [];

for (const entry of entries) {
	const name = entry.name;
	if (entry.isFile() && ADR_FILENAME.test(name)) {
		adrs.push(name);
		continue;
	}
	if (entry.isFile() && NON_ADR_FILES.has(name)) continue;
	if (entry.isDirectory()) {
		unclassified.push(
			`${name}/ is a directory; this test does not recurse, so any ADR inside it is unchecked`,
		);
		continue;
	}
	unclassified.push(
		`${name} does not match NNNN-title.md (extension case-insensitive); if it is not an ADR, add it to NON_ADR_FILES`,
	);
}

console.log("ADR inventory");

// --- 1. Non-vacuity -------------------------------------------------------
// A wrong ROOT or an emptied directory must not make checks 2-4 pass by
// having nothing to check.
check(
	"docs/adr/ holds at least one NNNN-title.md file",
	adrs.length > 0,
	`0 files matched /^\\d{4}-.+\\.md$/ under ${ADR_DIR}; the checks below would pass vacuously`,
);

// --- 2. Every entry is an ADR or allowlisted ------------------------------
// Not "every .md": an entry this test cannot classify is a failure, because the
// alternative is passing over it, and passing over it is how a duplicate hides.
if (unclassified.length === 0) {
	check(
		`every entry in docs/adr/ is an ADR or allowlisted (${entries.length} entries)`,
		true,
	);
} else {
	for (const detail of unclassified) {
		check("docs/adr/ holds an entry this test cannot classify", false, detail);
	}
}

// --- 3. Uniqueness, the ticket's first criterion --------------------------
console.log("ADR number uniqueness");

const byNumber = new Map<string, string[]>();
for (const name of adrs) {
	const num = name.slice(0, 4);
	const existing = byNumber.get(num);
	if (existing === undefined) byNumber.set(num, [name]);
	else existing.push(name);
}

const collisions = [...byNumber.entries()]
	.filter(([, files]) => files.length > 1)
	.sort(([a], [b]) => a.localeCompare(b));

if (collisions.length === 0) {
	check(
		`every ADR number is used by exactly one file (${byNumber.size} numbers over ${adrs.length} files)`,
		true,
	);
} else {
	// One failure per colliding number, naming every offending filename, so the
	// output says which two documents to look at rather than only that
	// something is wrong.
	for (const [num, files] of collisions) {
		check(
			`ADR number ${num} is used by ${files.length} files`,
			false,
			files.join(", "),
		);
	}
}

// --- 4. Filename number vs the document's own H1 --------------------------
console.log("ADR heading agreement");

for (const name of adrs) {
	const expected = name.slice(0, 4);
	const lines = fs.readFileSync(path.join(ADR_DIR, name), "utf8").split("\n");
	const h1 = lines.find((line) => /^#\s/.test(line));
	const label = `${name} heading number matches its filename`;

	if (h1 === undefined) {
		check(label, false, "no H1 heading line found");
		continue;
	}

	const match = ADR_HEADING.exec(h1);
	const found = match?.[1];
	if (found === undefined) {
		check(label, false, `H1 "${h1.trim()}" has no NNNN number; expected ${expected}`);
		continue;
	}

	check(label, found === expected, `filename says ${expected}, heading says ${found}`);
}

if (failures > 0) {
	console.log(`${failures} FAILURE(S)`);
	process.exit(1);
}
console.log("all ADR numbering tests passed");
