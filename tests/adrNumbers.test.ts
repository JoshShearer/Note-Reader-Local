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
import * as os from "node:os";
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
/**
 * NRL-81 fix: the old `/^#\s*0*(\d{4})\b/` stripped leading zeros before
 * capturing, so a typo'd 5-digit heading like "# 00022." backtracked `0*` to
 * consume one zero and captured "0022" - a false PASS on a genuinely wrong
 * heading number. The negative lookahead requires the digit run to be exactly
 * 4 long (no 5th trailing digit) with no zero-stripping, and still matches
 * 0015's hyphenated form (`# 0015 - ...`, no period) because the lookahead
 * only rejects a trailing digit, not a trailing hyphen.
 */
const ADR_HEADING = /^#\s*(\d{4})(?!\d)/;
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

/** Wraps the (now-fixed) ADR_HEADING regex, extracted so both the real scan
 * and the NRL-81 edge-case checks below run the exact same code path rather
 * than a duplicated reimplementation that could drift from it. */
function extractHeadingNumber(line: string): string | undefined {
	return ADR_HEADING.exec(line)?.[1];
}

/**
 * NRL-81 fix: the old `lines.find((line) => /^#\s/.test(line))` had no fence
 * awareness, so a number-bearing heading-like line lexically inside a ```
 * code block could be picked as "the" H1 - masking a genuinely mismatched
 * real heading behind it, or fabricating a mismatch against a real heading
 * that was actually fine. This toggles fence state and only considers lines
 * outside a fence.
 */
function findFirstHeading(lines: string[]): string | undefined {
	let inFence = false;
	for (const line of lines) {
		if (/^```/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		if (/^#\s/.test(line)) return line;
	}
	return undefined;
}

/**
 * Duck-typed on the three Dirent methods actually used, so a plain object
 * literal can stand in for a real Dirent in a unit-style check without
 * touching the filesystem - except for Finding 3, whose whole point is that
 * isSymbolicLink() is an OS/filesystem fact a fake cannot itself verify.
 */
interface ClassifiableEntry {
	name: string;
	isFile(): boolean;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
}

/**
 * NRL-81 fix: a symlink named NNNN-title.md correctly fails both isFile()
 * and isDirectory() (readdirSync withFileTypes does not follow links), but
 * used to fall through to the generic "does not match NNNN-title.md"
 * message - true of the string, false of the reason. isSymbolicLink() names
 * the real cause instead, ahead of the catch-all.
 */
function classifyEntry(entry: ClassifiableEntry): {
	adr: boolean;
	unclassifiedDetail?: string;
} {
	const name = entry.name;
	if (entry.isFile() && ADR_FILENAME.test(name)) {
		return { adr: true };
	}
	if (entry.isFile() && NON_ADR_FILES.has(name)) {
		return { adr: false };
	}
	if (entry.isDirectory()) {
		return {
			adr: false,
			unclassifiedDetail: `${name}/ is a directory; this test does not recurse, so any ADR inside it is unchecked`,
		};
	}
	if (entry.isSymbolicLink()) {
		return {
			adr: false,
			unclassifiedDetail: `${name} is a symlink, not a regular file; ADRs must be plain files (readdirSync does not follow links)`,
		};
	}
	return {
		adr: false,
		unclassifiedDetail: `${name} does not match NNNN-title.md (extension case-insensitive); if it is not an ADR, add it to NON_ADR_FILES`,
	};
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
	const result = classifyEntry(entry);
	if (result.adr) {
		adrs.push(entry.name);
	} else if (result.unclassifiedDetail !== undefined) {
		unclassified.push(result.unclassifiedDetail);
	}
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
	const h1 = findFirstHeading(lines);
	const label = `${name} heading number matches its filename`;

	if (h1 === undefined) {
		check(label, false, "no H1 heading line found");
		continue;
	}

	const found = extractHeadingNumber(h1);
	if (found === undefined) {
		check(label, false, `H1 "${h1.trim()}" has no NNNN number; expected ${expected}`);
		continue;
	}

	check(label, found === expected, `filename says ${expected}, heading says ${found}`);
}

// --- 5. Heading parser edge cases (NRL-70 leftovers, NRL-81) ---------------
// Three independent edge cases in the parser above, each with a defect
// reproduction against the OLD logic (transcribed inline, never touching the
// real docs/adr/ directory) followed by the NEW logic's correct behaviour.
console.log("ADR heading parser edge cases (NRL-81)");

// Finding 1: a 5-digit H1 used to pass as its 4-digit prefix.
{
	const OLD_ADR_HEADING = /^#\s*0*(\d{4})\b/;
	const fiveDigit = "# 00022. Five digit heading";
	check(
		"OLD regex wrongly captured a 5-digit heading as a 4-digit number (defect reproduction)",
		OLD_ADR_HEADING.exec(fiveDigit)?.[1] === "0022",
		`OLD.exec(${JSON.stringify(fiveDigit)}) -> ${JSON.stringify(OLD_ADR_HEADING.exec(fiveDigit)?.[1])}`,
	);
	check(
		"NEW regex rejects a 5-digit heading (no match, falls into the no-number branch)",
		extractHeadingNumber(fiveDigit) === undefined,
		`NEW.exec -> ${JSON.stringify(extractHeadingNumber(fiveDigit))}`,
	);
}
check(
	"NEW regex still matches 0015's hyphenated heading (guard: must not regress the one real hyphenated ADR)",
	extractHeadingNumber("# 0015 - speech-dispatcher voice attribution via a verified ...") === "0015",
);
check(
	"NEW regex still matches an ordinary 'NNNN.' heading (guard)",
	extractHeadingNumber("# 0022. Normal heading") === "0022",
);

// Finding 2: the H1 finder had no fence awareness, so a heading-like line
// inside a ``` block could mask a real mismatch, or fabricate one.
{
	function OLD_findFirstHeadingFenceUnaware(lines: string[]): string | undefined {
		return lines.find((line) => /^#\s/.test(line));
	}

	// Direction A: fence masks a genuine mismatch. File named 0022-fence.md,
	// but the real (non-fenced) H1 four lines down says 0099.
	const fenceMasksMismatch = [
		"```",
		"# 0022 example number inside a fence, must be skipped",
		"```",
		"",
		"# 0099. This is the real, wrong heading number",
		"Body.",
	];
	const oldFoundA = OLD_findFirstHeadingFenceUnaware(fenceMasksMismatch);
	check(
		"OLD finder picked the fenced line, hiding a genuine mismatch (defect reproduction, file would be 0022-fence.md)",
		oldFoundA !== undefined && extractHeadingNumber(oldFoundA) === "0022",
		`OLD found ${JSON.stringify(oldFoundA)}`,
	);
	const newFoundA = findFirstHeading(fenceMasksMismatch);
	check(
		"NEW finder skips the fence and surfaces the real, mismatched heading",
		newFoundA !== undefined && extractHeadingNumber(newFoundA) === "0099",
		`NEW found ${JSON.stringify(newFoundA)}`,
	);

	// Direction B (complementary, per this repo's two-direction measurement
	// convention): a fence holding a WRONG number must not produce a false
	// mismatch against a real heading that is actually correct.
	const fenceHoldsWrongNumberOnly = [
		"```",
		"# 0099 wrong number, inside a fence, must be skipped",
		"```",
		"",
		"# 0022. Correct real heading",
		"Body.",
	];
	const oldFoundB = OLD_findFirstHeadingFenceUnaware(fenceHoldsWrongNumberOnly);
	check(
		"OLD finder wrongly reported a mismatch sourced from a fenced line (defect reproduction, file would be 0022-*.md)",
		oldFoundB !== undefined && extractHeadingNumber(oldFoundB) === "0099",
		`OLD found ${JSON.stringify(oldFoundB)}`,
	);
	const newFoundB = findFirstHeading(fenceHoldsWrongNumberOnly);
	check(
		"NEW finder skips the fence and correctly matches the real heading (no false mismatch)",
		newFoundB !== undefined && extractHeadingNumber(newFoundB) === "0022",
		`NEW found ${JSON.stringify(newFoundB)}`,
	);
}

// Finding 3: a symlinked NNNN-title.md wrongly reported a filename PATTERN
// mismatch instead of naming the real cause. isSymbolicLink() is an OS fact,
// so this fixture needs a real filesystem entry rather than a fake - built in
// a scratch mkdtemp directory (mirroring tests/suiteRegistry.test.ts's
// makeSandbox), self-cleaned via try/finally, never touching docs/adr/.
{
	const symlinkScratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "nrl81-symlink-"));
	try {
		fs.writeFileSync(path.join(symlinkScratchDir, "target.md"), "# 0022. Real target\n");
		fs.symlinkSync(
			path.join(symlinkScratchDir, "target.md"),
			path.join(symlinkScratchDir, "0022-link.md"),
		);
		const scratchEntries = fs.readdirSync(symlinkScratchDir, { withFileTypes: true });
		const linkEntry = scratchEntries.find((e) => e.name === "0022-link.md");

		check(
			"a symlinked NNNN-title.md is a real Dirent: not isFile(), not isDirectory(), is isSymbolicLink()",
			linkEntry !== undefined &&
				linkEntry.isFile() === false &&
				linkEntry.isDirectory() === false &&
				linkEntry.isSymbolicLink() === true,
			linkEntry === undefined
				? "symlink entry not found in scratch dir"
				: `isFile=${linkEntry.isFile()} isDirectory=${linkEntry.isDirectory()} isSymbolicLink=${linkEntry.isSymbolicLink()}`,
		);

		if (linkEntry !== undefined) {
			// Transcribed OLD classification body (no isSymbolicLink branch),
			// run against this SAME real Dirent - not a fake standing in for one.
			function OLD_classify(entry: fs.Dirent): string {
				const name = entry.name;
				if (entry.isFile() && ADR_FILENAME.test(name)) return "adr";
				if (entry.isFile() && NON_ADR_FILES.has(name)) return "allowlisted";
				if (entry.isDirectory()) {
					return `${name}/ is a directory; this test does not recurse, so any ADR inside it is unchecked`;
				}
				return `${name} does not match NNNN-title.md (extension case-insensitive); if it is not an ADR, add it to NON_ADR_FILES`;
			}
			const oldMessage = OLD_classify(linkEntry);
			check(
				"OLD classification wrongly claimed a filename pattern mismatch for a symlink (defect reproduction)",
				oldMessage.includes("does not match NNNN-title.md"),
				`OLD message: ${oldMessage}`,
			);

			const result = classifyEntry(linkEntry);
			check(
				"NEW classification names the real cause: a symlink, not a regular file",
				result.adr === false &&
					result.unclassifiedDetail?.includes("symlink") === true &&
					result.unclassifiedDetail?.includes("not a regular file") === true,
				`NEW message: ${result.unclassifiedDetail}`,
			);
		}
	} finally {
		fs.rmSync(symlinkScratchDir, { recursive: true, force: true });
	}
}

// Re-run the fixed heading parser against every real ADR heading, read-only,
// pinned at test-run time against the live tree rather than only against a
// one-off session transcript. `adrs` and the findFirstHeading/
// extractHeadingNumber calls above already exercise this per file; this is
// the aggregate zero-regressions assertion the fix claims.
{
	let corpusFails = 0;
	for (const name of adrs) {
		const expected = name.slice(0, 4);
		const lines = fs.readFileSync(path.join(ADR_DIR, name), "utf8").split("\n");
		const h1 = findFirstHeading(lines);
		const found = h1 !== undefined ? extractHeadingNumber(h1) : undefined;
		if (found !== expected) corpusFails += 1;
	}
	check(
		`the fixed heading parser agrees with every real ADR filename, zero regressions (${adrs.length} files)`,
		corpusFails === 0,
		`${corpusFails} of ${adrs.length} disagreed`,
	);
}

if (failures > 0) {
	console.log(`${failures} FAILURE(S)`);
	process.exit(1);
}
console.log("all ADR numbering tests passed");
