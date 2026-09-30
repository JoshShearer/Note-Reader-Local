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
 * anyone to run is no guarantee.
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

const ADR_FILENAME = /^\d{4}-.+\.md$/;
const ADR_HEADING = /^#\s*0*(\d{4})\b/;
/**
 * Non-ADR `.md` files that are allowed to live in docs/adr/. Empty today,
 * measured: every `.md` there is an ADR. It exists so that adding a
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

const markdown = fs
	.readdirSync(ADR_DIR, { withFileTypes: true })
	.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
	.map((entry) => entry.name)
	.sort();

const adrs = markdown.filter((name) => ADR_FILENAME.test(name));
const others = markdown.filter((name) => !ADR_FILENAME.test(name));

console.log("ADR inventory");

// --- 1. Non-vacuity -------------------------------------------------------
// A wrong ROOT or an emptied directory must not make checks 2-4 pass by
// having nothing to check.
check(
	"docs/adr/ holds at least one NNNN-title.md file",
	adrs.length > 0,
	`0 files matched /^\\d{4}-.+\\.md$/ under ${ADR_DIR}; the checks below would pass vacuously`,
);

// --- 2. Every .md is an ADR or allowlisted --------------------------------
const unexpected = others.filter((name) => !NON_ADR_FILES.has(name));
check(
	"every .md in docs/adr/ is an ADR or allowlisted",
	unexpected.length === 0,
	unexpected
		.map(
			(name) =>
				`${name} does not match NNNN-title.md; if it is not an ADR, add it to NON_ADR_FILES`,
		)
		.join("; "),
);

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
