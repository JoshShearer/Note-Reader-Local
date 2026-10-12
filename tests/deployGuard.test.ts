/**
 * The /run-tickets lane guard in deploy.mjs.
 *
 * `npm run deploy` writes into the owner's real vault, and the pipeline runs
 * unattended, so the rule "a lane deploys merged code only, and only while it
 * holds the deploy slot" is enforced by deploy.mjs itself and pinned here. The
 * lane is the one the shared claude-workflow ticket-ops marks with
 * `<git-dir>/run-tickets-lane` (JSON {runId, lock, base, primary}); the slot is
 * held when `<lock>/owner` names the lane on line 1 and `purpose=run <runId>`
 * on line 2, the format ticket-ops' `lock --take` writes.
 *
 * Everything runs in a throwaway sandbox: a bare `origin`, a primary clone and
 * linked worktrees. Git runs with an isolated config (no signing, no hooks, no
 * owner identity), and no path under the home directory is ever constructed:
 * deploy.mjs's default target is the owner's real vault, so every deploy here
 * names a sandbox vault explicitly.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "../..");
const DEPLOY = path.join(ROOT, "deploy.mjs");
const RUN_ID = "2026-10-12T10:00:00Z";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
	if (cond) console.log(`  ok   ${name}`);
	else {
		failures += 1;
		console.log(`  FAIL ${name} ${detail}`);
	}
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "nrl-deploy-guard-"));
const origin = path.join(sandbox, "origin.git");
const primary = path.join(sandbox, "primary");
const lane = path.join(sandbox, "primary-run-20261012-100000");
const interactive = path.join(sandbox, "primary-nrl-1");
const gitconfig = path.join(sandbox, "gitconfig");
fs.writeFileSync(
	gitconfig,
	"[user]\n\tname = Sandbox\n\temail = sandbox@example.invalid\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n[core]\n\thooksPath = /dev/null\n",
);

const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1" };
delete env.GIT_DIR;
delete env.GIT_WORK_TREE;

function sh(cwd: string, bin: string, args: string[]): { code: number; out: string } {
	const r = spawnSync(bin, args, { cwd, env, encoding: "utf8" });
	return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
function git(cwd: string, ...args: string[]): string {
	const r = sh(cwd, "git", args);
	if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.out}`);
	return r.out.trim();
}

try {
	git(sandbox, "init", "-q", "--bare", "-b", "main", origin);
	fs.mkdirSync(primary);
	git(primary, "init", "-q", "-b", "main");
	fs.writeFileSync(path.join(primary, ".gitignore"), "main.js\n");
	fs.writeFileSync(path.join(primary, "manifest.json"), '{"id":"sandbox"}\n');
	fs.writeFileSync(path.join(primary, "styles.css"), "/* sandbox */\n");
	fs.writeFileSync(path.join(primary, "a.txt"), "base\n");
	git(primary, "add", "-A");
	git(primary, "commit", "-q", "-m", "base");
	git(primary, "remote", "add", "origin", origin);
	git(primary, "push", "-q", "origin", "main");
	git(primary, "fetch", "-q", "origin");
	git(primary, "worktree", "add", "-q", "--no-track", "-b", "run/x", lane, "origin/main");
	git(primary, "worktree", "add", "-q", "-b", "nrl-1", interactive, "origin/main");
	for (const dir of [primary, lane, interactive]) fs.writeFileSync(path.join(dir, "main.js"), "// built\n"); // gitignored

	const vault = path.join(sandbox, "vault");
	const dest = path.join(vault, ".obsidian", "plugins", "local-tts-reader");
	fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
	const lock = path.join(primary, ".claude", "deploy.lock");
	const deploy = (cwd: string) => {
		fs.rmSync(dest, { recursive: true, force: true });
		return sh(cwd, process.execPath, [DEPLOY, vault]);
	};
	const deployed = () => fs.existsSync(path.join(dest, "main.js"));
	const owner = (first: string, purpose = `purpose=run ${RUN_ID}`) => {
		fs.mkdirSync(lock, { recursive: true });
		fs.writeFileSync(path.join(lock, "owner"), `${first}\nbranch=run/x commit=abc1234 at=2026-10-12T10:01:00Z ${purpose}\n`);
	};

	console.log("deploy.mjs: a lane deploys merged code only, and only while holding the slot");

	const fromPrimary = deploy(primary);
	check("the primary checkout deploys as before", fromPrimary.code === 0 && deployed(), fromPrimary.out);

	const fromInteractive = deploy(interactive);
	check("an interactive worktree (no marker) deploys as before", fromInteractive.code === 0 && deployed(), fromInteractive.out);

	const marker = path.join(git(lane, "rev-parse", "--absolute-git-dir"), "run-tickets-lane");
	fs.writeFileSync(marker, JSON.stringify({ runId: RUN_ID, lock, base: "origin/main", primary }));
	check("the marker is not a working-tree file", git(lane, "status", "--porcelain") === "");

	const noLock = deploy(lane);
	check("a lane without the lock is refused", noLock.code === 1 && /does not hold the deploy slot/.test(noLock.out), noLock.out);
	check("and nothing was written to the vault", !deployed());

	owner(interactive);
	const other = deploy(lane);
	check("a lock held by another lane is refused", other.code === 1 && /held by .*primary-nrl-1/.test(other.out), other.out);
	check("and nothing was written to the vault", !deployed());

	owner(lane, "purpose=run 2026-01-01T00:00:00Z");
	const otherRun = deploy(lane);
	check("a lock naming this lane but another run is refused", otherRun.code === 1 && /not run/.test(otherRun.out), otherRun.out);

	owner(lane);
	fs.writeFileSync(path.join(lane, "a.txt"), "dirty\n");
	const dirty = deploy(lane);
	check("a lane holding the lock but dirty is refused", dirty.code === 1 && /uncommitted/.test(dirty.out), dirty.out);
	git(lane, "checkout", "-q", "--", "a.txt");

	fs.writeFileSync(path.join(lane, "e.txt"), "unmerged\n");
	git(lane, "add", "-A");
	git(lane, "commit", "-q", "-m", "unmerged");
	const ahead = deploy(lane);
	check("a lane holding the lock at a non-base HEAD is refused", ahead.code === 1 && /merged code only/.test(ahead.out), ahead.out);
	check("and nothing was written to the vault", !deployed());
	git(lane, "reset", "-q", "--hard", "origin/main");

	const good = deploy(lane);
	check("a lane holding the lock at a clean base deploys", good.code === 0 && deployed(), good.out);

	fs.writeFileSync(marker, "{not json");
	const unreadable = deploy(lane);
	check("an unreadable marker is refused", unreadable.code === 1 && /unreadable/.test(unreadable.out), unreadable.out);
	check("and nothing was written to the vault", !deployed());
} catch (err) {
	failures += 1;
	console.log(`  FAIL harness threw: ${err instanceof Error ? err.stack : String(err)}`);
} finally {
	for (const wt of [lane, interactive]) sh(sandbox, "git", ["-C", primary, "worktree", "remove", "--force", wt]);
	fs.rmSync(sandbox, { recursive: true, force: true });
}

if (failures > 0) {
	console.log(`\n${failures} failure(s)`);
	process.exitCode = 1;
} else {
	console.log("\nall deployGuard checks passed");
}
