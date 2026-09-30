/**
 * The npm test suite count agrees with package.json (NRL-85).
 *
 * The suite count is written in prose at two places - AGENTS.md's `npm test`
 * gate line (a number plus a full name list) and srs.md's release-gate bullet -
 * and derived from a third, package.json's `pretest` and `test` scripts. Until
 * this file existed nothing read either prose site, so the three could disagree
 * with each other and with reality while every gate stayed green.
 *
 * That is not hypothetical. It drifted three times in one `/run-tickets` run
 * and a fourth was already queued in an open PR, every one of them a CLEAN
 * merge: two lanes that both add a suite bump the number from whatever their
 * own base said, and git sees either different files or different lines of the
 * same file, so there is nothing for it to conflict on. Each was caught by a
 * human re-deriving the count by hand. This test derives it instead.
 *
 * Why `pretest` is the registry and not the `test` script. `pretest` is the list
 * of TypeScript entry points handed to build-tests.mjs, so it is the one place
 * a suite must be named to be built at all. `test` no longer names any suite:
 * NRL-80 replaced its 24-deep `&&` chain, whose short-circuit let the first
 * failing suite hide every later one, with `node run-tests.mjs`. The runner
 * DERIVES its list from `pretest` rather than holding a second copy, because a
 * second copy is exactly the drift this file exists to catch.
 *
 * So checks 5 and 6 no longer parse the `test` script for suite paths - it
 * holds none, and looking for them would only ever reach the SKIP that used to
 * stand here. They import the runner's own pure `suitePathsFromPretest` and
 * assert what actually matters now: the runner derives the same suites as
 * `pretest`, in the same order, with no duplicate, every derived path shaped
 * `tests/.build/<name>.test.mjs`, and `scripts.test` invoking the runner at all.
 * That last one is a NAMED FAILURE rather than a skip: if `test` stops calling
 * run-tests.mjs, nothing else in the tree would notice.
 *
 * HOW A SKIPPED SUITE FAILS, the two doors, because one test cannot hold both.
 * A suite dropped from the DERIVATION makes check 5 red and describeList names
 * it. A suite dropped from the runner's EXECUTION LOOP with the derivation
 * intact is invisible here, because this file runs INSIDE that loop - so the
 * runner reconciles itself, recording one result per planned path and exiting
 * non-zero with `runner planned M suites and produced N results; not run: ...`
 * when they differ. That is the only place in the tree that can observe the
 * whole run.
 *
 * HONEST LIMIT, unchanged from the chain and not widened by it: replacing
 * `test` with a command that never invokes the runner at all (NRL-85 measured
 * `"test": "true"`) still cannot be caught from inside a suite that `test` is
 * what invokes. Check 5''' catches the specific shape of `test` still running
 * something else; it cannot catch `test` running nothing.
 *
 * Why tests/nrl-15-inline-worker.test.ts is allowlisted rather than counted. It
 * is registered under the separate `test:inline-worker` script, needs a real
 * production build first, and is deliberately outside `npm test`'s bare-Node
 * chain (AGENTS.md says so on its own line). It is on disk and not in `pretest`,
 * which on a healthy tree would otherwise make check 4 red forever. The
 * allowlist is explicit and holds exactly that one name, following
 * tests/adrNumbers.test.ts's three-class design: every tests/*.test.ts lands in
 * exactly one of registered, allowlisted, or a NAMED failure. There is no
 * fourth class that passes quietly.
 *
 * Two deliberate non-assertions:
 *   - No literal number is asserted anywhere. This test compares the sites with
 *     each other, never with a constant, or it becomes the next thing that
 *     drifts. It therefore counts itself without contradiction.
 *   - The anchors are matched tolerantly (whitespace, `suite`/`suites`), but a
 *     MISSING anchor is a loud named failure rather than a skip, following
 *     tests/adrNumbers.test.ts check 1. A tolerant regex that silently matches
 *     nothing is exactly the vacuous pass this file exists to prevent, so
 *     finding zero anchors, or more than one, both fail by name.
 *
 * Section 13 is about the runner rather than the registry, and lives here for
 * one reason: this file is where a check about run-tests.mjs can go without
 * adding a 25th suite, which would move all four count sites at once. It pins
 * NRL-80 F1 - that a failing run's last lines, `FAILING SUITES:` above all,
 * reach a reader that is slow to drain the pipe - and, just as hard, that the
 * exit code is still 1 on failure and 0 on success.
 *
 * The checks in section 8 are permanent mutation guards, not scaffolding. They
 * run the same parsers and the same comparators over synthetic strings and
 * assert that a wrong count, a dropped name, a reordered name list and a
 * missing anchor are each DETECTED. Without them a later tidy-up of a regex
 * could turn every live check above into a pass over zero matches, and the
 * suite would stay green while asserting nothing.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
// The runner's own derivation, not a copy of it. Importing the real function is
// the whole point: a reimplementation here could agree with `pretest` while the
// runner ran something else. run-tests.d.mts declares it; see that file for why
// the sidecar exists rather than a tsconfig change.
import { suitePathsFromPretest } from "../run-tests.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Bundled to tests/.build/suiteRegistry.test.mjs, so the repo root is two
// levels up, the same as tests/adrNumbers.test.ts and tests/release.test.ts.
const ROOT = path.resolve(__dirname, "../..");
const TESTS_DIR = path.join(ROOT, "tests");

/**
 * Suites on disk that are deliberately NOT in `pretest`. See the header: this
 * one is driven by `npm run test:inline-worker`, which builds the plugin first.
 */
const UNREGISTERED_SUITES = new Set<string>(["nrl-15-inline-worker"]);

let failures = 0;
let skipped = 0;
function check(name: string, cond: boolean, detail = ""): void {
	if (cond) console.log(`  ok   ${name}`);
	else {
		failures += 1;
		console.log(`  FAIL ${name} ${detail}`);
	}
}
// A skip never touches `failures` and never prints `ok`, so a bypassed check
// cannot be read as a passing one. Nothing in this file skips today - NRL-80
// replaced the two calls that did with hard checks - but the helper and the
// `skipped > 0` guard on the final line stay, so a future conditional check
// cannot be added without the bare all-passed line being suppressed for it.
function skip(name: string, reason: string): void {
	skipped += 1;
	console.log(`  SKIP ${name} (${reason})`);
}
void skip;

// --- Parsers ---------------------------------------------------------------
// Every parser takes a string and returns data. None of them touches the
// filesystem, which is what lets section 8 drive them with synthetic input
// without editing a tracked file.

/**
 * Suite names named as TypeScript entry points, in textual order.
 *
 * `?? ""` throughout this section is for `noUncheckedIndexedAccess` only. Every
 * group these patterns read is a required `+` group, so a match cannot leave it
 * unset and cannot yield an empty name.
 */
function parsePretest(script: string): string[] {
	return [...script.matchAll(/tests\/([A-Za-z0-9._-]+)\.test\.ts\b/g)].map(
		(m) => m[1] ?? "",
	);
}

/** Suite names named as built ESM bundles, in textual order. */
function parseTestChain(script: string): string[] {
	return [...script.matchAll(/tests\/\.build\/([A-Za-z0-9._-]+)\.test\.mjs\b/g)].map(
		(m) => m[1] ?? "",
	);
}

interface AgentsAnchor {
	readonly count: number;
	readonly names: string[];
}

/**
 * AGENTS.md's gate line: `npm test          # 23 suites: extract, engine, ...`.
 * Anchored at the line start so `npm run test:inline-worker # 1 suite (...)`
 * and every prose mention of `npm test` are not candidates.
 */
function parseAgentsAnchors(text: string): AgentsAnchor[] {
	const re = /^[ \t]*npm test\b[^#\n]*#[ \t]*(\d+)[ \t]+suites?:[ \t]*([^\n]+)$/gm;
	return [...text.matchAll(re)].map((m) => ({
		count: Number(m[1] ?? ""),
		names: (m[2] ?? "")
			.split(/\s*,\s*/)
			.map((n) => n.trim())
			.filter((n) => n.length > 0),
	}));
}

/** srs.md's release-gate bullet: ``- `npm test` (all 22 test suites must pass).`` */
function parseSrsAnchors(text: string): number[] {
	const re = /`npm test`[^\n]*?\b(\d+)[ \t]+test suites?\b/g;
	return [...text.matchAll(re)].map((m) => Number(m[1]));
}

// --- Comparators -----------------------------------------------------------
// Shared by the live checks and by the section 8 guards, so a guard failing
// means the live check would have failed too.

function listsEqual(a: readonly string[], b: readonly string[]): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** First divergent index plus the missing and extra sets, for a FAIL detail. */
function describeList(expected: readonly string[], actual: readonly string[]): string {
	let i = 0;
	while (i < expected.length && i < actual.length && expected[i] === actual[i]) i += 1;
	const missing = expected.filter((n) => !actual.includes(n));
	const extra = actual.filter((n) => !expected.includes(n));
	return [
		`first divergence at index ${i} (expected ${expected[i] ?? "<end>"}, found ${actual[i] ?? "<end>"})`,
		`missing [${missing.join(", ")}]`,
		`extra [${extra.join(", ")}]`,
		`lengths ${expected.length} vs ${actual.length}`,
	].join("; ");
}

function duplicates(names: readonly string[]): string[] {
	const seen = new Set<string>();
	const dupes = new Set<string>();
	for (const n of names) {
		if (seen.has(n)) dupes.add(n);
		seen.add(n);
	}
	return [...dupes];
}

// --- Inputs ----------------------------------------------------------------

const pkg = JSON.parse(
	fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
) as { scripts?: Record<string, string> };
const pretestScript = pkg.scripts?.pretest ?? "";
const testScript = pkg.scripts?.test ?? "";
const agentsText = fs.readFileSync(path.join(ROOT, "AGENTS.md"), "utf8");
const srsText = fs.readFileSync(path.join(ROOT, "srs.md"), "utf8");

const registry = parsePretest(pretestScript);

console.log("suite registry (package.json pretest)");

// --- 1. Non-vacuity --------------------------------------------------------
// A wrong ROOT, a renamed script or an emptied one must not make every check
// below pass by having nothing to compare against.
check(
	"package.json pretest registers at least one suite",
	registry.length > 0,
	`package.json scripts.pretest named 0 tests/<name>.test.ts paths (script is ${
		pkg.scripts?.pretest === undefined ? "absent" : `${pretestScript.length} chars`
	}); every check below would pass vacuously`,
);

// --- 2. No suite registered twice -----------------------------------------
{
	const dupes = duplicates(registry);
	check(
		`pretest names no suite twice (${registry.length} entries)`,
		dupes.length === 0,
		`duplicated: ${dupes.join(", ")}`,
	);
}

console.log("suite files on disk");

// --- 3 and 4. Disk classification, adrNumbers' three-class design ----------
const onDisk = fs
	.readdirSync(TESTS_DIR, { withFileTypes: true })
	.filter((e) => e.isFile() && /\.test\.ts$/i.test(e.name))
	.map((e) => e.name.replace(/\.test\.ts$/i, ""))
	.sort((a, b) => a.localeCompare(b));

// 3. Every registered suite is a file that exists. A typo in `pretest` breaks
// the build rather than this test, but a rename that updates only the script
// would otherwise be invisible here.
{
	const missing = registry.filter((n) => !onDisk.includes(n));
	check(
		`every pretest-registered suite exists as tests/<name>.test.ts (${registry.length} registered)`,
		missing.length === 0,
		`no file for: ${missing.join(", ")}`,
	);
}

// 4. Every file is registered or explicitly allowlisted. Not "every file that
// looks registered": a file this test cannot classify is a failure, because
// passing over it is how an unrun suite hides.
{
	const unclassified = onDisk.filter(
		(n) => !registry.includes(n) && !UNREGISTERED_SUITES.has(n),
	);
	if (unclassified.length === 0) {
		check(
			`every tests/*.test.ts is registered or allowlisted (${onDisk.length} files, ${UNREGISTERED_SUITES.size} allowlisted)`,
			true,
		);
	} else {
		for (const n of unclassified) {
			check(
				`tests/${n}.test.ts is on disk but not registered in pretest`,
				false,
				"add it to pretest and test, or to UNREGISTERED_SUITES with a reason",
			);
		}
	}
}

console.log("run-tests.mjs agrees with pretest");

// --- 5 and 6. The runner's derivation against the registry -----------------
// NRL-80 replaced the `&&` chain with `node run-tests.mjs`, so `test` names no
// suite at all and there is nothing in it left to compare. What is compared is
// the runner's own derivation, imported rather than reimplemented. See the
// header for the two doors a skipped suite can come in by, and for the one
// shape this cannot catch.
{
	const derived = suitePathsFromPretest(pretestScript);
	const derivedNames = derived.map((p) =>
		path.basename(p).replace(/\.test\.mjs$/, ""),
	);

	// 5'. Same count, same set, same textual order.
	check(
		`run-tests.mjs derives the same suites as pretest, in the same order (${derived.length} entries)`,
		listsEqual(registry, derivedNames),
		describeList(registry, derivedNames),
	);

	// 6'. No suite run twice. A duplicate would double-count its checks in the
	// runner's aggregate and make the skip arithmetic stop closing.
	{
		const dupes = duplicates(derivedNames);
		check(
			"run-tests.mjs derives no suite twice",
			dupes.length === 0,
			`duplicated: ${dupes.join(", ")}`,
		);
	}

	// 5''. Every derived path is literally a built bundle under tests/.build.
	// Driven through parseTestChain as well as a per-path shape test, so the
	// names round-trip: a derivation that emitted the right shape with the wrong
	// name would pass the shape half alone.
	{
		const badShape = derived.filter(
			(p, i) => p !== `tests/.build/${derivedNames[i] ?? ""}.test.mjs`,
		);
		const roundTrip = parseTestChain(derived.join(" "));
		check(
			"every run-tests.mjs path is tests/.build/<name>.test.mjs and round-trips to its name",
			badShape.length === 0 && listsEqual(registry, roundTrip),
			`bad shape [${badShape.join(", ")}]; round-trip ${describeList(registry, roundTrip)}`,
		);
	}

	// 5'''. `test` actually invokes the runner. A NAMED FAILURE and not a skip:
	// if this stops holding, nothing else in the tree notices, and every check
	// above becomes a statement about a file nobody runs. It cannot catch `test`
	// running NOTHING - see the header's honest limit.
	check(
		"package.json scripts.test invokes run-tests.mjs",
		/\brun-tests\.mjs\b/.test(testScript),
		`scripts.test is ${
			pkg.scripts?.test === undefined ? "absent" : JSON.stringify(testScript)
		}`,
	);
}

console.log("AGENTS.md gate line");

// --- 7, 8, 9. AGENTS.md ----------------------------------------------------
{
	const anchors = parseAgentsAnchors(agentsText);
	// Zero matches and two matches are both loud named failures. Zero is the
	// vacuous pass this file exists to prevent; two means a second site was
	// added later, which is the drift shape itself.
	const anchor = anchors.length === 1 ? anchors[0] : undefined;
	if (anchor === undefined) {
		check(
			"AGENTS.md holds exactly one npm test gate line",
			false,
			anchors.length === 0
				? 'AGENTS.md holds no "npm test ... # N suites: a, b, c" line; the count and name list checks cannot run'
				: `${anchors.length} lines matched, counts [${anchors.map((a) => a.count).join(", ")}]; disambiguate them or this test cannot say which is authoritative`,
		);
	} else {
		check("AGENTS.md holds exactly one npm test gate line", true);
		check(
			"AGENTS.md gate line suite count agrees with package.json",
			anchor.count === registry.length,
			`AGENTS.md says ${anchor.count}, package.json registers ${registry.length}`,
		);
		// A correct number beside a stale list is the exact shape the queued PR
		// in NRL-85's description ships, so the list is compared in full and in
		// pretest order, not by length.
		check(
			"AGENTS.md gate line name list matches pretest, in order",
			listsEqual(registry, anchor.names),
			describeList(registry, anchor.names),
		);
	}
}

console.log("srs.md release gate bullet");

// --- 10 and 11. srs.md -----------------------------------------------------
// This site carries a number only. No name list is asserted because none is
// written there, and none is being added.
{
	const anchors = parseSrsAnchors(srsText);
	const count = anchors.length === 1 ? anchors[0] : undefined;
	if (count === undefined) {
		check(
			"srs.md holds exactly one npm test gate bullet",
			false,
			anchors.length === 0
				? 'srs.md holds no "`npm test` (all N test suites must pass)" line; the count check cannot run'
				: `${anchors.length} lines matched, counts [${anchors.join(", ")}]`,
		);
	} else {
		check("srs.md holds exactly one npm test gate bullet", true);
		check(
			"srs.md gate line suite count agrees with package.json",
			count === registry.length,
			`srs.md says ${count}, package.json registers ${registry.length}`,
		);
	}
}

console.log("anti-vacuity mutation guards");

// --- 12. Permanent mutation guards ----------------------------------------
// Each drives the real parser and the real comparator over a synthetic string.
// They are what stops a regex tidy-up above turning the live checks into a pass
// over zero matches.
{
	const fakeRegistry = ["alpha", "beta", "gamma", "delta"];
	const goodAgents = [
		"# heading",
		"```bash",
		"npm test          # 4 suites: alpha, beta, gamma, delta",
		"npm run typecheck # tsc",
		"```",
	].join("\n");

	// G0. The positive control. Without it every guard below could pass because
	// the parser always returns nothing, which is the vacuity being guarded.
	{
		const a = parseAgentsAnchors(goodAgents);
		const only = a[0];
		check(
			"guard: a correct AGENTS-shaped line parses to one anchor that agrees",
			a.length === 1 &&
				only !== undefined &&
				only.count === fakeRegistry.length &&
				listsEqual(fakeRegistry, only.names),
			JSON.stringify(a),
		);
	}

	// G1. Wrong count, correct list.
	{
		const a = parseAgentsAnchors(
			goodAgents.replace("# 4 suites:", "# 5 suites:"),
		);
		const only = a[0];
		check(
			"guard: an AGENTS-shaped line with a wrong count is detected",
			a.length === 1 && only !== undefined && only.count !== fakeRegistry.length,
			JSON.stringify(a),
		);
	}

	// G2. Correct count, one name dropped - the shape a stale PR ships.
	{
		const a = parseAgentsAnchors(
			goodAgents.replace("alpha, beta, gamma, delta", "alpha, beta, delta"),
		);
		const only = a[0];
		check(
			"guard: an AGENTS-shaped line with a dropped name is detected",
			a.length === 1 && only !== undefined && !listsEqual(fakeRegistry, only.names),
			JSON.stringify(a),
		);
	}

	// G3. Same set, wrong order. Proves the list comparison is ordered, so a
	// later switch to a set comparison cannot pass this file.
	{
		const a = parseAgentsAnchors(
			goodAgents.replace("alpha, beta, gamma, delta", "alpha, gamma, beta, delta"),
		);
		const only = a[0];
		check(
			"guard: an AGENTS-shaped line with a reordered list is detected",
			a.length === 1 &&
				only !== undefined &&
				only.names.length === fakeRegistry.length &&
				!listsEqual(fakeRegistry, only.names),
			JSON.stringify(a),
		);
	}

	// G4. srs-shaped line, positive control then wrong number.
	{
		const good = parseSrsAnchors("- `npm test` (all 4 test suites must pass).");
		const bad = parseSrsAnchors("- `npm test` (all 9 test suites must pass).");
		check(
			"guard: an srs-shaped line parses, and a wrong number is detected",
			good.length === 1 &&
				good[0] === fakeRegistry.length &&
				bad.length === 1 &&
				bad[0] !== undefined &&
				bad[0] !== fakeRegistry.length,
			`good ${JSON.stringify(good)}, bad ${JSON.stringify(bad)}`,
		);
	}

	// G5. No anchor at all yields zero matches, which is what makes the
	// missing-anchor failures above reachable rather than decorative.
	{
		const text = "Some prose about npm test that is not a gate line.\n";
		check(
			"guard: text holding no anchor yields 0 matches for both prose parsers",
			parseAgentsAnchors(text).length === 0 && parseSrsAnchors(text).length === 0,
			`${parseAgentsAnchors(text).length} AGENTS, ${parseSrsAnchors(text).length} srs`,
		);
	}

	// G6. The script parsers, positive control then a dropped and a reordered
	// entry. The chain parser is driven with a deliberately un-`&&`-shaped
	// string, because NRL-80 may produce one.
	{
		const pre =
			"node build-tests.mjs tests/alpha.test.ts tests/beta.test.ts tests/gamma.test.ts tests/delta.test.ts";
		const good =
			"node tests/.build/alpha.test.mjs; node tests/.build/beta.test.mjs && node tests/.build/gamma.test.mjs\n  node tests/.build/delta.test.mjs";
		const dropped = good.replace(" && node tests/.build/gamma.test.mjs", "");
		const reordered =
			"node tests/.build/alpha.test.mjs node tests/.build/gamma.test.mjs node tests/.build/beta.test.mjs node tests/.build/delta.test.mjs";
		check(
			"guard: the script parsers agree on matching scripts regardless of separators",
			listsEqual(fakeRegistry, parsePretest(pre)) &&
				listsEqual(fakeRegistry, parseTestChain(good)),
			`${JSON.stringify(parsePretest(pre))} vs ${JSON.stringify(parseTestChain(good))}`,
		);
		check(
			"guard: a test chain missing a suite, or holding one out of order, is detected",
			!listsEqual(fakeRegistry, parseTestChain(dropped)) &&
				!listsEqual(fakeRegistry, parseTestChain(reordered)),
			`${JSON.stringify(parseTestChain(dropped))}, ${JSON.stringify(parseTestChain(reordered))}`,
		);
		check(
			"guard: a script naming no suite paths parses to 0, so check 5'' cannot pass vacuously",
			parseTestChain("node --test tests/.build/").length === 0,
			JSON.stringify(parseTestChain("node --test tests/.build/")),
		);
	}

	// G7. The runner's REAL suitePathsFromPretest, over synthetic pretest
	// strings. These are what stop check 5' passing because the derivation
	// always returns the same thing the registry parser returns - both are
	// driven here from inputs neither of them can have agreed on in advance.
	{
		const pre =
			"node build-tests.mjs tests/alpha.test.ts tests/beta.test.ts tests/gamma.test.ts tests/delta.test.ts";
		const expected = fakeRegistry.map((n) => `tests/.build/${n}.test.mjs`);

		// G7a. Positive control. Without it G7b and G7c could both pass because
		// the derivation returns nothing for every input.
		{
			const got = suitePathsFromPretest(pre);
			check(
				"guard: the runner derives the right built paths from a correct pretest",
				listsEqual(expected, got),
				describeList(expected, got),
			);
		}

		// G7b. A suite dropped from pretest is a different derivation - door one
		// of the two in the header.
		{
			const got = suitePathsFromPretest(pre.replace(" tests/gamma.test.ts", ""));
			check(
				"guard: the runner dropping a suite from its derivation is detected",
				!listsEqual(expected, got) && got.length === fakeRegistry.length - 1,
				JSON.stringify(got),
			);
		}

		// G7c. Same set, wrong order. Proves check 5' is ordered, so a later
		// switch to a set comparison cannot pass this file.
		{
			const got = suitePathsFromPretest(
				"node build-tests.mjs tests/alpha.test.ts tests/gamma.test.ts tests/beta.test.ts tests/delta.test.ts",
			);
			check(
				"guard: the runner reordering its derivation is detected",
				!listsEqual(expected, got) &&
					got.length === expected.length &&
					expected.every((p) => got.includes(p)),
				JSON.stringify(got),
			);
		}

		// G7d. An empty pretest derives nothing. This is what makes check 5'
		// non-vacuous from the other side: if both parsers returned [] for the
		// real script, 5' would compare [] with [] and pass.
		{
			check(
				"guard: an empty pretest derives 0 suites, so check 5' cannot pass over two empty lists",
				suitePathsFromPretest("").length === 0 && parsePretest("").length === 0,
				`${suitePathsFromPretest("").length} derived, ${parsePretest("").length} registered`,
			);
		}
	}
}

console.log("run-tests.mjs flushes its output under a stalled reader");

// --- 13. The failure path must not lose its last lines (NRL-80 F1) ---------
// `process.exit()` tears the process down without flushing writes that are
// still queued in userspace, and stdout to a PIPE is asynchronous, so a reader
// that is slow to drain loses whatever had not reached the OS pipe buffer yet.
// That is every CI log viewer, every `| tee`, every `| head`. Measured on the
// real 24-suite run with one failure injected: a file redirect delivered 5,097
// lines, and `node run-tests.mjs 2>&1 | { sleep 25; cat; }` delivered 915 and
// LOST the `FAILING SUITES:` line - the one line this whole file exists to put
// at the end of a failing log.
//
// Driven against a COPY of the real run-tests.mjs in a temp sandbox with a
// synthetic package.json, not against the live tree: this suite runs INSIDE
// run-tests.mjs, so spawning the real one here would recurse through all 24
// suites, itself included.
//
// The failure sandbox names suites whose build outputs do not exist, so the
// runner takes its named-failure branch without spawning a single child. It is
// fast and it has no dependency on any suite's real behaviour.
//
// THE PASS CASE IS THE POSITIVE CONTROL AND IS NOT DECORATION. The success
// path has no `process.exit` and never did, so it must survive the identical
// stall. Without it, a harness that simply could not carry a large payload
// would make the failure-path checks pass for the wrong reason, and the fix
// would be unfalsifiable. Both payloads are comfortably over the 64 KiB pipe
// buffer, which is what makes the stall bite at all.
{
	const STALL_SECONDS = 1;
	// ~230 KB of runner output, ~3.5x the 64 KiB pipe buffer.
	const MISSING_SUITES = 1200;
	// ~840 KB from one synthetic suite, ~13x the buffer.
	const PASS_LINES = 12000;

	interface RunnerRun {
		readonly out: string;
		readonly code: number;
		readonly error: string;
	}

	function makeSandbox(kind: "fail" | "pass"): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nrl80-flush-"));
		fs.copyFileSync(path.join(ROOT, "run-tests.mjs"), path.join(dir, "run-tests.mjs"));
		fs.mkdirSync(path.join(dir, "tests", ".build"), { recursive: true });
		let names: string[];
		if (kind === "fail") {
			names = Array.from({ length: MISSING_SUITES }, (_, i) => `tests/s${i}.test.ts`);
		} else {
			names = ["tests/s0.test.ts"];
			const body = Array.from(
				{ length: PASS_LINES },
				(_, i) => `console.log("  ok   synthetic check ${i}, padded so the payload clears the pipe buffer");`,
			).join("\n");
			fs.writeFileSync(path.join(dir, "tests", ".build", "s0.test.mjs"), `${body}\n`);
		}
		fs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({ scripts: { pretest: `node build-tests.mjs ${names.join(" ")}` } }),
		);
		return dir;
	}

	/**
	 * Run the sandboxed runner with its stdout on a pipe whose reader sleeps
	 * `stallSeconds` before draining. `sleep 0` is the unstalled baseline, run
	 * through the identical shell so the two differ in the stall and nothing
	 * else.
	 *
	 * The runner's own exit code goes to a file rather than out of the shell:
	 * a pipeline's status is its LAST command's, and `pipefail` is not portable
	 * to every /bin/sh.
	 */
	function runStalled(dir: string, stallSeconds: number): RunnerRun {
		const codeFile = path.join(dir, "code.txt");
		fs.rmSync(codeFile, { force: true });
		const script =
			`{ "${process.execPath}" run-tests.mjs 2>&1; echo $? > code.txt; } | ` +
			`{ sleep ${stallSeconds}; cat; }`;
		const r = spawnSync("/bin/sh", ["-c", script], {
			cwd: dir,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
		});
		if (r.error !== undefined && r.error !== null) {
			return { out: "", code: Number.NaN, error: String(r.error) };
		}
		let code = Number.NaN;
		try {
			code = Number(fs.readFileSync(codeFile, "utf8").trim());
		} catch (e) {
			return { out: r.stdout ?? "", code: Number.NaN, error: `no exit code recorded: ${String(e)}` };
		}
		return { out: r.stdout ?? "", code, error: "" };
	}

	function tailOf(out: string): string {
		const lines = out.trimEnd().split("\n");
		return lines[lines.length - 1] ?? "";
	}

	// --- 13a-13d. The failure path.
	{
		const dir = makeSandbox("fail");
		try {
			const base = runStalled(dir, 0);
			const stalled = runStalled(dir, STALL_SECONDS);

			// 13a. Non-vacuity: the baseline must actually be large enough for the
			// stall to mean anything, and must carry the line under test.
			check(
				"run-tests.mjs failure output clears the pipe buffer and ends in FAILING SUITES",
				base.error === "" &&
					base.out.length > 64 * 1024 &&
					/\nFAILING SUITES: /.test(base.out),
				`error ${JSON.stringify(base.error)}, ${base.out.length} bytes, tail ${JSON.stringify(tailOf(base.out))}`,
			);

			// 13b. THE DEFECT. Pre-fix this is red: the tail is lost.
			check(
				`the FAILING SUITES line survives a ${STALL_SECONDS}s stalled reader`,
				/\nFAILING SUITES: /.test(stalled.out),
				`stalled delivered ${stalled.out.length} of ${base.out.length} bytes (${
					stalled.out.split("\n").length
				} of ${base.out.split("\n").length} lines); last line ${JSON.stringify(tailOf(stalled.out))}`,
			);

			// 13c. Nothing else is lost either. Byte-identical, so this cannot be
			// satisfied by flushing the summary and dropping the middle.
			check(
				"a stalled reader receives byte-identical output to an unstalled one",
				stalled.out === base.out,
				`${stalled.out.length} bytes stalled vs ${base.out.length} unstalled`,
			);

			// 13d. THE CONTRACT. A fix that flushes but loses the non-zero exit
			// would be worse than the bug: CI would go green on a failing run.
			check(
				"a failing run still exits 1, stalled and unstalled",
				base.code === 1 && stalled.code === 1,
				`unstalled ${base.code}, stalled ${stalled.code}`,
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}

	// --- 13e-13f. The pass path, positive control.
	{
		const dir = makeSandbox("pass");
		try {
			const base = runStalled(dir, 0);
			const stalled = runStalled(dir, STALL_SECONDS);

			// 13e. The harness itself carries a payload of this size through a
			// stalled pipe without loss. This is what makes 13b attributable to
			// `process.exit` rather than to the test.
			check(
				"positive control: the success path survives the same stall intact",
				base.error === "" &&
					stalled.error === "" &&
					base.out.length > 64 * 1024 &&
					stalled.out === base.out &&
					/all 1 suites passed/.test(stalled.out),
				`unstalled ${base.out.length} bytes, stalled ${stalled.out.length} bytes, tail ${JSON.stringify(tailOf(stalled.out))}`,
			);

			// 13f. And exits 0, stalled and unstalled.
			check(
				"a passing run still exits 0, stalled and unstalled",
				base.code === 0 && stalled.code === 0,
				`unstalled ${base.code}, stalled ${stalled.code}`,
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}

	// --- 13g. Source guard, for the exits this harness cannot drive.
	// run-tests.mjs has two other `process.exit(1)` sites - an empty `pretest`
	// and the planned-vs-produced reconciliation - and both write their reason
	// to the console immediately before exiting, so both carry the identical
	// hazard. Driving them would need a third and fourth sandbox for two lines
	// of output each, which a stalled pipe would deliver anyway; asserting the
	// call is simply absent covers them and any site added later.
	{
		const runnerSrc = fs.readFileSync(path.join(ROOT, "run-tests.mjs"), "utf8");
		const codeOnly = runnerSrc
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/(^|[^:])\/\/[^\n]*/g, "$1");
		const calls = [...codeOnly.matchAll(/\bprocess\.exit\s*\(/g)];
		check(
			"run-tests.mjs calls process.exit() nowhere; it sets process.exitCode instead",
			calls.length === 0,
			`${calls.length} call(s) remain; process.exit does not flush a pending async stdout write`,
		);
		// Non-vacuity for 13g: the same scan finds a call when one is there.
		check(
			"guard: the process.exit scan detects a call, so 13g cannot pass over a broken regex",
			[...'if (x) process.exit(1);'.matchAll(/\bprocess\.exit\s*\(/g)].length === 1 &&
				[...'// process.exit(1)\n'.replace(/(^|[^:])\/\/[^\n]*/g, "$1").matchAll(/\bprocess\.exit\s*\(/g)].length === 0,
			"the scan or the comment-stripper is not doing what 13g assumes",
		);
	}
}

console.log("");
if (skipped > 0) console.log(`${skipped} SKIPPED`);
if (failures > 0) {
	console.log(`${failures} FAILURE(S)`);
	process.exit(1);
}
// The bare line must never print when anything was skipped: a reader grepping
// for it would otherwise take a partial run for a full one.
console.log(
	skipped > 0
		? `all suite registry tests passed (${skipped} skipped)`
		: "all suite registry tests passed",
);
