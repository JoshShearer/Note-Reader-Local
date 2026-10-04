/*
 * The dismissal POLICY for the "Loading X..." Notice, extracted so it can be
 * tested (NRL-65).
 *
 * It holds no Notice. `new Notice(...)` is an `obsidian` import and stays in
 * main.ts, which has no runtime in the bare-Node suite
 * (`node_modules/obsidian/package.json` is `"main": ""`), so the only way the
 * question "when is hide() called" can be answered by a test at all is to make
 * the *when* a separate, obsidian-free thing that takes a handle. `obsidian`'s
 * `Notice.hide(): void` satisfies `Dismissable` structurally, so main.ts needs
 * no cast and this file needs no obsidian types.
 *
 * WHAT IT FIXES. The Notice is built with `duration 0`, so it never
 * self-dismisses, and it used to be hidden in a `finally` attached to the load
 * itself. A Stop abandons that load rather than cancelling it (docs/adr/0013),
 * so the hide fired only when the abandoned load eventually settled - seconds
 * later on a cold Kokoro boot. Measured in a bare-Node transcription of
 * main.ts's own block driven through the real `playWithFallback`: SHOW +6 ms,
 * Stop +58 ms, resolve null +59 ms, HIDE +357 ms of a 350 ms load. The Notice
 * outlived the read it was announcing and read as "Stop did not work".
 *
 * WHAT IT DOES NOT CHANGE. ADR 0013 is untouched. `prepare()` still takes no
 * signal, the load is still ABANDONED rather than cancelled, the bytes keep
 * arriving and a finished model is still kept for the next read. The signal
 * here dismisses the NOTICE and nothing else: `work` is awaited to exactly the
 * same completion, and its value and its rejection both pass through unchanged
 * so `playWithFallback`'s `raceAbort` still sees a load failure as a load
 * failure.
 *
 * PRIVACY (AGENTS.md non-negotiable 1) falls out of the signature rather than
 * being enforced by a check: this module never receives a string. There is no
 * text-shaped argument anywhere in `withLoadingNotice` or in `Dismissable`, so
 * there is nothing here that could log, carry or leak note text. The one string
 * in the whole feature is `candidate.engine.label`, and it stays inside
 * main.ts's `show()` closure.
 *
 * UNVERIFIED, and it stays unverified until someone drives a real Obsidian:
 * whether obsidian's own `Notice` behaves the way this rests on - that a Notice
 * constructed with `duration 0` never self-dismisses, and that `hide()` called
 * once at an arbitrary moment removes it cleanly. That is not a gap in what the
 * tests cover, it is outside what they can cover: everything below is about
 * WHEN `hide()` is called, which a fake `Dismissable` observes exactly, and
 * nothing below is about what the host then does to the DOM. CDP port 9222 has
 * been refused for every recent ticket in this repo, so nothing here was seen
 * on screen.
 */

/** Anything with a `hide()`. `obsidian`'s `Notice` is one, structurally. */
export interface Dismissable {
	hide(): void;
}

/**
 * Show a loading indication, run `work`, and dismiss the indication at
 * whichever comes first: `work` settling, or `signal` aborting.
 *
 * `work` is a THUNK rather than a promise for two reasons. The module controls
 * that the load starts AFTER the indication is up, so the ordering cannot drift
 * at a call site. And a thunk that throws synchronously is catchable here - the
 * type says it returns a promise but nothing enforces that at a JS call site,
 * and a sync throw would otherwise escape with the Notice still on screen,
 * which is the exact defect this module exists to close, arriving by a
 * different door.
 *
 * ALREADY ABORTED ON ENTRY: `show()` is not called at all, and `work()` is
 * still called exactly once. This window is reachable - `playWithFallback`
 * checks `signal.aborted` and then calls `beforeAttempt`, but main.ts awaits
 * two voice lookups before reaching here, so a Stop can land in between.
 * Constructing an indication and hiding it in the same turn is a visible flash
 * whose appearance depends on host behaviour nobody has verified (see the
 * UNVERIFIED note above), whereas not constructing it changes nothing at all
 * about when the load starts or finishes, which is what keeps ADR 0013's
 * "abandoned, not cancelled" contract byte-identical.
 *
 * IDEMPOTENT IN BOTH ORDERS, and the three parts are not redundant with each
 * other:
 *   - the captured `hidden` boolean guards the CROSS-PATH double call, i.e. the
 *     abort listener and the `.finally` both reaching `dismiss()`;
 *   - `{ once: true }` self-removes the listener if the `.finally` never runs;
 *   - `removeEventListener` in the `.finally` is what stops a read with N
 *     candidates accumulating N listeners on the one long-lived `scope.signal`,
 *     the same reason `raceAbort` removes its own (`src/audio/fallback.ts`).
 *
 * `hidden` is set BEFORE `notice.hide()`, so a host `hide()` that threw could
 * not be retried into a second call. That throw is deliberately not caught,
 * matching `raceAbort`'s no-defensive-catch style: a throwing `Notice.hide()`
 * is not a shape anyone has seen, and swallowing it would hide a real host bug.
 */
export function withLoadingNotice<T>(
	show: () => Dismissable,
	work: () => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	if (signal?.aborted) return invoke(work);

	const notice = show();
	let hidden = false;
	const dismiss = (): void => {
		if (hidden) return;
		hidden = true;
		notice.hide();
	};

	let onAbort: (() => void) | undefined;
	if (signal) {
		onAbort = dismiss;
		signal.addEventListener("abort", onAbort, { once: true });
	}

	// `.finally` rather than `.then`: it preserves both the resolution value
	// and the rejection, so a load failure still reaches `raceAbort` as a load
	// failure rather than being converted into anything here.
	return invoke(work).finally(() => {
		dismiss();
		if (signal && onAbort) signal.removeEventListener("abort", onAbort);
	});
}

/** Call the thunk, converting a synchronous throw into a rejection. */
function invoke<T>(work: () => Promise<T>): Promise<T> {
	try {
		return work();
	} catch (err) {
		// eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- converts a synchronous throw into a rejection carrying the identical value, so raceAbort sees the same failure either way; wrapping it would change it
		return Promise.reject(err);
	}
}
