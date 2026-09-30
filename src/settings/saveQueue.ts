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
 *
 * RETRY (NRL-91). A rejected write is still never blindly replayed - the
 * rejected payload itself is discarded, exactly as before. What changed is
 * that, if the caller supplies `getCurrentPayload`, a failure now schedules a
 * short capped retry that calls `getCurrentPayload()` FRESH at the moment it
 * fires, never the stale object that was rejected. This cannot resurrect old
 * state: a retry always reads live truth, so it can only ever write something
 * at least as new as what failed. When `getCurrentPayload` is omitted, the
 * class behaves exactly as it did before this ticket - one attempt, one
 * `onError`, no retry - which is what keeps every pre-NRL-91 construction
 * site compiling and behaving unchanged. `onError` itself is REPURPOSED: it
 * used to fire once per rejected write, and now fires once per write that
 * could not be saved even after exhausting retries (or immediately, exactly
 * as before, when there is no retry budget to exhaust). See
 * docs/adr/0026 for the accepted bound this still leaves at onunload.
 */

export interface SaveQueueOptions {
	/** The durable write. Never called re-entrantly. */
	write: (payload: PluginData) => Promise<void>;
	/**
	 * Called once per write that could not be saved even after exhausting
	 * retries (or immediately, when `getCurrentPayload` is not supplied and
	 * there is no retry to exhaust). Metadata only, never note text.
	 */
	onError?: (err: unknown) => void;
	/**
	 * Returns the CURRENT live payload to retry with, read fresh each time a
	 * retry fires - never the stale payload that was rejected. Optional. When
	 * absent, a rejected write is reported once through `onError` and not
	 * retried: the exact pre-NRL-91 behaviour, byte for byte.
	 */
	getCurrentPayload?: () => PluginData;
	/**
	 * Fires on every individual failed attempt, including ones a retry will
	 * follow. Metadata only (an attempt number and the error), never a
	 * payload and never note text - the quiet per-attempt channel `onError`
	 * used to be before it was repurposed to mean "exhausted".
	 */
	onAttemptFailed?: (err: unknown, attempt: number) => void;
	/** Caps and timing for the retry schedule. Both optional; see the module
	 * constants below for the defaults. */
	retry?: {
		maxAttempts?: number;
		baseBackoffMs?: number;
	};
	/** Injected so tests own the clock, the same shape PositionThrottle uses.
	 * Defaults to the real global timers. */
	timers?: {
		setTimeout: (fn: () => void, ms: number) => unknown;
		clearTimeout: (handle: unknown) => void;
	};
}

/**
 * 3 capped attempts at 500/1000/2000ms (exponential doubling from the base),
 * a worst-case added delay of 3500ms before giving up. Chosen to give genuine
 * resilience against a momentary transient failure (disk contention, a slow
 * adapter) while staying short enough not to meaningfully widen the onunload
 * race docs/adr/0026 accepts - not derived from a measured failure-rate
 * distribution, because Obsidian's real saveData() has never been observed to
 * reject in this codebase's history (NOT VERIFIED IN OBSIDIAN).
 */
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BACKOFF_MS = 500;

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
	/** How many retries have been scheduled for the CURRENT failure episode.
	 * Reset to 0 on any success and on any real enqueue() superseding a
	 * scheduled retry, so a later, unrelated failure starts a fresh budget. */
	private retryAttempt = 0;
	/** The armed backoff timer, if a retry is currently scheduled. */
	private retryTimer: unknown | null = null;
	private readonly timers: NonNullable<SaveQueueOptions["timers"]>;
	private readonly maxAttempts: number;
	private readonly baseBackoffMs: number;

	constructor(private readonly options: SaveQueueOptions) {
		this.timers = options.timers ?? {
			setTimeout: (fn, ms) => setTimeout(fn, ms),
			clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
		};
		this.maxAttempts = options.retry?.maxAttempts ?? DEFAULT_MAX_RETRIES;
		this.baseBackoffMs = options.retry?.baseBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
	}

	/** Resolves when this payload, or one that superseded it, is written. */
	enqueue(payload: PluginData): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			if (this.retryTimer !== null) {
				// A real, externally-driven save always supersedes a scheduled
				// synthetic retry: cancel it and start the next failure's budget
				// from zero, rather than letting a stale timer fire later and
				// double-write behind this newer, real enqueue.
				this.timers.clearTimeout(this.retryTimer);
				this.retryTimer = null;
				this.retryAttempt = 0;
			}
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

	/** False while a retry is armed, not only while a write is running or
	 * queued: a drain() must not report done with a synthetic write still to
	 * come. */
	idle(): boolean {
		return !this.running && this.pending === null && this.retryTimer === null;
	}

	/**
	 * Clear the armed retry timer, if any - and nothing else.
	 *
	 * Deliberately narrow (NRL-91, docs/adr/0026): an in-flight write
	 * (`running`) or a payload already queued behind it (`pending`) are left
	 * EXACTLY as they are. Obsidian's `onunload(): void` is synchronous and
	 * gives no hook to await or cancel a write already handed to `write()`,
	 * so this closes the one NEW resource this ticket introduces - a leaked
	 * timer pointing at a plugin instance about to be torn down - and makes
	 * no attempt at the wider, unfixable problem. Safe to call at any time,
	 * including when nothing is armed.
	 */
	dispose(): void {
		if (this.retryTimer !== null) {
			this.timers.clearTimeout(this.retryTimer);
			this.retryTimer = null;
		}
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
	 * A rejected write must not wedge the queue, so `running` is cleared on
	 * both paths. The REJECTED payload itself is never retried - a blind
	 * replay could resurrect a stale snapshot behind a newer one, which is the
	 * exact class of defect this class exists to prevent. What CAN happen now
	 * (NRL-91) is a retry that reads a fresh payload at the moment it fires,
	 * via `scheduleRetry` below, and only when the caller opted in with
	 * `getCurrentPayload`.
	 */
	private finish(failure: { err: unknown } | null): void {
		const waiters = this.runningWaiters;
		this.runningWaiters = [];
		this.running = false;

		if (!failure) {
			// A success ends the current failure episode: the next unrelated
			// failure gets its own full budget, not whatever was left over.
			this.retryAttempt = 0;
			for (const waiter of waiters) waiter.resolve();
			this.pump();
			return;
		}

		// Metadata only, every attempt, whether or not a retry follows - the
		// quiet channel `onError` used to be before its semantics moved to
		// "exhausted".
		try {
			this.options.onAttemptFailed?.(failure.err, this.retryAttempt + 1);
		} catch {
			// Reporting is best-effort; it must never wedge the queue.
		}

		if (!this.options.getCurrentPayload) {
			// No retry mechanism configured: the exact pre-NRL-91 behaviour.
			// `onError` fires before the waiters reject, so a throwing reporter
			// cannot be mistaken for the write's own failure.
			try {
				this.options.onError?.(failure.err);
			} catch {
				// Reporting is best-effort; it must never wedge the queue.
			}
			for (const waiter of waiters) waiter.reject(failure.err);
			this.pump();
			return;
		}

		// A retry is possible. The CURRENT write's waiters still reject
		// immediately on this first rejection - every existing
		// `await saveSettings()` call site keeps its exact promise semantics -
		// but the queue itself keeps trying with a fresh payload read at retry
		// time, so it can never write something older than what just failed.
		for (const waiter of waiters) waiter.reject(failure.err);
		this.scheduleRetry(failure.err);
	}

	/**
	 * Arm a retry, or give up if the budget is exhausted.
	 *
	 * Only reached when `getCurrentPayload` was supplied - see `finish()`.
	 * `onError` fires here, not in `finish()`, which is the whole of the
	 * repurposing: once per write that could not be saved even after
	 * exhausting retries, rather than once per rejected attempt.
	 */
	private scheduleRetry(err: unknown): void {
		if (this.retryAttempt >= this.maxAttempts) {
			try {
				this.options.onError?.(err);
			} catch {
				// Reporting is best-effort; it must never wedge the queue.
			}
			this.retryAttempt = 0;
			this.pump();
			return;
		}
		const backoffMs = this.baseBackoffMs * 2 ** this.retryAttempt;
		this.retryAttempt += 1;
		const getCurrentPayload = this.options.getCurrentPayload!;
		this.retryTimer = this.timers.setTimeout(() => {
			this.retryTimer = null;
			// Fresh, not the stale rejected payload: read live truth at the
			// moment the retry actually fires, never replay what failed.
			this.pending = getCurrentPayload();
			this.pump();
		}, backoffMs);
	}
}
