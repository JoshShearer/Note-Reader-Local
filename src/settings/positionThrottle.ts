/*
 * The reading-position throttle, extracted so it can be tested.
 *
 * Two things forced it out of main.ts. First, obsidian has no runtime
 * (`node_modules/obsidian/package.json` is `"main": ""`), so anything in
 * main.ts is unreachable from the bare-Node suite and "at least on stop, on
 * pause and on chunk advance" would ship unverified. Second, the window needs a
 * clock the test controls, and a module that reaches for `window.setTimeout`
 * cannot have one.
 *
 * Leading edge plus a trailing flush, with the value in between recorded rather
 * than replayed. See flush() for why the capture matters.
 */

export interface PositionThrottleOptions {
	/** Write the position for a chunk index. Never awaited here. */
	save: (chunkIndex: number) => void;
	/**
	 * The queue's file path right now, read at the moment of writing. Used to
	 * refuse a captured index that no longer belongs to the queue in hand.
	 */
	currentFilePath: () => string;
	/** Window length. Only overridden by tests that need the edge. */
	intervalMs?: number;
	/** Injected so the test owns the clock. Defaults to the global timers. */
	timers?: {
		setTimeout: (fn: () => void, ms: number) => unknown;
		clearTimeout: (handle: unknown) => void;
	};
}

/** A progress event that has not been written yet. Newest wins. */
interface PendingPosition {
	filePath: string;
	chunkIndex: number;
}

const DEFAULT_INTERVAL_MS = 1000;

export class PositionThrottle {
	private handle: unknown = null;
	private pending: PendingPosition | null = null;
	// Not derivable from handle/pending: after dispose() both are null and the
	// state looks exactly like a fresh instance, so a late event would arm a
	// window that nothing will ever close.
	private disposed = false;
	private readonly intervalMs: number;
	private readonly timers: NonNullable<PositionThrottleOptions["timers"]>;

	constructor(private readonly options: PositionThrottleOptions) {
		this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
		this.timers = options.timers ?? {
			setTimeout: (fn, ms) => setTimeout(fn, ms),
			clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
		};
	}

	/**
	 * Record a progress event. Saves immediately if no window is open, and
	 * otherwise leaves it for the flush.
	 *
	 * The leading save is synchronous so the position is in `pluginData` before
	 * this returns; only the disk write is outstanding. A caller that stopped
	 * reading immediately after this event has not lost it.
	 */
	note(filePath: string, chunkIndex: number): void {
		if (this.disposed) return;
		if (this.handle === null) {
			this.handle = this.timers.setTimeout(() => {
				// Null the handle first: flush() clears it, and it is the
				// non-null handle that means "a window is open".
				this.handle = null;
				this.flush();
			}, this.intervalMs);
			// Leading edge, and the value just recorded is the one written, so
			// there is nothing left pending.
			this.options.save(chunkIndex);
			return;
		}
		this.pending = { filePath, chunkIndex };
	}

	/**
	 * Write the value the leading edge did not, and close the window.
	 *
	 * Callers reach this on every state change that ends the user's attention -
	 * pause, stop, natural finish - and on unload. That is what makes a Stop
	 * safe: `stopReading()` runs player.stop(), which sets state to "idle", which
	 * calls this synchronously, so the final position is written BY the stop
	 * rather than by a timer that a teardown might cancel. The write happens
	 * before the pending record is cleared and before the timer is disarmed, so
	 * there is no ordering in which a cancellation can drop it.
	 *
	 * The captured index is written, never getIndex(). On natural completion
	 * getIndex() is chunks.length, which resolves to no chunk and would lose the
	 * last position anyway.
	 */
	flush(): void {
		// The one window that is allowed to close during dispose() is this one.
		// Refusing a second flush would drop the pending value instead.
		if (this.disposed) return;
		if (this.handle !== null) {
			this.timers.clearTimeout(this.handle);
			this.handle = null;
		}
		const pending = this.pending;
		this.pending = null;
		// Nothing was dropped: the leading edge already wrote the newest value.
		if (!pending) return;
		// Belt and braces. main.ts flushes on every state change, which closes the
		// window at each one, so a captured index should never outlive its queue.
		// If it somehow does, the index belongs to a queue that is gone and
		// writing it under the new note's key would be a silent corruption.
		if (this.options.currentFilePath() !== pending.filePath) return;
		this.options.save(pending.chunkIndex);
	}

	/**
	 * Flush, then refuse everything afterwards.
	 *
	 * Called from onunload. The flush comes first and is not gated on the
	 * disposed flag, because this is the one chance to write the pending value
	 * and losing it would be the last position the user ever had. The flag then
	 * covers the case dispose() cannot: a progress event already in flight
	 * behind an audio element that settles after the plugin is gone, which
	 * would otherwise arm a window nothing will ever close. Before this module
	 * existed the window handle was not cleared anywhere at all.
	 */
	dispose(): void {
		this.flush();
		this.disposed = true;
	}
}
