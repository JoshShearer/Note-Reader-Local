import type { ChangeSet } from "@codemirror/state";

/**
 * Where text that was read from a note at one moment is now, after the note
 * has been edited since.
 *
 * Offsets are recorded against a revision: the number of edits the tracker had
 * seen when the offsets were read. Mapping an offset carries it across every
 * edit since that revision, so a sentence or word keeps its place when text is
 * typed before it, and grows or shrinks when text is typed or deleted inside
 * it. No document text is kept, only the changes.
 *
 * No `obsidian` import, so it runs in the bare-Node suite.
 */
export class EditTracker {
	private readonly steps: ChangeSet[] = [];
	/** Edits from a revision up to the latest, composed once and extended as more arrive. */
	private readonly composed = new Map<number, { upTo: number; set: ChangeSet }>();
	/** Set when an edit could not be combined with the rest; offsets are then left where they were. */
	broken = false;

	/** How many edits have been seen. A fresh extraction is stamped with this. */
	get revision(): number {
		return this.steps.length;
	}

	/** Note one edit, in the order the note received them. */
	record(changes: ChangeSet): void {
		this.steps.push(changes);
	}

	/**
	 * Carry `offset` from revision `fromRev` to revision `toRev` (default: now).
	 *
	 * `assoc` decides what an insertion exactly at the offset does: +1 puts the
	 * offset after the inserted text (the start of a range), -1 before it (the
	 * end of a range), so text typed at either edge of a sentence stays outside
	 * it while text typed inside it stays inside.
	 */
	map(offset: number, fromRev: number, assoc: 1 | -1, toRev: number = this.steps.length): number {
		if (this.broken || fromRev >= toRev) return offset;
		try {
			const set = this.compose(fromRev, toRev);
			return set ? set.mapPos(offset, assoc) : offset;
		} catch {
			// A change that does not line up with the others (a missed edit):
			// stop mapping rather than put highlights in the wrong place.
			this.broken = true;
			return offset;
		}
	}

	/** A range carried forward, or null when everything in it was deleted. */
	mapRange(from: number, to: number, fromRev: number): { from: number; to: number } | null {
		const start = this.map(from, fromRev, 1);
		const end = this.map(to, fromRev, -1);
		return end > start ? { from: start, to: end } : null;
	}

	private compose(fromRev: number, toRev: number): ChangeSet | null {
		const toNow = toRev === this.steps.length;
		let set: ChangeSet | null = null;
		let i = fromRev;
		const cached = toNow ? this.composed.get(fromRev) : undefined;
		if (cached) {
			set = cached.set;
			i = cached.upTo;
		}
		for (; i < toRev; i++) {
			const step = this.steps[i]!;
			set = set ? set.compose(step) : step;
		}
		if (toNow && set) this.composed.set(fromRev, { upTo: toRev, set });
		return set;
	}
}
