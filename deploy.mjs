/**
 * Copy the built plugin into a vault so it can be loaded and tried.
 *
 * Usage: node deploy.mjs [vaultPath]
 * Defaults to ~/Documents/Notes, which is the vault on this machine.
 */

import { cp, mkdir, access, readdir, rm, stat } from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Exactly what Obsidian's own installer fetches for a directory install. The
 * list is module-scope rather than inline in the copy loop because the prune
 * below has to test membership of the same set the loop walks: two copies of it
 * would drift, and the direction that drift breaks in is "delete the file we
 * just wrote".
 */
const SHIPPED = ["main.js", "manifest.json", "styles.css"];

/**
 * Protected by NAME, never by "it does not look like a build artifact".
 * `data.json` is the user's settings AND every stored reading position, so
 * deleting it is the one mistake in this script that costs them something they
 * cannot rebuild (AGENTS.md non-negotiable 10). Any dot-prefixed entry is kept
 * too, which covers the pipeline's `.deployed-from` marker without this script
 * having to know about files another tool owns.
 */
const KEEP_BY_NAME = new Set(["data.json"]);

const vault = path.resolve(process.argv[2] ?? path.join(homedir(), "Documents", "Notes"));
const dest = path.join(vault, ".obsidian", "plugins", "local-tts-reader");

try {
	await access(path.join(vault, ".obsidian"));
} catch {
	console.error(`Not a vault (no .obsidian folder): ${vault}`);
	process.exit(1);
}

/**
 * A `/run-tickets` lane deploys only the merged base, and only while holding the
 * one deploy slot. The vault is the owner's real one - their notes, settings and
 * reading positions - so an unattended agent deploying an unmerged build there
 * is the lane's one real side effect outside the repo. A prompt saying "do not
 * deploy" does not survive between tool calls; this check runs in the process
 * that would do it.
 *
 * The lane is recognised by the marker the shared ticket-ops writes into the
 * lane's own git admin directory (`<git-dir>/run-tickets-lane`, JSON `{runId,
 * lock, base, primary}`): it is never a tracked or untracked file, so it cannot
 * dirty the lane, and `git worktree remove` deletes it with the lane. The slot
 * is `.claude/deploy.lock/` in the primary; ticket-ops' `lock --take` writes its
 * `owner` file as the lane's toplevel on line 1 and `... purpose=run <runId>` on
 * line 2, so the lane holds the slot only when both name it. The primary
 * checkout and the interactive `-nrl-*` worktrees carry no marker and deploy
 * exactly as before.
 *
 * Returns why the deploy is refused, or null to proceed.
 */
function runLaneRefusal(cwd) {
	const git = (...args) =>
		execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	let gitdir;
	try {
		gitdir = git("rev-parse", "--absolute-git-dir");
	} catch {
		return null; // not a git checkout at all, so not a lane
	}
	let marker;
	try {
		marker = JSON.parse(readFileSync(path.join(gitdir, "run-tickets-lane"), "utf8"));
	} catch (err) {
		if (err && err.code === "ENOENT") return null;
		return `the run-tickets lane marker in ${gitdir} is unreadable, so the slot cannot be checked`;
	}
	if (!marker || typeof marker !== "object" || typeof marker.runId !== "string" || typeof marker.base !== "string")
		return `the run-tickets lane marker in ${gitdir} is malformed, so the slot cannot be checked`;
	if (typeof marker.lock !== "string") return "the run has no deploy slot configured, so a lane may not deploy";
	let lane;
	try {
		lane = realpathSync(git("rev-parse", "--show-toplevel"));
	} catch (err) {
		return `git could not name this lane: ${err instanceof Error ? err.message : err}`;
	}
	let owner;
	try {
		owner = readFileSync(path.join(marker.lock, "owner"), "utf8").split("\n");
	} catch {
		return `this lane does not hold the deploy slot ${marker.lock}`;
	}
	let holder = null;
	try {
		holder = realpathSync(owner[0].trim());
	} catch {
		// a holder path that no longer exists cannot be this lane
	}
	if (holder !== lane)
		return `the deploy slot ${marker.lock} is held by ${owner[0].trim() || "(empty owner)"}, not this lane`;
	if (!(owner[1] ?? "").includes(`purpose=run ${marker.runId}`))
		return `the deploy slot ${marker.lock} names this lane but not run ${marker.runId}`;
	try {
		if (git("status", "--porcelain") !== "") return "the lane has uncommitted changes";
		const head = git("rev-parse", "HEAD");
		const base = git("rev-parse", marker.base);
		if (head !== base) return `HEAD ${head} is not ${marker.base} (${base}): a lane deploys merged code only`;
	} catch (err) {
		return `git could not confirm the lane is at its base: ${err instanceof Error ? err.message : err}`;
	}
	return null;
}

const refusal = runLaneRefusal(process.cwd());
if (refusal !== null) {
	console.error(`Refusing to deploy from a /run-tickets lane: ${refusal}`);
	process.exit(1);
}

// The plugin directory is never deleted and recreated wholesale, because it
// also holds data.json and the pipeline's .deployed-from marker. It is pruned
// entry by entry against the allowlist above instead.
await mkdir(dest, { recursive: true });

// A directory install is exactly these three files. "ort" is deliberately
// absent: ADR 0028 packs the ONNX runtime into main.js, and nothing reads a
// plugin-folder ort/ at all, since paths.ts roots ortFile at the user's model
// directory. kokoro-worker.js is different - paths.ts does root workerPath at
// the plugin folder and kokoro.ts reads it as a fallback when the inlined
// worker code is absent - and it is still pruned rather than copied, because
// esbuild deletes it after inlining and `npm run deploy` runs a production
// build first, so this script can never have a legitimately fresh one to copy.
for (const item of SHIPPED) {
	await cp(item, path.join(dest, item), { recursive: true });
	console.log(`  ${item}`);
}

/** Recursive sum of the regular files under `target`, so a stale ort/ reports
 * the ~32 MB it is really holding rather than a directory inode size. */
async function byteSize(target) {
	const info = await stat(target);
	if (!info.isDirectory()) return info.isFile() ? info.size : 0;
	let total = 0;
	for (const entry of await readdir(target, { withFileTypes: true })) {
		total += await byteSize(path.join(target, entry.name));
	}
	return total;
}

// Prune AFTER the copy, not before: the shipped set is then definitionally on
// disk, so a failure here can never leave the destination without a loadable
// plugin. Top level only - SHIPPED holds no directories, so any directory
// present is wholly stale and descending into one adds log noise, not safety.
for (const entry of await readdir(dest, { withFileTypes: true })) {
	const name = entry.name;
	if (SHIPPED.includes(name) || KEEP_BY_NAME.has(name) || name.startsWith(".")) continue;
	const full = path.join(dest, name);
	try {
		const bytes = await byteSize(full);
		// force: false, so a race that removes the entry first is reported
		// rather than swallowed. A deploy that cannot clean its own destination
		// has to say so: the whole point of the prune is that nobody is left
		// diagnosing a stale build against a folder holding three dates of
		// artifacts.
		await rm(full, { recursive: true, force: false });
		console.log(`  removed ${name}${entry.isDirectory() ? "/" : ""} (${bytes} bytes)`);
	} catch (err) {
		console.error(`Failed to remove ${full}: ${err instanceof Error ? err.message : err}`);
		process.exit(1);
	}
}

console.log(`\nDeployed to ${dest}`);
console.log("Enable it in Settings -> Community plugins, then reload Obsidian.");
