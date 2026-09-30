import {
	covers,
	dropReadingPositions,
	moveReadingPositions,
	type ReadingPosition,
} from "./data";

/*
 * What a vault rename or delete does to a reading position and to playback.
 *
 * Extracted from main.ts for positionThrottle.ts's reason, which has not
 * changed: obsidian has no runtime (`node_modules/obsidian/package.json` is
 * `"main": ""`), so anything left in main.ts is unreachable from the bare-Node
 * suite. Both bodies shipped in NRL-51 with no automated coverage of any kind,
 * and the defect NRL-58 fixed was in the one line a unit test would have looked
 * at first.
 *
 * Everything obsidian-bound stays behind VaultEventPort: the player, the data
 * container, the save and the trace sink.
 */

export interface VaultEventPort {
	/** The queue's file path right now. "" when nothing is queued. */
	currentFilePath(): string;
	/** Stop the affected read. main.ts passes () => this.stopReading(). */
	stop(): void;
	/** The live positions map off the container. */
	positions(): Record<string, ReadingPosition>;
	/** Install a new map on the container's one `positions` field. */
	setPositions(next: Record<string, ReadingPosition>): void;
	/** Persist. Fire-and-forget; the port owns its own error reporting. */
	save(): void;
	/**
	 * Metadata only - paths and counts, never note text (non-negotiable 1).
	 * A plain (step, detail) string pair, so this module cannot reach a chunk.
	 */
	trace(step: string, detail: string): void;
}

/**
 * A vault rename carries every stored position under the old prefix.
 *
 * The order is load bearing. Stopping first is not tidiness: the queue's
 * chunks still carry the old filePath, so Player.getFilePath() keeps
 * reporting it and the next progress event would write the old key straight
 * back, about a second after this cleaned it. Stopping first means the
 * stop's own save records the final position under the old path
 * synchronously, and the re-key below moves that exact value to the new path,
 * retaining the final position in memory.
 *
 * Retargeting the queue instead was rejected on evidence: SpeechChunk.id
 * hashes filePath, so rewriting it without recomputing the id would
 * desynchronise the field from its own definition.
 *
 * The cost is visible: the audio stops, and since NRL-58 it stops for a
 * descendant of a renamed FOLDER too. An alternative is a stale position under
 * the new name and a fresh orphan, which is worse.
 *
 * A folder event reaches this same function with no branch on the type, because
 * `covers` is one relation for both and Obsidian hands the same TAbstractFile
 * either way.
 */
export function applyVaultRename(port: VaultEventPort, oldPath: string, newPath: string): void {
	// Also the guard on a double-fired folder event. Deliberately an equality
	// test and not `covers`: it is a double-fire guard, not a path relation, and
	// `covers` is reflexive so substituting it would read as if it meant more.
	if (oldPath === newPath) return;
	// oldPath, not newPath. The queue still carries the old filePath on every
	// chunk, so getFilePath() reports the pre-rename path until the next
	// play(); comparing against newPath would never match a read that is
	// actually in progress. This is the observable consequence, not a
	// theoretical one: stopReading() leaves the queue in place by design, so
	// the accessor keeps answering with the old name for as long as the
	// player lives.
	//
	// `covers`, not `===`, and the SAME predicate the sweep below uses. With
	// equality a `Notes/A` -> `Notes/B` rename re-keyed a position for a queue on
	// `Notes/A/deep.md` and left that read running, so its next progress event
	// wrote the old key straight back: measured as
	// `["Notes/A/deep.md","Notes/B/deep.md"]` one throttle window later.
	//
	// Argument order: the QUEUE path is the candidate, the EVENT path is the
	// prefix. Reversed, renaming one note would stop a read of any sibling under
	// the same parent folder.
	if (covers(port.currentFilePath(), oldPath)) port.stop();

	const before = port.positions();
	const after = moveReadingPositions(before, oldPath, newPath);
	// Identity, not equality: nothing matched, so there is nothing to write.
	if (after === before) return;

	port.setPositions(after);
	port.trace("position keys renamed", `${oldPath} -> ${newPath}`);
	port.save();
}

/**
 * A vault delete drops every stored position under the deleted path, so
 * entries cannot outlive the notes they describe.
 *
 * It does stop a read of the deleted note, and that is load-bearing rather
 * than tidiness. The queue is untouched by the delete, so the player keeps
 * reporting the deleted path and the next progress event writes that key
 * straight back - one save later, recreating exactly the orphan this handler
 * exists to remove.
 *
 * Same comparison as a rename, and for the same reason: the queue still
 * reports the old name, which for a delete is the only name it has.
 */
export function applyVaultDelete(port: VaultEventPort, path: string): void {
	// Ahead of the identity early-out below, deliberately: a folder whose subtree
	// holds no stored position still has to stop a descendant read, or "nothing to
	// write" would silently also mean "nothing to stop".
	if (covers(port.currentFilePath(), path)) port.stop();

	const before = port.positions();
	const after = dropReadingPositions(before, path);
	if (after === before) return;

	port.setPositions(after);
	port.trace(
		"position keys dropped",
		`${path} (${Object.keys(before).length - Object.keys(after).length})`,
	);
	port.save();
}
