/**
 * Vault rename/delete orchestration and the serialised save queue (NRL-58).
 *
 * TWO defects, both reproduced against the shipped code before anything moved,
 * by transcribing main.ts's handler bodies and saveSettings() into a bare-Node
 * harness and driving the real PositionThrottle and the real map sweeps:
 *
 *   (a) the stop check was `oldPath === player.getFilePath()`, exact equality.
 *       A `Notes/A` -> `Notes/B` folder rename while reading `Notes/A/deep.md`
 *       re-keyed the stored position and left the read running, and one throttle
 *       window later the in-memory map held BOTH `Notes/A/deep.md` and
 *       `Notes/B/deep.md`. Same for a folder delete: the deleted key came back.
 *   (b) saveSettings() awaited saveData() directly, so writes overlapped.
 *       Releasing two in-flight writes in reverse order put the durable order at
 *       [w1, w0] against an enqueue order of [w0, w1], and the disk ended up
 *       holding `["Notes/A/deep.md"]` after a rename to `Notes/A/renamed.md` -
 *       the orphan the handler had just removed, back again.
 *
 * FAIL-FIRST PROVENANCE. Both halves here are EXTRACTIONS, so a test written
 * against the new modules is green by construction and proves nothing on its
 * own - the trap tests/readSelection.test.ts fell into, where 73 green checks
 * hid NRL-57. So both modules were first landed carrying the VERBATIM old
 * behaviour (`=== oldPath` in vaultEvents.ts, a pass-through `enqueue` in
 * saveQueue.ts), this file was run against them, and the failure counts are
 * recorded in the NRL-58 implementation summary. Every check labelled T1-T6
 * below except T6 is a real fail-first; T6 is POST-FIX ONLY by design, because a
 * pass-through has no queue state to wedge, and it says so on the check.
 * Checks labelled `guard` are expected green on BOTH sides and are never
 * evidence of the fix.
 *
 * NOTHING HERE WAS OBSERVED IN OBSIDIAN. main.ts's two handler shells, the port
 * construction and the SaveQueue construction have no automated coverage of any
 * kind, obsidian having no runtime. T3's stop-then-flush ordering is a
 * TRANSCRIPTION of main.ts's player state subscription, not the real wiring.
 */

import { covers, type PluginData, type ReadingPosition } from "../src/settings/data.ts";
import { applyVaultDelete, applyVaultRename, type VaultEventPort } from "../src/settings/vaultEvents.ts";
import { SaveQueue } from "../src/settings/saveQueue.ts";
import { PositionThrottle } from "../src/settings/positionThrottle.ts";
import { DEFAULT_SETTINGS, type Settings } from "../src/settings/index.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
	if (cond) console.log(`  ok   ${name}`);
	else {
		failures += 1;
		console.log(`  FAIL ${name} ${detail}`);
	}
}

const tick = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

function pos(filePath: string, index: number): ReadingPosition {
	return {
		filePath,
		segmentId: `seg-${index}`,
		segmentIndex: index,
		sourceOffset: index * 100,
		updatedAt: 1,
	};
}

/** A clock the test owns, the same shape tests/positionThrottle.test.ts uses. */
class FakeClock {
	private next = 1;
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
	fire(): void {
		const waiting = [...this.armed.entries()];
		this.armed.clear();
		for (const [, fn] of waiting) fn();
	}
	pending(): number {
		return this.armed.size;
	}
}

/**
 * A stubbed host for the port, recording everything the orchestration asks for.
 * No clock and no store: the cases that need those build them explicitly.
 */
interface Spy {
	port: VaultEventPort;
	positions: Record<string, ReadingPosition>;
	stops: number;
	setCalls: number;
	saves: number;
	traced: string[];
	queuePath: string;
}

function spy(queuePath: string, positions: Record<string, ReadingPosition>): Spy {
	const s: Spy = {
		positions,
		stops: 0,
		setCalls: 0,
		saves: 0,
		traced: [],
		queuePath,
		port: null as unknown as VaultEventPort,
	};
	s.port = {
		currentFilePath: () => s.queuePath,
		stop: () => {
			s.stops += 1;
		},
		positions: () => s.positions,
		setPositions: (next) => {
			s.positions = next;
			s.setCalls += 1;
		},
		save: () => {
			s.saves += 1;
		},
		trace: (step, detail) => {
			s.traced.push(`${step}: ${detail}`);
		},
	};
	return s;
}

// =====================================================================
console.log("T1 a folder-only event stops the descendant read and re-keys its position");
// =====================================================================
{
	// RED pre-fix: stop() was never called, because "Notes/A/deep.md" is not
	// equal to "Notes/A". The sweep half was already right, which is what made
	// the defect produce an orphan rather than simply doing nothing.
	const s = spy("Notes/A/deep.md", { "Notes/A/deep.md": pos("Notes/A/deep.md", 3) });
	applyVaultRename(s.port, "Notes/A", "Notes/B");
	check("T1 rename: the folder event stopped the descendant read", s.stops === 1, `stops=${s.stops}`);
	// The sweep half was ALREADY correct before NRL-58 - it always used `covers` -
	// so the next four are guards, not evidence of the fix. They are here because
	// the defect was the two halves disagreeing, and a fix that broke the sweep to
	// make the stop fire would be no better.
	check(
		"T1 rename (guard): the descendant key moved to the new folder",
		Object.keys(s.positions).join(",") === "Notes/B/deep.md",
		JSON.stringify(Object.keys(s.positions)),
	);
	check(
		"T1 rename (guard): the moved value's own filePath follows its key",
		s.positions["Notes/B/deep.md"]?.filePath === "Notes/B/deep.md",
		String(s.positions["Notes/B/deep.md"]?.filePath),
	);
	check("T1 rename (guard): exactly one save was asked for", s.saves === 1, `saves=${s.saves}`);

	const d = spy("Notes/A/deep.md", { "Notes/A/deep.md": pos("Notes/A/deep.md", 3) });
	applyVaultDelete(d.port, "Notes/A");
	check("T1 delete: the folder event stopped the descendant read", d.stops === 1, `stops=${d.stops}`);
	check(
		"T1 delete (guard): the descendant key is gone",
		Object.keys(d.positions).length === 0,
		JSON.stringify(Object.keys(d.positions)),
	);
	check("T1 delete (guard): exactly one save was asked for", d.saves === 1, `saves=${d.saves}`);

	// A folder event whose subtree holds NO stored position still stops the read.
	// The stop is ahead of the identity early-out on purpose, so the "nothing to
	// write" path cannot also mean "nothing to stop".
	const bare = spy("Notes/A/deep.md", {});
	applyVaultRename(bare.port, "Notes/A", "Notes/B");
	check(
		"T1 rename: a folder with no stored position still stops the read",
		bare.stops === 1 && bare.saves === 0,
		`stops=${bare.stops} saves=${bare.saves}`,
	);
	const bareDel = spy("Notes/A/deep.md", {});
	applyVaultDelete(bareDel.port, "Notes/A");
	check(
		"T1 delete: a folder with no stored position still stops the read",
		bareDel.stops === 1 && bareDel.saves === 0,
		`stops=${bareDel.stops} saves=${bareDel.saves}`,
	);
}

// =====================================================================
console.log("T2 a repeated descendant event adds nothing, and the FOLDER event is the stop");
// =====================================================================
{
	/*
	 * DELIBERATE DEPARTURE from the plan's wording, which asked for "total stop()
	 * calls is 1 not 2". That is not achievable and would be the wrong thing to
	 * assert. The queue is deliberately NOT retargeted (SpeechChunk.id hashes
	 * filePath), so getFilePath() keeps answering with the pre-rename path, and a
	 * descendant event arriving after the folder event therefore matches too. The
	 * module is stateless by design, so there is nowhere to dedupe. A second stop
	 * is harmless rather than merely tolerated: stopReading() -> Player.stop()
	 * re-aborts already-nulled controllers and ends in setState("idle"), which
	 * early-returns on an unchanged state. So what is asserted is that the FOLDER
	 * event is sufficient on its own, which is the defect, plus the map surgery
	 * being a genuine no-op on the repeat.
	 */
	const s = spy("Notes/A/deep.md", { "Notes/A/deep.md": pos("Notes/A/deep.md", 3) });
	applyVaultRename(s.port, "Notes/A", "Notes/B");
	const stopsAfterFolder = s.stops;
	const setsAfterFolder = s.setCalls;
	const savesAfterFolder = s.saves;
	// Obsidian may or may not follow a folder rename with one per descendant; the
	// typings do not say. Correctness no longer depends on the answer, which is
	// the point of this case.
	applyVaultRename(s.port, "Notes/A/deep.md", "Notes/B/deep.md");
	check(
		"T2 rename: the FOLDER event alone stopped the read",
		stopsAfterFolder === 1,
		`stops after the folder event = ${stopsAfterFolder}`,
	);
	check(
		"T2 rename (guard): the repeat sweeps nothing, so it writes nothing",
		s.setCalls === setsAfterFolder && s.saves === savesAfterFolder,
		`setCalls ${setsAfterFolder}->${s.setCalls}, saves ${savesAfterFolder}->${s.saves}`,
	);
	check(
		"T2 rename (guard): the key is still the rekeyed one",
		Object.keys(s.positions).join(",") === "Notes/B/deep.md",
		JSON.stringify(Object.keys(s.positions)),
	);

	const d = spy("Notes/deep.md", { "Notes/deep.md": pos("Notes/deep.md", 3) });
	applyVaultDelete(d.port, "Notes");
	const dStops = d.stops;
	const dSaves = d.saves;
	applyVaultDelete(d.port, "Notes");
	check("T2 delete: the folder event alone stopped the read", dStops === 1, `stops=${dStops}`);
	check(
		"T2 delete (guard): a second identical delete writes nothing",
		d.saves === dSaves && Object.keys(d.positions).length === 0,
		`saves ${dSaves}->${d.saves}`,
	);
}

// =====================================================================
console.log("T3 a stop inside an open throttle window: all three real modules");
// =====================================================================
{
	/*
	 * The one case that wires the real PositionThrottle, the real vaultEvents and
	 * the real SaveQueue together. The stop-then-flush ordering below is a
	 * TRANSCRIPTION of main.ts:245 (the player's state subscription flushes on
	 * "paused" / "idle" / "finished") and main.ts:152-163, not the real wiring, so
	 * this measures the fix only as far as that transcription is faithful.
	 *
	 * RED pre-fix: with no stop there is no flush, so the pending index is written
	 * by the timer AFTER the sweep has run, under the OLD key.
	 */
	const clock = new FakeClock();
	const disk: { data: PluginData | null } = { data: null };
	const settings: Settings = { ...DEFAULT_SETTINGS };
	const container: PluginData = {
		version: 2,
		settings,
		positions: { "Notes/A/deep.md": pos("Notes/A/deep.md", 0) },
	};
	let queuePath = "Notes/A/deep.md";
	const chunks = [0, 1, 2].map((i) => ({
		id: `seg-${i}`,
		sequence: i,
		sourceStart: i * 100,
		filePath: "Notes/A/deep.md",
	}));

	const queue = new SaveQueue({ write: async (p) => { disk.data = p; } });
	const saveSettings = async (): Promise<void> => {
		// main.ts:1467-1480 transcribed, minus refreshHighlightLayers (obsidian).
		holder.data = { ...holder.data, settings };
		await queue.enqueue(holder.data);
	};
	const holder: { data: PluginData } = { data: container };

	const throttle = new PositionThrottle({
		save: (chunkIndex) => {
			// main.ts:887-911 transcribed.
			const chunk = chunks[chunkIndex];
			if (!chunk) return;
			holder.data.positions[chunk.filePath] = {
				filePath: chunk.filePath,
				segmentId: chunk.id,
				segmentIndex: chunk.sequence,
				sourceOffset: chunk.sourceStart,
				updatedAt: 1,
			};
			void saveSettings();
		},
		currentFilePath: () => queuePath,
		timers: clock.timers,
	});

	const port: VaultEventPort = {
		currentFilePath: () => queuePath,
		stop: () => {
			// stopReading() -> player.stop() -> state "idle" -> flush(). The queue is
			// deliberately left in place, so currentFilePath() keeps answering.
			throttle.flush();
		},
		positions: () => holder.data.positions,
		setPositions: (next) => {
			holder.data.positions = next;
		},
		save: () => {
			void saveSettings();
		},
		trace: () => {},
	};

	throttle.note(queuePath, 0); // leading edge: index 0 written
	throttle.note(queuePath, 1); // pending inside the window
	await tick();

	applyVaultRename(port, "Notes/A", "Notes/B");
	// Nothing is left armed, because the stop flushed the window.
	check(
		"T3 the stop closed the throttle window",
		clock.pending() === 0,
		`armed timers = ${clock.pending()}`,
	);
	clock.fire(); // a surviving timer would write the pending index now
	await queue.drain();
	await tick();
	await queue.drain();

	const keys = Object.keys(disk.data?.positions ?? {}).sort();
	check(
		"T3 the durable map holds only the new key",
		keys.join(",") === "Notes/B/deep.md",
		JSON.stringify(keys),
	);
	check(
		"T3 the surviving position is the index-1 chunk the window was holding",
		disk.data?.positions["Notes/B/deep.md"]?.sourceOffset === 100,
		JSON.stringify(disk.data?.positions["Notes/B/deep.md"]),
	);
	// And the queue is not left holding work. A guard: a pass-through has no state
	// to be left holding, so this is green on both sides of the fix.
	check("T3 (guard): the save queue drained", queue.idle(), "queue not idle");
	void queuePath;
}

// =====================================================================
console.log("T4 deliberately reordered completion attempts cannot invert the durable order");
// =====================================================================
{
	/*
	 * The ticket's own reproduction recipe. RED pre-fix: a pass-through issues
	 * both writes immediately, the reversed release makes the durable order
	 * [B, A], and the last-written map holds the OLD key.
	 *
	 * Post-fix the reversal is not merely corrected, it is unreachable: B is not
	 * issued until A has settled, so there is never a second gate to release
	 * early. Both facts are asserted, because "the reversal was refused" and "the
	 * reversal was reordered" are different guarantees and only the first holds.
	 */
	const issued: PluginData[] = [];
	const durable: PluginData[] = [];
	const gates: Array<() => void> = [];
	const queue = new SaveQueue({
		write: (payload) =>
			new Promise<void>((resolve) => {
				issued.push(payload);
				gates.push(() => {
					durable.push(payload);
					resolve();
				});
			}),
	});

	const settings: Settings = { ...DEFAULT_SETTINGS };
	const oldMap = { "Notes/A/deep.md": pos("Notes/A/deep.md", 0) };
	const newMap = { "Notes/A/renamed.md": pos("Notes/A/renamed.md", 0) };
	const a: PluginData = { version: 2, settings, positions: oldMap };
	const b: PluginData = { version: 2, settings, positions: newMap };

	const pa = queue.enqueue(a);
	const pb = queue.enqueue(b);
	await tick();
	check(
		"T4 only one write is in flight at a time",
		issued.length === 1 && issued[0] === a,
		`issued ${issued.length} write(s)`,
	);
	check(
		"T4 the newer payload has not been issued, so it cannot settle first",
		gates.length === 1,
		`gates=${gates.length}`,
	);

	// THE REVERSAL, attempted rather than assumed away: release the newest gate
	// that exists before the oldest. Pre-fix both gates exist and this really does
	// settle B before A. Post-fix there is only ever one, so the reversal cannot
	// be expressed at all - which is a stronger guarantee than reordering.
	while (gates.length > 0) {
		const newest = gates.pop()!;
		newest();
		await tick();
	}
	await Promise.allSettled([pa, pb]);
	await queue.drain();
	await tick();
	// Anything the drain released.
	while (gates.length > 0) gates.pop()!();
	await Promise.allSettled([pa, pb]);

	check(
		"T4 both payloads were written",
		durable.length === 2,
		`durable=${durable.length}`,
	);
	check(
		"T4 the durable order equals the enqueue order despite a reversed release",
		durable.length === 2 && durable[0] === a && durable[1] === b,
		`durable=[${durable.map((p) => Object.keys(p.positions).join("+")).join(" | ")}]`,
	);
	check(
		"T4 the last durable payload holds the rekeyed map, not the old key",
		Object.keys(durable[durable.length - 1]?.positions ?? {}).join(",") === "Notes/A/renamed.md",
		JSON.stringify(Object.keys(durable[durable.length - 1]?.positions ?? {})),
	);
}

// =====================================================================
console.log("T5 a rename followed by a rate change ends with both, and in order");
// =====================================================================
{
	/*
	 * RED pre-fix: the rename's write and the rate change's write overlap, and
	 * releasing the rename's last leaves the rate nudge undone on disk - the same
	 * pre-existing race AGENTS.md recorded between a rate nudge and a position
	 * write, which is why this case is here rather than only T4's synthetic pair.
	 */
	const durable: PluginData[] = [];
	const gates: Array<() => void> = [];
	const queue = new SaveQueue({
		write: (payload) =>
			new Promise<void>((resolve) => {
				gates.push(() => {
					durable.push(payload);
					resolve();
				});
			}),
	});

	const settings: Settings = { ...DEFAULT_SETTINGS, rate: 1 };
	const holder: { data: PluginData } = {
		data: { version: 2, settings, positions: { "Notes/A/deep.md": pos("Notes/A/deep.md", 0) } },
	};
	// saveSettings() transcribed: a NEW container each call, carrying the live
	// settings object, so the snapshot is shallow exactly as it is in main.ts.
	const saveSettings = (): Promise<void> => {
		holder.data = { ...holder.data, settings: { ...settings } };
		return queue.enqueue(holder.data);
	};

	const port: VaultEventPort = {
		currentFilePath: () => "Notes/A/deep.md",
		stop: () => {},
		positions: () => holder.data.positions,
		setPositions: (next) => {
			holder.data.positions = next;
		},
		save: () => {
			void saveSettings();
		},
		trace: () => {},
	};

	applyVaultRename(port, "Notes/A", "Notes/B");
	await tick();
	settings.rate = 1.5;
	const rateSave = saveSettings();
	await tick();

	// Release everything, newest gate first where one exists. With the queue there
	// is only ever one, so "newest first" degenerates to the correct order.
	while (gates.length > 0) {
		const g = gates.pop()!;
		g();
		await tick();
	}
	await rateSave;
	await queue.drain();

	const last = durable[durable.length - 1];
	check("T5 at least one write landed", last !== undefined, `durable=${durable.length}`);
	// A guard: both payloads carry the rekeyed map here, because the field
	// replacement happened before either snapshot was taken. It is the RATE that
	// the reordering loses, which is the next two checks.
	check(
		"T5 (guard): the final durable payload holds the rekeyed map",
		Object.keys(last?.positions ?? {}).join(",") === "Notes/B/deep.md",
		JSON.stringify(Object.keys(last?.positions ?? {})),
	);
	check("T5 the final durable payload holds rate 1.5", last?.settings.rate === 1.5, String(last?.settings.rate));
	// No write carrying the rekeyed map with the OLD rate may land after one
	// carrying 1.5: that is the reordering, stated as the thing the user loses.
	let seenNewRate = false;
	let staleAfterFresh = false;
	for (const p of durable) {
		if (p.settings.rate === 1.5) seenNewRate = true;
		else if (seenNewRate) staleAfterFresh = true;
	}
	check("T5 no stale-rate write landed after a fresh-rate one", !staleAfterFresh, `${durable.length} writes`);
}

// =====================================================================
console.log("T6 a failed write is reported once and does not wedge the queue (POST-FIX ONLY)");
// =====================================================================
{
	/*
	 * POST-FIX ONLY, and deliberately not counted as a fail-first: a pass-through
	 * has no queue state to wedge, so there was nothing here to be red. It is the
	 * second half of acceptance criterion 2 ("handle failures without permanently
	 * blocking subsequent saves") and it is checked, not assumed.
	 */
	const errors: unknown[] = [];
	const written: PluginData[] = [];
	let failNext = true;
	const queue = new SaveQueue({
		write: async (payload) => {
			if (failNext) {
				failNext = false;
				throw new Error("disk full");
			}
			written.push(payload);
		},
		onError: (err) => errors.push(err),
	});

	const settings: Settings = { ...DEFAULT_SETTINGS };
	const first: PluginData = { version: 2, settings, positions: {} };
	const second: PluginData = { version: 2, settings, positions: { "a.md": pos("a.md", 1) } };

	let rejected = false;
	try {
		await queue.enqueue(first);
	} catch {
		rejected = true;
	}
	check("T6 the failed enqueue rejected its caller", rejected, "did not reject");
	check("T6 onError fired exactly once", errors.length === 1, `errors=${errors.length}`);
	check("T6 nothing was written", written.length === 0, `written=${written.length}`);
	check("T6 the queue is idle after a failure", queue.idle(), "queue not idle");

	// A later save is issued normally, and the failed payload is NOT retried: a
	// blind retry could resurrect a stale snapshot behind a newer one, which is
	// the exact class of defect this ticket closes.
	await queue.enqueue(second);
	check("T6 a following save was issued and resolved", written.length === 1, `written=${written.length}`);
	check("T6 the failed payload was not retried", written[0] === second, "the stale payload came back");
	check("T6 onError did not fire again", errors.length === 1, `errors=${errors.length}`);

	// Second shape: a rejection while a payload is pending still issues the pending
	// one, because the queue proceeds in a finally rather than on success.
	const errs2: unknown[] = [];
	const done2: PluginData[] = [];
	const gates: Array<{ reject: (e: unknown) => void; resolve: () => void; payload: PluginData }> = [];
	const q2 = new SaveQueue({
		write: (payload) =>
			new Promise<void>((resolve, reject) => {
				gates.push({
					payload,
					resolve: () => {
						done2.push(payload);
						resolve();
					},
					reject,
				});
			}),
		onError: (e) => errs2.push(e),
	});
	const p1 = q2.enqueue(first);
	const p2 = q2.enqueue(second);
	await tick();
	gates[0]?.reject(new Error("first failed"));
	await p1.then(
		() => {},
		() => {},
	);
	await tick();
	check("T6 a rejection while a payload is pending still issues the pending one", gates.length === 2, `gates=${gates.length}`);
	gates[1]?.resolve();
	await p2;
	check("T6 the pending payload was the one issued", done2.length === 1 && done2[0] === second, JSON.stringify(done2.length));
	check("T6 the failure was reported once", errs2.length === 1, `errors=${errs2.length}`);
	check("T6 the queue is idle at the end", q2.idle(), "queue not idle");
}

// =====================================================================
console.log("G1 guard: a sibling folder is not swept and not stopped");
// =====================================================================
{
	check("G1 guard: covers(Notes/AB/x.md, Notes/A) is false", covers("Notes/AB/x.md", "Notes/A") === false);
	const s = spy("Notes/AB/x.md", { "Notes/AB/x.md": pos("Notes/AB/x.md", 2) });
	applyVaultRename(s.port, "Notes/A", "Notes/B");
	check("G1 guard: a Notes/A rename does not stop a Notes/AB read", s.stops === 0, `stops=${s.stops}`);
	check(
		"G1 guard: a Notes/A rename leaves the Notes/AB key alone",
		s.positions["Notes/AB/x.md"]?.sourceOffset === 200,
		JSON.stringify(Object.keys(s.positions)),
	);
	check("G1 guard: and asks for no save", s.saves === 0, `saves=${s.saves}`);

	const d = spy("Notes/AB/x.md", { "Notes/AB/x.md": pos("Notes/AB/x.md", 2) });
	applyVaultDelete(d.port, "Notes/A");
	check("G1 guard: a Notes/A delete does not stop a Notes/AB read", d.stops === 0, `stops=${d.stops}`);
	check(
		"G1 guard: a Notes/A delete leaves the Notes/AB key alone",
		d.positions["Notes/AB/x.md"]?.sourceOffset === 200,
		JSON.stringify(Object.keys(d.positions)),
	);
}

// =====================================================================
console.log("G2 guard: covers fails closed on the empty-string edges");
// =====================================================================
{
	check("G2 guard: covers(x, x) is true", covers("x", "x") === true);
	// No queue: getFilePath() answers "", and "" must match nothing rather than
	// being swept up by every folder event.
	check("G2 guard: covers('', 'Notes') is false", covers("", "Notes") === false);
	// An empty event path must match nothing rather than everything. Note that
	// `covers("", "")` is true by reflexivity, which is why the port's stop is
	// only reached at all when a real event arrives.
	check("G2 guard: covers('Notes/a.md', '') is false", covers("Notes/a.md", "") === false);
	const s = spy("", { "Notes/a.md": pos("Notes/a.md", 1) });
	applyVaultRename(s.port, "Notes", "Archive");
	check("G2 guard: with no queue nothing is stopped", s.stops === 0, `stops=${s.stops}`);
	check("G2 guard: but the sweep still runs", s.saves === 1, `saves=${s.saves}`);
}

// =====================================================================
console.log("G3 the comparison is oldPath, never newPath (one core check, three guards)");
// =====================================================================
{
	// AGENTS.md's load-bearing half. The queue is never retargeted, so
	// getFilePath() keeps answering with the pre-rename name; a handler comparing
	// newPath would never fire on a read that is actually in progress. Also pins
	// the `covers` argument order.
	//
	// The first check below is NOT a guard: it was red pre-fix, for the same
	// reason T1's was. The other three are guards, green on both sides, and they
	// are the half that would go red if someone swapped the two arguments or
	// compared newPath to "simplify" the relation.
	const byOld = spy("Notes/A/deep.md", { "Notes/A/deep.md": pos("Notes/A/deep.md", 1) });
	applyVaultRename(byOld.port, "Notes/A", "Notes/B");
	check("G3 a rename whose OLD path covers the queue stops it", byOld.stops === 1, `stops=${byOld.stops}`);

	const byNew = spy("Notes/A/deep.md", { "Notes/B/deep.md": pos("Notes/B/deep.md", 1) });
	applyVaultRename(byNew.port, "Notes/B", "Notes/A");
	check(
		"G3 guard: a rename whose NEW path covers the queue does NOT stop it",
		byNew.stops === 0,
		`stops=${byNew.stops}`,
	);

	// Argument order, stated as a behaviour rather than as a call shape: renaming
	// one note must not stop a read of a sibling under the same parent.
	const sibling = spy("Notes/other.md", { "Notes/other.md": pos("Notes/other.md", 1) });
	applyVaultRename(sibling.port, "Notes/a.md", "Notes/b.md");
	check(
		"G3 guard: renaming one note does not stop a read of a sibling",
		sibling.stops === 0,
		`stops=${sibling.stops}`,
	);
	// The reversed-argument mistake would make a FILE event stop its FOLDER's read.
	check("G3 guard: covers(Notes, Notes/a.md) is false", covers("Notes", "Notes/a.md") === false);
}

// =====================================================================
console.log("G4 unrecognised keys survive the queue (non-negotiable 10), plus coalescing");
// =====================================================================
{
	// The queue must hand `write` the payload it was given, unchanged. It stores by
	// reference and never rebuilds, so a foreign root key has nowhere to go - but
	// that is the exact property a whitelist rebuild would break, and this is the
	// pin. Covers a coalesced pair and a failed-then-recovered write.
	const written: PluginData[] = [];
	let failNext = true;
	const queue = new SaveQueue({
		write: async (p) => {
			if (failNext) {
				failNext = false;
				throw new Error("nope");
			}
			written.push(p);
		},
		onError: () => {},
	});
	const settings = { ...DEFAULT_SETTINGS, futureSetting: "keep me" } as unknown as Settings;
	const payload: PluginData = {
		version: 2,
		settings,
		positions: { "Notes/a.md": pos("Notes/a.md", 1) },
		otherFeature: { nested: true },
	};

	await queue.enqueue(payload).catch(() => {});
	await queue.enqueue(payload);
	check("G4 guard: the payload reached write unchanged by identity", written[0] === payload, `written=${written.length}`);
	check("G4 guard: a foreign root key survived", written[0]?.otherFeature !== undefined);
	check(
		"G4 guard: a foreign settings key survived",
		(written[0]?.settings as unknown as Record<string, unknown> | undefined)?.futureSetting === "keep me",
	);
	check("G4 guard: positions survived", Object.keys(written[0]?.positions ?? {}).join(",") === "Notes/a.md");

	// A coalesced pair: the superseded payload is never written, and the one that
	// IS written still carries every foreign key.
	const w2: PluginData[] = [];
	const gates: Array<() => void> = [];
	const q2 = new SaveQueue({
		write: (p) =>
			new Promise<void>((resolve) => {
				gates.push(() => {
					w2.push(p);
					resolve();
				});
			}),
	});
	const superseded: PluginData = { ...payload, positions: {} };
	const newest: PluginData = { ...payload, positions: { "Notes/z.md": pos("Notes/z.md", 9) } };
	const gp = q2.enqueue(payload); // becomes in flight
	const sp = q2.enqueue(superseded); // pending
	const np = q2.enqueue(newest); // replaces pending
	// Drain whatever exists, however many gates the implementation opened. A
	// pass-through opens three at once, which is why this loops rather than
	// releasing a fixed pair.
	for (let i = 0; i < 6 && gates.length > 0; i++) {
		while (gates.length > 0) gates.shift()!();
		await tick();
	}
	await Promise.allSettled([gp, sp, np]);
	check("G4 (coalescing): two writes, not three", w2.length === 2, `writes=${w2.length}`);
	check("G4 (coalescing): the superseded payload was never written", !w2.includes(superseded), "it was written");
	check("G4 (coalescing): the newest payload was written last", w2[w2.length - 1] === newest, "newest missing");
	check(
		"G4 guard: the newest payload kept its foreign root key",
		(w2[w2.length - 1] as PluginData | undefined)?.otherFeature !== undefined,
	);
	// "Resolves when this payload, or one that superseded it, is written."
	const supersededResolved = await sp.then(
		() => true,
		() => false,
	);
	check("G4 (coalescing): a superseded waiter still resolved", supersededResolved, "it did not resolve");
}

// =====================================================================
console.log("G5 guard: no note text can reach a trace line (non-negotiable 1)");
// =====================================================================
{
	// The port's trace takes two plain strings and the orchestration builds them
	// from paths and counts only. The sentinel stands in for note text: it is in
	// the position values' reach but must appear in nothing traced.
	const SENTINEL = "SENSITIVE-NOTE-BODY-DO-NOT-SPEAK";
	const positions: Record<string, ReadingPosition> = {
		"Notes/A/deep.md": { ...pos("Notes/A/deep.md", 1), segmentId: SENTINEL },
		"Notes/A/other.md": { ...pos("Notes/A/other.md", 2), segmentId: SENTINEL },
	};
	const s = spy("Notes/A/deep.md", positions);
	applyVaultRename(s.port, "Notes/A", "Notes/B");
	check(
		"G5 guard: the rename trace is exactly '<old> -> <new>'",
		s.traced.join("|") === "position keys renamed: Notes/A -> Notes/B",
		s.traced.join("|"),
	);

	const d = spy("Notes/A/deep.md", { ...positions });
	applyVaultDelete(d.port, "Notes/A");
	check(
		"G5 guard: the delete trace is exactly '<path> (n)'",
		d.traced.join("|") === "position keys dropped: Notes/A (2)",
		d.traced.join("|"),
	);
	check(
		"G5 guard: the sentinel appears in nothing traced",
		![...s.traced, ...d.traced].some((line) => line.includes(SENTINEL)),
		[...s.traced, ...d.traced].join("|"),
	);
}

if (failures > 0) {
	console.log(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall vaultPersistence checks passed");
