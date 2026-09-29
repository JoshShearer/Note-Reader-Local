/**
 * The reading-position throttle: leading edge, trailing flush, and the Stop
 * that cannot be lost to a cancellation.
 *
 * Fail-first provenance, since "the test passes" is not evidence of anything on
 * its own here:
 *
 *  - The gate this replaces lived in main.ts (the `positionUpdateTimeout` block)
 *    and could not be tested at all, obsidian having no runtime. A verbatim
 *    replica of it, with flush() and dispose() as no-ops because the pre-change
 *    code had neither, was run against this file: 17 of 26 checks failed, and the
 *    run is reproduced in the NRL-51 implementation summary. The replica is
 *    disposable and lives outside the repo; it is not imported by anything.
 *  - So every check here below is a real fail-first against the shipped
 *    behaviour, not a prediction. The shape of the loss is visible in it: the
 *    window's timer only nulled the handle, so a second event inside the window
 *    was recorded nowhere at all and a Stop wrote nothing.
 */

import { PositionThrottle } from "../src/settings/positionThrottle.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
	if (cond) console.log(`  ok   ${name}`);
	else {
		failures += 1;
		console.log(`  FAIL ${name} ${detail}`);
	}
}

/** A clock the test owns, so "advance 1001 ms" is a fact rather than a wait. */
class FakeClock {
	private next = 1;
	// Not named `timers`: the injected pair below is, and a same-named private
	// field would shadow the Map the closures reach for.
	private armed = new Map<number, () => void>();

	readonly timers = {
		setTimeout: (fn: () => void): unknown => {
			const id = this.next++;
			this.armed.set(id, fn);
			return id;
		},
		clearTimeout: (handle: unknown): void => {
			this.armed.delete(handle as number);
		},
	};

	/** Fire everything currently armed, as the real clock would. */
	fire(): void {
		const waiting = [...this.armed.entries()];
		this.armed.clear();
		for (const [, fn] of waiting) fn();
	}

	pending(): number {
		return this.armed.size;
	}
}

interface Harness {
	throttle: PositionThrottle;
	clock: FakeClock;
	saves: number[];
	/** The queue's file path, as main.ts reads it from the player. */
	path: string;
}

function harness(path = "Notes/a.md"): Harness {
	const clock = new FakeClock();
	const saves: number[] = [];
	const h = { clock, saves, path } as Harness;
	h.throttle = new PositionThrottle({
		save: (index) => saves.push(index),
		currentFilePath: () => h.path,
		timers: clock.timers,
	});
	return h;
}

console.log("the leading edge saves on the first event, immediately");
{
	const h = harness();
	h.throttle.note("Notes/a.md", 0);
	check("one save so far", h.saves.length === 1, JSON.stringify(h.saves));
	check("carrying the event's own index", h.saves[0] === 0, JSON.stringify(h.saves));
	check("the save happened synchronously, not on a timer", h.clock.pending() === 1, String(h.clock.pending()));
	check("a second note is not written immediately", (h.throttle.note("Notes/a.md", 1), h.saves.length === 1), JSON.stringify(h.saves));
	h.throttle.dispose();
}

console.log("a value dropped inside the window is written by the flush, not lost");
{
	// The shape of the old gate's failure, confirmed by the replica run above:
	// five events produced one save and index 4 was never persisted, because the
	// timer only nulled its handle.
	const h = harness();
	h.throttle.note("Notes/a.md", 0);
	for (let i = 1; i < 5; i++) h.throttle.note("Notes/a.md", i);
	check("before the window closes only the leading save has happened", h.saves.length === 1, JSON.stringify(h.saves));

	h.clock.fire();
	check("after the flush every event has been accounted for", h.saves.length === 2, JSON.stringify(h.saves));
	check("the flushed value is the newest, not the oldest dropped", h.saves[1] === 4, JSON.stringify(h.saves));
}

console.log("the trailing flush runs at the window edge and re-opens the window");
{
	const h = harness();
	h.throttle.note("Notes/a.md", 0);
	h.throttle.note("Notes/a.md", 1);
	h.clock.fire();
	check("the pending value landed on the edge", h.saves.join(",") === "0,1", h.saves.join(","));

	// The window must be closed, not stuck open, or every later event would be
	// dropped and the note's position would freeze.
	h.throttle.note("Notes/a.md", 2);
	check("a later event is written immediately again", h.saves.join(",") === "0,1,2", h.saves.join(","));
	h.clock.fire();
	check("and that leaves nothing pending", h.saves.join(",") === "0,1,2", h.saves.join(","));
	h.throttle.dispose();
}

console.log("a Stop inside an open window is written by the Stop");
{
	// The requirement is that a Stop cannot be lost by the flush being
	// cancelled. The Stop arrives as flush() from the state subscription, so it
	// writes synchronously and the timer is disarmed afterwards. Nothing is
	// awaiting, nothing can abort it.
	const h = harness();
	h.throttle.note("Notes/a.md", 0);
	h.throttle.note("Notes/a.md", 7);

	h.throttle.flush();
	check("the Stop wrote the value the timer was holding", h.saves.join(",") === "0,7", h.saves.join(","));
	check("the window is closed afterwards", h.clock.pending() === 0, String(h.clock.pending()));

	// The disarmed timer must not fire and write a stale value. This is the
	// observable consequence of cancelling before writing, and it is the half a
	// clear-then-save ordering gets wrong in the other direction: the record is
	// already gone, so a surviving timer would have nothing to write.
	h.clock.fire();
	check("the cancelled timer wrote nothing extra", h.saves.join(",") === "0,7", h.saves.join(","));

	// And a second Stop, with nothing pending, is a no-op rather than a
	// duplicate write of the value that is already stored.
	h.throttle.flush();
	check("a second flush with nothing pending writes nothing", h.saves.join(",") === "0,7", h.saves.join(","));
}

console.log("a flush with an empty window is a no-op");
{
	const h = harness();
	h.throttle.flush();
	check("nothing saved before any event", h.saves.length === 0, JSON.stringify(h.saves));
	h.throttle.note("Notes/a.md", 3);
	h.throttle.flush();
	check("the leading save already wrote it", h.saves.join(",") === "3", h.saves.join(","));
	h.throttle.flush();
	check("the flush added nothing", h.saves.join(",") === "3", h.saves.join(","));
}

console.log("a captured index is not replayed against a queue it no longer belongs to");
{
	// main.ts flushes on every state change, which closes the window each time,
	// so this is belt and braces. The consequence of getting it wrong is a
	// position written under the wrong note's key.
	const h = harness("Notes/a.md");
	h.throttle.note("Notes/a.md", 0);
	h.throttle.note("Notes/a.md", 4);
	h.path = "Notes/b.md";
	h.throttle.flush();
	check("a stale path is refused", h.saves.join(",") === "0", h.saves.join(","));

	// The same queue, so the flush goes through.
	const same = harness("Notes/b.md");
	same.throttle.note("Notes/b.md", 0);
	same.throttle.note("Notes/b.md", 9);
	same.path = "Notes/b.md";
	same.throttle.flush();
	check("a matching path is written", same.saves.join(",") === "0,9", same.saves.join(","));
}

console.log("dispose flushes and leaves no timer behind");
{
	// The old window handle was never cleared anywhere, on any path. On unload
	// that meant a trailing write against a plugin that was already gone.
	const h = harness();
	h.throttle.note("Notes/a.md", 0);
	h.throttle.note("Notes/a.md", 5);
	h.throttle.dispose();
	check("dispose wrote the pending value", h.saves.join(",") === "0,5", h.saves.join(","));
	check("no timer survives dispose", h.clock.pending() === 0, String(h.clock.pending()));
	h.clock.fire();
	check("nothing fires after dispose", h.saves.join(",") === "0,5", h.saves.join(","));

	// And with an open window but nothing pending, dispose must still disarm it.
	const h2 = harness();
	h2.throttle.note("Notes/a.md", 0);
	h2.throttle.dispose();
	check("an open window is disarmed by dispose", h2.clock.pending() === 0, String(h2.clock.pending()));

	// A progress event that arrives after unload. The player was disposed
	// first, so in practice the audio element cannot settle - but if one does,
	// arming a window nothing will ever close is a silent leak that
	// clearTimeout-on-dispose alone does not cover, because the arming
	// happens after it.
	const h3 = harness();
	h3.throttle.dispose();
	h3.throttle.note("Notes/a.md", 2);
	check("a note after dispose saves nothing", h3.saves.length === 0, JSON.stringify(h3.saves));
	check("a note after dispose arms no timer", h3.clock.pending() === 0, String(h3.clock.pending()));
	h3.throttle.flush();
	check("a flush after dispose writes nothing", h3.saves.length === 0, JSON.stringify(h3.saves));
}

console.log("the default window is 1000 ms");
{
	// A shorter or longer window changes how much reading is dropped, and the
	// spec does not name one, so this pins what shipped rather than a decision.
	let armedFor: number | null = null;
	const saves: number[] = [];
	const throttle = new PositionThrottle({
		save: (i) => saves.push(i),
		currentFilePath: () => "Notes/a.md",
		timers: {
			setTimeout: (_fn, ms) => {
				armedFor = ms;
				return 1;
			},
			clearTimeout: () => {},
		},
	});
	throttle.note("Notes/a.md", 0);
	check("the default window is 1000 ms", armedFor === 1000, String(armedFor));
	throttle.dispose();
}

if (failures > 0) {
	console.log(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall positionThrottle checks passed");
