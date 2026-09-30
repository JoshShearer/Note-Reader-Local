/**
 * NRL-65: the "Loading X..." Notice must be dismissed at the Stop, not when
 * the abandoned load eventually settles.
 *
 * FAIL-FIRST STAGING. `src/ui/loadingNotice.ts` IS the fix, so every check
 * below is green by construction against it and none of them would prove
 * anything on its own. The counts were taken by swapping the import for a
 * transcription of the OLD policy, `src/main.ts:736-751` mapped into the same
 * (show, work) shape with no signal parameter at all:
 *
 *     async function withLoadingNoticeOld<T>(
 *         show: () => Dismissable,
 *         work: () => Promise<T>,
 *         _signal?: AbortSignal,   // the old block had no signal at all
 *     ): Promise<T> {
 *         const loading = show();
 *         try {
 *             return await work();
 *         } finally {
 *             loading.hide();
 *         }
 *     }
 *
 * Measured: 5 FAILURES against that, 0 against the real module. Plus 1 in
 * tests/fallback.test.ts T5(i), the integration half, staged the same way.
 *
 * THE TRANSCRIPTION WAS CHECKED, NOT EYEBALLED. A scratch probe drove the
 * verbatim main.ts:736-751 block and the transcription above through the real
 * `playWithFallback` side by side and compared their step transcripts: under
 * the reproduction's own schedule (350 ms load, Stop at +51 ms) both produced
 * ["SHOW","STOP","NULL","SETTLE","HIDE"], and under a `prepare()` that throws
 * synchronously both produced ["SHOW","HIDE","NULL"]. Without that second
 * scenario the count would have been theatre: a `work().finally(hide)` shaped
 * transcription diverges there, because the old block invoked its load INSIDE
 * the try.
 *
 * LABELS ARE HONEST. Of the 6 pre-fix failures only 3 are defect
 * reproductions: L1, L2 and fallback T5(i). L7 (1) and L8 (2) are new
 * capability and new behaviour respectively - they are red against the old
 * policy only because the old policy has no signal parameter, so they must not
 * be read as evidence of the defect. Everything else is a GUARD: green on both
 * sides, kept because it is what a fix could plausibly break.
 *
 * L9 WAS PLANNED AS RED AND IS NOT. The plan expected a synchronously-throwing
 * thunk to leave the old Notice up. It does not: the old block ran its body
 * INSIDE the try, so a sync throw hit the `finally` and hid the Notice, and
 * `prepareCandidate` being `async` turned it into a rejection anyway. It is
 * relabelled a guard rather than counted, because counting it would be
 * measuring this file's transcription rather than the shipped code.
 *
 * L10 PRIVACY is structural, not runtime, and is deliberately not faked into an
 * assertion. The property is that `withLoadingNotice` accepts no string and
 * `Dismissable` declares only `hide()`, so no note text can reach this module
 * at all (AGENTS.md non-negotiable 1). The compiler asserts it; the module
 * docstring records it.
 */

import { withLoadingNotice, type Dismissable } from "../src/ui/loadingNotice.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
	if (cond) console.log(`  ok   ${name}`);
	else {
		failures += 1;
		console.log(`  FAIL ${name} ${detail}`);
	}
}

/** A `Dismissable` that counts, and optionally logs into a shared step list. */
function fakeNotice(log?: string[]): { notice: Dismissable; hideCalls: () => number } {
	let hideCalls = 0;
	return {
		notice: {
			hide() {
				hideCalls += 1;
				log?.push("hide");
			},
		},
		hideCalls: () => hideCalls,
	};
}

/** A promise the test settles by hand. */
function held<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void } {
	let resolve!: (v: T) => void;
	let reject!: (e: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function tick(): Promise<void> {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
}

// --- L1 RED pre-fix ---------------------------------------------------------

console.log("L1 [RED pre-fix] a held load plus an abort: hidden at the abort, not at the settle");
{
	const { notice, hideCalls } = fakeNotice();
	const load = held<string>();
	const scope = new AbortController();
	let showCalls = 0;

	const result = withLoadingNotice(
		() => {
			showCalls += 1;
			return notice;
		},
		() => load.promise,
		scope.signal,
	);

	await tick();
	check("shown exactly once", showCalls === 1, `${showCalls}`);
	check("not yet hidden while the load is in flight", hideCalls() === 0, `${hideCalls()}`);

	scope.abort();
	await tick();
	check("hidden at the abort, before the load settled", hideCalls() === 1, `${hideCalls()}`);

	// The abandoned load settles later anyway (ADR 0013: abandoned, not
	// cancelled). It must not hide a second time.
	load.resolve("done");
	await result;
	await tick();
	check("still exactly one hide after the abandoned load settled", hideCalls() === 1, `${hideCalls()}`);
}

// --- L2 RED pre-fix ---------------------------------------------------------

console.log("L2 [RED pre-fix] step order is show, abort, hide, settle");
{
	const log: string[] = [];
	const { notice } = fakeNotice(log);
	const load = held<void>();
	const scope = new AbortController();

	const result = withLoadingNotice(
		() => {
			log.push("show");
			return notice;
		},
		() => load.promise,
		scope.signal,
	);

	await tick();
	log.push("abort");
	scope.abort();
	await tick();
	log.push("settle");
	load.resolve();
	await result;
	await tick();

	// The direct analogue of the reproduction transcript: SHOW +6ms,
	// Stop +58ms, HIDE +357ms of a 350ms load. The old policy logs
	// ["show","abort","settle","hide"] - the hide last, at the settle.
	check(
		"log is show, abort, hide, settle",
		JSON.stringify(log) === JSON.stringify(["show", "abort", "hide", "settle"]),
		JSON.stringify(log),
	);
}

// --- L3 GUARD ---------------------------------------------------------------

console.log("L3 [guard] a slow load with no abort still shows for its full duration");
{
	const { notice, hideCalls } = fakeNotice();
	const load = held<number>();

	const result = withLoadingNotice(() => notice, () => load.promise);

	for (let i = 0; i < 5; i++) {
		await tick();
		check(`not hidden while still loading (tick ${i})`, hideCalls() === 0, `${hideCalls()}`);
	}

	load.resolve(42);
	const value = await result;
	check("hidden exactly once on completion", hideCalls() === 1, `${hideCalls()}`);
	check("the work's resolution value is preserved", value === 42, `${value}`);
}

// --- L4 GUARD ---------------------------------------------------------------

console.log("L4 [guard] a load that rejects with no abort: the rejection reaches the caller unchanged");
{
	const { notice, hideCalls } = fakeNotice();
	const load = held<void>();
	const boom = new Error("cold load died");

	const result = withLoadingNotice(() => notice, () => load.promise);
	load.reject(boom);

	let caught: unknown = null;
	try {
		await result;
	} catch (err) {
		caught = err;
	}

	// raceAbort turns this into "failed" and falls back to the next candidate,
	// so identity matters, not just that it rejected.
	check("the same Error instance propagates", caught === boom, String(caught));
	check("hidden exactly once", hideCalls() === 1, `${hideCalls()}`);
}

// --- L5 GUARD ---------------------------------------------------------------

console.log("L5 [guard] abort then settle: one hide in total");
{
	const { notice, hideCalls } = fakeNotice();
	const load = held<void>();
	const scope = new AbortController();

	const result = withLoadingNotice(() => notice, () => load.promise, scope.signal);

	scope.abort();
	await tick();
	load.resolve();
	await result;
	await tick();

	check("exactly one hide across both paths", hideCalls() === 1, `${hideCalls()}`);
}

// --- L6 GUARD ---------------------------------------------------------------

console.log("L6 [guard] settle then abort: one hide in total, nothing thrown");
{
	const rejections: unknown[] = [];
	const collect = (reason: unknown): void => {
		rejections.push(reason);
	};
	process.on("unhandledRejection", collect);

	const { notice, hideCalls } = fakeNotice();
	const load = held<void>();
	const scope = new AbortController();

	const result = withLoadingNotice(() => notice, () => load.promise, scope.signal);

	load.resolve();
	await result;
	await tick();
	check("hidden once at completion", hideCalls() === 1, `${hideCalls()}`);

	let threw = false;
	try {
		scope.abort();
	} catch {
		threw = true;
	}
	await tick();
	check("a later abort does not hide again", hideCalls() === 1, `${hideCalls()}`);
	check("a later abort does not throw", !threw);
	check("no unhandled rejection escaped", rejections.length === 0, `${rejections.length}`);

	process.off("unhandledRejection", collect);
}

// --- L7 NEW CAPABILITY (not a defect reproduction) --------------------------

console.log("L7 [new capability, NOT defect evidence] listener hygiene over 50 candidates on one signal");
{
	const real = new AbortController();
	const added: Array<() => void> = [];
	const removed: Array<() => void> = [];
	let mismatchedRemoval = 0;

	// Duck-typed: the module reads only `aborted`, `addEventListener` and
	// `removeEventListener`. Delegating to a real signal keeps dispatch honest.
	const recorder = {
		get aborted(): boolean {
			return real.signal.aborted;
		},
		addEventListener(type: string, fn: () => void, opts?: unknown): void {
			added.push(fn);
			real.signal.addEventListener(type, fn, opts as AddEventListenerOptions);
		},
		removeEventListener(type: string, fn: () => void): void {
			if (!added.includes(fn)) mismatchedRemoval += 1;
			removed.push(fn);
			real.signal.removeEventListener(type, fn);
		},
	} as unknown as AbortSignal;

	for (let i = 0; i < 50; i++) {
		const { notice } = fakeNotice();
		const load = held<void>();
		const result = withLoadingNotice(() => notice, () => load.promise, recorder);
		load.resolve();
		await result;
	}
	await tick();

	check("one listener registered per candidate", added.length === 50, `${added.length}`);
	check("no residual listeners", added.length - removed.length === 0, `${added.length - removed.length}`);
	check("every removal used the reference it added", mismatchedRemoval === 0, `${mismatchedRemoval}`);
}

// --- L8 NEW BEHAVIOUR (Q19, not defect evidence) ----------------------------

console.log("L8 [new behaviour, NOT defect evidence] already aborted on entry: no show, work still runs once");
{
	const { notice, hideCalls } = fakeNotice();
	const scope = new AbortController();
	scope.abort();

	let showCalls = 0;
	let workCalls = 0;

	const value = await withLoadingNotice(
		() => {
			showCalls += 1;
			return notice;
		},
		async () => {
			workCalls += 1;
			return "loaded";
		},
		scope.signal,
	);

	// No show-then-hide flash: construction is skipped entirely, which is what
	// keeps ADR 0013's load behaviour byte-identical.
	check("show() was never called", showCalls === 0, `${showCalls}`);
	check("nothing was hidden either", hideCalls() === 0, `${hideCalls()}`);
	check("work() still ran exactly once", workCalls === 1, `${workCalls}`);
	check("the work's value still reaches the caller", value === "loaded", String(value));
}

// --- L9 GUARD (planned RED, measured green on both sides) -------------------

console.log("L9 [guard] a thunk that throws synchronously becomes a rejection, and hides");
{
	const { notice, hideCalls } = fakeNotice();
	const boom = new Error("sync throw from the load");

	let syncThrow = false;
	let caught: unknown = null;
	let result: Promise<void> | undefined;
	try {
		result = withLoadingNotice(
			() => notice,
			() => {
				throw boom;
			},
		);
	} catch {
		syncThrow = true;
	}

	if (result) {
		try {
			await result;
		} catch (err) {
			caught = err;
		}
	}

	check("nothing escaped synchronously", !syncThrow);
	check("the throw arrived as a rejection", caught === boom, String(caught));
	check("hidden exactly once", hideCalls() === 1, `${hideCalls()}`);
}

// --- L10 PRIVACY ------------------------------------------------------------
// Structural, asserted by the compiler rather than at runtime, and deliberately
// not faked into a check(): `withLoadingNotice`'s signature accepts no string
// and `Dismissable` declares only `hide()`, so there is no argument through
// which note text could reach this module (AGENTS.md non-negotiable 1). The one
// string in the feature is `candidate.engine.label`, which stays inside
// main.ts's `show()` closure. The type alias below exists only so a future
// widening of the signature has to be a deliberate edit to this file too.
type _PrivacyPin = Dismissable extends { hide(): void } ? true : never;
const _privacyPin: _PrivacyPin = true;
void _privacyPin;

console.log("");
if (failures > 0) {
	console.log(`${failures} FAILURE(S)`);
	process.exit(1);
}
console.log("all loadingNotice tests passed");
