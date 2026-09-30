import type { PluginData } from "./data";

/*
 * The one funnel for every durable write, so an older snapshot cannot land after
 * a newer one.
 *
 * Before this, saveSettings() awaited saveData() directly and nothing ordered
 * the writes. Two overlapping writes released in reverse order were measured
 * landing in reverse: the durable order was [w1, w0] against an enqueue order of
 * [w0, w1], and after a rename of `Notes/A/deep.md` to `Notes/A/renamed.md` the
 * disk held `["Notes/A/deep.md"]` - the orphan key the rename handler had just
 * removed, put back by the earlier write that was still in flight. A delete
 * resurrected its key the same way.
 *
 * WHY AN OLDER PAYLOAD CAN CARRY OLDER STATE AT ALL, since a shallow snapshot
 * looks like it should be retroactively correct. `serialisePluginData` returns a
 * NEW container each call (`{ ...data, settings }`), so two saves in flight hold
 * two distinct containers. `positions[filePath] = position` mutates the shared
 * nested map in place, which is additive and newest-wins, so that direction is
 * harmless. But the vault handlers REPLACE the `positions` field with a whole new
 * map, and that replacement lands on the newest container only. The older
 * container in flight goes on pointing at the pre-rename map. That identity
 * difference is the whole defect.
 *
 * Obsidian-free, like positionThrottle.ts and for the same reason: obsidian has
 * no runtime (`node_modules/obsidian/package.json` is `"main": ""`), so anything
 * left in main.ts is unreachable from the bare-Node suite.
 *
 * SINGLE-FLIGHT WITH COALESCING, newest wins, matching PositionThrottle's
 * existing semantics. At most one write in flight and at most one payload
 * pending; a second enqueue arriving while one is already pending replaces it and
 * the replaced payload is never written. This is not merely a reordering fix: the
 * reversal becomes unexpressible, because the second write is not issued until
 * the first has settled, so no storage layer is ever given two gates to settle
 * out of order.
 *
 * Non-negotiable 10 is satisfied by construction and must stay that way: a
 * payload is stored BY REFERENCE and handed to `write` unchanged. Nothing here
 * rebuilds a container, so a root key this build does not recognise cannot be
 * dropped on the way through.
 */

export interface SaveQueueOptions {
	/** The durable write. Never called re-entrantly. */
	write: (payload: PluginData) => Promise<void>;
	/** Called once per rejected write. Metadata only, never note text. */
	onError?: (err: unknown) => void;
}

interface Waiter {
	resolve: () => void;
	reject: (err: unknown) => void;
}

export class SaveQueue {
	/** True from the moment `write` is called until its promise settles. */
	private running = false;
	/** The newest payload not yet issued. Newest wins. */
	private pending: PluginData | null = null;
	/**
	 * Waiters on `pending`. A list rather than one waiter, and they SURVIVE a
	 * replacement: a superseding payload is a strict successor in time, so "my
	 * state is on disk" is still true once it lands, which is what keeps the
	 * plugin's `await saveSettings()` call sites honest without letting the queue
	 * grow past one pending payload.
	 */
	private pendingWaiters: Waiter[] = [];
	/** Waiters on the write currently running. */
	private runningWaiters: Waiter[] = [];
	private drainWaiters: Array<() => void> = [];

	constructor(private readonly options: SaveQueueOptions) {}

	/** Resolves when this payload, or one that superseded it, is written. */
	enqueue(payload: PluginData): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			this.pending = payload;
			this.pendingWaiters.push({ resolve, reject });
			if (!this.running) this.pump();
		});
	}

	/** Settles when nothing is in flight and nothing is pending. */
	drain(): Promise<void> {
		if (this.idle()) return Promise.resolve();
		return new Promise<void>((resolve) => {
			this.drainWaiters.push(resolve);
		});
	}

	idle(): boolean {
		return !this.running && this.pending === null;
	}

	/** Issue the pending payload, or report idle if there is none. */
	private pump(): void {
		const payload = this.pending;
		if (payload === null) {
			const waiting = this.drainWaiters;
			this.drainWaiters = [];
			for (const resolve of waiting) resolve();
			return;
		}
		this.pending = null;
		this.runningWaiters = this.pendingWaiters;
		this.pendingWaiters = [];
		this.running = true;

		let result: Promise<void>;
		try {
			// A `write` that throws synchronously must settle this write like any
			// other rejection, or `running` would stay true and wedge the queue.
			result = this.options.write(payload);
		} catch (err) {
			result = Promise.reject(err);
		}
		void result.then(
			() => this.finish(null),
			(err: unknown) => this.finish({ err }),
		);
	}

	/**
	 * Settle the write that just finished and move on, whatever its outcome.
	 *
	 * A rejected write must not wedge the queue, so `running` is cleared and
	 * `pump()` is called on both paths. The failed payload is NOT retried: a blind
	 * retry could resurrect a stale snapshot behind a newer one, which is the
	 * exact class of defect this class exists to prevent, and the next real save
	 * carries newer state anyway.
	 */
	private finish(failure: { err: unknown } | null): void {
		const waiters = this.runningWaiters;
		this.runningWaiters = [];
		this.running = false;

		if (failure) {
			// Exactly once per rejected write, and before the waiters, so a
			// throwing reporter cannot be mistaken for the write's own failure.
			try {
				this.options.onError?.(failure.err);
			} catch {
				// Reporting is best-effort; it must never wedge the queue.
			}
			for (const waiter of waiters) waiter.reject(failure.err);
		} else {
			for (const waiter of waiters) waiter.resolve();
		}
		this.pump();
	}
}
