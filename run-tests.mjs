/**
 * Run every built test suite and report all of them (NRL-80).
 *
 * `npm test` used to be a 24-deep `&&` chain. `&&` short-circuits, so one
 * failing suite suppressed every suite after it: a run that reported one
 * failure might have been hiding twenty-three, and the log gave a reader no way
 * to tell which. Measured before this file existed, with a `process.exit(1)`
 * appended to the built extract suite (1 of 24) and a `throw` appended to the
 * built loadingNotice suite (23 of 24): the chain exited 1 after ONE suite, the
 * log held one FAIL line and ZERO mentions of the late crash.
 *
 * NOT `process.exit()`, ANYWHERE IN THIS FILE, AND THAT IS LOAD-BEARING (NRL-80
 * F1). stdout to a PIPE is asynchronous, and `process.exit` tears the process
 * down without flushing what is still queued in userspace - so exactly the log
 * a CI viewer, a `| tee` or a `| head` sees loses its tail, which here is the
 * `FAILING SUITES:` line this file exists to print. Measured on the real
 * 24-suite run with one failure injected: a file redirect delivered 5,097
 * lines, and `node run-tests.mjs 2>&1 | { sleep 25; cat; }` delivered 915 and
 * lost that line; with `process.exitCode = 1` plus `return` the same stalled
 * pipe delivers all 5,097. The exit code is unchanged - 1 on failure, 0 on
 * success - and tests/suiteRegistry.test.ts section 13 pins both halves,
 * because a flush that dropped the non-zero status would be far worse than the
 * truncation it fixed.
 *
 * The suites are independent - each is a standalone built `.mjs` that exits 0 or
 * 1 - so nothing about the design required the short-circuit.
 *
 * THE SUITE LIST IS NOT WRITTEN HERE. `package.json`'s `pretest` is the one
 * registry: it is the list of TypeScript entry points handed to build-tests.mjs,
 * so a suite must be named there to be built at all. `suitePathsFromPretest`
 * derives the built paths from it with the same regex tests/suiteRegistry.test.ts
 * uses, and that test imports this function and asserts the two agree. A second
 * copy of the list in `test` is exactly the drift NRL-85 exists to catch.
 *
 * Serial, one child at a time, deliberately. tests/engine.test.ts shells out to
 * the real `spd-say` binary, speaks aloud through the daemon and asserts
 * wall-clock duration; running it beside anything else would make it flaky and
 * would interleave two suites' audio.
 *
 * THE MAIN GUARD IS NOT THE USUAL IDIOM, AND THAT IS LOAD-BEARING. The common
 * `import.meta.url === pathToFileURL(process.argv[1]).href` test FIRES INSIDE
 * THE ESBUILD BUNDLE: build-tests.mjs inlines this file into
 * tests/.build/suiteRegistry.test.mjs, `import.meta.url` becomes that bundle's
 * URL and `process.argv[1]` is that same bundle, so the runner would re-enter
 * itself from every test that imports it - measured in a scratch probe, which
 * printed the runner's own banner from inside the test. The basename test below
 * was measured silent in the bundle and live under `node run-tests.mjs`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Built suite paths, in `pretest`'s textual order.
 *
 * Pure: takes the script text, touches no filesystem. That is what lets
 * tests/suiteRegistry.test.ts drive it over synthetic strings, so its guards
 * cannot pass by the parser always returning nothing.
 *
 * The regex is character-for-character the one in that test's `parsePretest`.
 * `?? ""` is for noUncheckedIndexedAccess only - group 1 is a required `+`
 * group, so a match cannot leave it unset.
 */
export function suitePathsFromPretest(script) {
	return [...script.matchAll(/tests\/([A-Za-z0-9._-]+)\.test\.ts\b/g)].map(
		(m) => `tests/.build/${m[1] ?? ""}.test.mjs`,
	);
}

/** `tests/.build/extract.test.mjs` -> `extract`, for the summary. */
function suiteName(builtPath) {
	return path.basename(builtPath).replace(/\.test\.mjs$/, "");
}

/**
 * Per-suite check counts.
 *
 * Anchored at the line start on purpose. tests/suiteRegistry.test.ts prints
 * `  ok   guard: a test chain naming no suite paths parses to 0, reaching the
 * SKIP`, which an unanchored /SKIP/ would count as a skipped check on top of the
 * `ok` it already is.
 */
function countChecks(output) {
	let ok = 0;
	let skipped = 0;
	let failed = 0;
	for (const line of output.split("\n")) {
		if (/^\s*ok\b/.test(line)) ok += 1;
		else if (/^\s*SKIP\b/.test(line)) skipped += 1;
		else if (/^\s*FAIL\b/.test(line)) failed += 1;
	}
	return { ok, skipped, failed };
}

function runSuite(builtPath) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [builtPath], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		// Streamed as it arrives AND captured: CI keeps the whole verbatim log,
		// and the summary still gets the last lines of a crash that self-reports
		// nothing.
		child.stdout.on("data", (b) => {
			output += b.toString();
			process.stdout.write(b);
		});
		child.stderr.on("data", (b) => {
			output += b.toString();
			process.stderr.write(b);
		});
		child.on("error", (err) => {
			output += `spawn error: ${err.message}\n`;
			resolve({ code: 1, output });
		});
		child.on("close", (code, signal) => {
			// A child killed by a signal closes with a null code. Reading that as
			// 0 would turn a killed suite into a pass, which is the same defect
			// NRL-55 fixed in src/engines/system/spawn.ts.
			resolve({ code: code === null ? (signal ? 1 : 1) : code, output, signal });
		});
	});
}

async function main() {
	const root = path.dirname(fileURLToPath(import.meta.url));
	const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
	const planned = suitePathsFromPretest(pkg.scripts?.pretest ?? "");

	if (planned.length === 0) {
		console.error(
			"run-tests: package.json scripts.pretest names no tests/<name>.test.ts paths; nothing to run",
		);
		process.exitCode = 1;
		return;
	}

	/** One entry per PLANNED path, appended in the loop. The post-loop
	 * reconciliation compares this against `planned`, which is the only place in
	 * the tree that can observe the whole run: tests/suiteRegistry.test.ts runs
	 * INSIDE it, so a suite dropped from the execution loop is invisible there. */
	const results = [];

	for (const rel of planned) {
		const abs = path.join(root, rel);
		const name = suiteName(rel);
		console.log(`\n>>> ${name} (${rel})`);

		if (!fs.existsSync(abs)) {
			// A missing build output is a NAMED failure, never a silently shorter
			// run. `pretest` builds these, so a missing one means the build
			// half-succeeded or someone deleted an artifact.
			console.log(`  FAIL ${name} build output missing: ${rel}`);
			results.push({
				name,
				status: "FAIL",
				detail: "build output missing",
				ok: 0,
				skipped: 0,
				failed: 1,
				tail: "",
			});
			continue;
		}

		const { code, output, signal } = await runSuite(abs);
		const counts = countChecks(output);
		const tail = output.split("\n").slice(-20).join("\n");

		// Exit code is the authority, exactly as `&&` used it. Deliberately NOT a
		// summary-line regex: tests/readSelection.test.ts prints no
		// `all ... passed` line at all, so requiring one would invent a failure.
		if (code === 0 && output.trim().length === 0) {
			// Anti-vacuity: a suite that exits 0 having printed nothing has almost
			// certainly not run its checks.
			results.push({
				name,
				status: "FAIL",
				detail: "exited 0 but produced no output",
				...counts,
				tail,
			});
		} else if (code === 0) {
			results.push({ name, status: "ok", detail: "", ...counts, tail });
		} else if (counts.failed > 0) {
			results.push({
				name,
				status: "FAIL",
				detail: `exit ${code}, ${counts.failed} failing check(s)`,
				...counts,
				tail,
			});
		} else {
			// Non-zero with no FAIL line of its own: it crashed rather than
			// reporting. It has no self-report, so the summary carries its tail.
			results.push({
				name,
				status: "CRASH",
				detail: signal ? `killed by ${signal}` : `exit ${code}, no FAIL lines`,
				...counts,
				tail,
			});
		}
	}

	console.log("\n=== summary ===");
	for (const r of results) {
		const counts = `${r.ok} ok, ${r.skipped} skipped, ${r.failed} failed`;
		console.log(
			`  ${r.status.padEnd(5)} ${r.name.padEnd(20)} ${counts}${r.detail ? ` - ${r.detail}` : ""}`,
		);
	}

	const totals = results.reduce(
		(a, r) => ({
			ok: a.ok + r.ok,
			skipped: a.skipped + r.skipped,
			failed: a.failed + r.failed,
		}),
		{ ok: 0, skipped: 0, failed: 0 },
	);
	const bad = results.filter((r) => r.status !== "ok");

	console.log(
		`\n${results.length} suites: ${results.length - bad.length} ok, ${bad.length} failed; ` +
			`${totals.ok} checks ok, ${totals.skipped} skipped, ${totals.failed} failed`,
	);

	// Reconciliation. A suite dropped from the loop above leaves `results`
	// shorter than `planned`, and no test running inside this process can see
	// that, because they all run inside the loop.
	let unreconciled = [];
	if (results.length !== planned.length) {
		const produced = new Set(results.map((r) => r.name));
		unreconciled = planned.map(suiteName).filter((n) => !produced.has(n));
		console.log(
			`\nrunner planned ${planned.length} suites and produced ${results.length} results; ` +
				`not run: ${unreconciled.length > 0 ? unreconciled.join(", ") : "<unnamed>"}`,
		);
	}

	for (const r of bad) {
		if (r.status === "CRASH") {
			console.log(`\n--- ${r.name} crashed with no self-report; last lines ---`);
			console.log(r.tail);
		}
	}

	if (bad.length > 0) {
		// Failing suite names LAST, so the final thing in a CI log names every
		// suite to look at rather than only the first.
		console.log(`\nFAILING SUITES: ${bad.map((r) => `${r.name} (${r.status})`).join(", ")}`);
		process.exitCode = 1;
		return;
	}
	if (results.length !== planned.length) {
		process.exitCode = 1;
		return;
	}

	// Never a bare all-passed line when something was skipped: a reader grepping
	// for it would take a partial run for a full one. That is the house rule
	// tests/engine.test.ts and tests/suiteRegistry.test.ts already follow.
	console.log(
		totals.skipped > 0
			? `all ${results.length} suites passed (${totals.skipped} checks skipped)`
			: `all ${results.length} suites passed`,
	);
}

// See the header. `path.basename` and not the pathToFileURL idiom, which fires
// inside the esbuild bundle of any test that imports this file.
if (path.basename(process.argv[1] ?? "") === "run-tests.mjs") {
	await main();
}
