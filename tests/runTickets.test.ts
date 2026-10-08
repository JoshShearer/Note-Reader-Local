/**
 * /run-tickets machinery: scripts/run-tickets/ticket-ops.mjs and the run-lane
 * guard in deploy.mjs.
 *
 * The pipeline merges into main with no human reading the diff, so what keeps
 * it honest is enforced in code and pinned here, not restated in a prompt: a
 * verdict counts only for the commit it graded, the merge is pinned to that
 * commit and to the base it was graded against, a malformed agent return writes
 * nothing, a ticket the run does not own stays unowned, the gates are never
 * skipped for a diff that changes them, and a lane cannot deploy an unmerged
 * build into the owner's vault.
 *
 * Everything runs in a throwaway sandbox: a bare `origin`, a primary clone, a
 * linked-worktree lane, and a fake `gh` on PATH that keeps PRs in a JSON file
 * and reads PR heads from the sandbox origin. Git runs with an isolated config
 * (no signing, no hooks, no owner identity), and no path under the home
 * directory is ever constructed: deploy.mjs's default target is the owner's
 * real vault, so every deploy here names a sandbox vault explicitly.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "../..");
const OPS = path.join(ROOT, "scripts", "run-tickets", "ticket-ops.mjs");
const DEPLOY = path.join(ROOT, "deploy.mjs");

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
	if (cond) console.log(`  ok   ${name}`);
	else {
		failures += 1;
		console.log(`  FAIL ${name} ${detail}`);
	}
}

const FAKE_GH = String.raw`#!/usr/bin/env node
const fs = require("fs");
const { execFileSync } = require("child_process");
const file = process.env.FAKE_GH_STATE;
const st = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { next: 1, prs: {} };
const a = process.argv.slice(2);
const val = (f) => { const i = a.indexOf(f); return i < 0 ? undefined : a[i + 1]; };
const save = () => fs.writeFileSync(file, JSON.stringify(st));
const head = (b) => {
	const o = execFileSync("git", ["ls-remote", process.env.FAKE_GH_ORIGIN, "refs/heads/" + b], { encoding: "utf8" }).trim();
	return o ? o.split(/\s+/)[0] : null;
};
const view = (n) => { const p = st.prs[n]; return { ...p, headRefOid: p.headRefOid || head(p.headRefName) }; };
if (a[0] === "pr" && a[1] === "create") {
	const n = st.next++;
	st.prs[n] = { number: n, url: "https://github.com/o/r/pull/" + n, headRefName: val("--head"), baseRefName: val("--base"),
		title: val("--title"), body: val("--body"), state: "OPEN", mergeable: "UNKNOWN", mergeCommit: null };
	save();
	console.log(st.prs[n].url);
} else if (a[0] === "pr" && a[1] === "list") {
	console.log(JSON.stringify(Object.values(st.prs).filter((p) => p.headRefName === val("--head") && p.state === "OPEN").map((p) => view(p.number))));
} else if (a[0] === "pr" && a[1] === "view") {
	const v = view(a[2]);
	console.log(JSON.stringify(Object.fromEntries(val("--json").split(",").map((k) => [k, v[k] ?? null]))));
} else if (a[0] === "api" && val("-X") === "PATCH" && /^repos\/\{owner\}\/\{repo\}\/pulls\/\d+$/.test(a[3] ?? "")) {
	st.prs[a[3].split("/").pop()].body = JSON.parse(fs.readFileSync(0, "utf8")).body;
	save();
	console.log("{}");
} else {
	console.error("fake gh: unsupported " + a.join(" "));
	process.exit(1);
}
`;

// ------------------------------------------------------------------ sandbox

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "nrl-run-tickets-"));
const origin = path.join(sandbox, "origin.git");
const primary = path.join(sandbox, "primary");
const lane = path.join(sandbox, "primary-run-20261008-000000");
const STATE = path.join(sandbox, "pipeline-state.json");
const GH_STATE = path.join(sandbox, "gh.json");
const bin = path.join(sandbox, "bin");
const gitconfig = path.join(sandbox, "gitconfig");
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, "gh"), FAKE_GH, { mode: 0o755 });
fs.writeFileSync(
	gitconfig,
	"[user]\n\tname = Sandbox\n\temail = sandbox@example.invalid\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n[core]\n\thooksPath = /dev/null\n",
);

const env: NodeJS.ProcessEnv = {
	...process.env,
	PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
	GIT_CONFIG_GLOBAL: gitconfig,
	GIT_CONFIG_NOSYSTEM: "1",
	FAKE_GH_STATE: GH_STATE,
	FAKE_GH_ORIGIN: origin,
};
delete env.GIT_DIR;
delete env.GIT_WORK_TREE;

function sh(cwd: string, bin: string, args: string[], input?: string): { code: number; out: string } {
	const r = spawnSync(bin, args, { cwd, env, encoding: "utf8", input });
	return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
function git(cwd: string, ...args: string[]): string {
	const r = sh(cwd, "git", args);
	if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.out}`);
	return r.out.trim();
}
interface OpsResult { code: number; json: Record<string, unknown> }
function ops(args: string[], input?: unknown, state = STATE): OpsResult {
	const r = spawnSync(process.execPath, [OPS, "--state", state, ...args], {
		cwd: lane,
		env,
		encoding: "utf8",
		input: input === undefined ? "" : typeof input === "string" ? input : JSON.stringify(input),
	});
	const last = (r.stdout ?? "").trim().split("\n").pop() ?? "";
	let json: Record<string, unknown> = {};
	try {
		json = JSON.parse(last);
	} catch {
		json = { unparsed: r.stdout, stderr: r.stderr };
	}
	return { code: r.status ?? 1, json };
}
const readState = () => JSON.parse(fs.readFileSync(STATE, "utf8"));
const ticket = (key: string) => readState().tickets.find((t: { id: string }) => t.id === key);
const gh = () => JSON.parse(fs.readFileSync(GH_STATE, "utf8"));
const writeGh = (s: unknown) => fs.writeFileSync(GH_STATE, JSON.stringify(s));
const remoteHead = (branch: string) => git(primary, "ls-remote", origin, `refs/heads/${branch}`).split(/\s+/)[0] || null;

git(sandbox, "init", "--bare", "-b", "main", origin);
fs.mkdirSync(primary);
git(primary, "init", "-b", "main");
fs.writeFileSync(
	path.join(primary, "package.json"),
	JSON.stringify({ private: true, scripts: { typecheck: "exit 7", lint: "exit 0", build: "exit 0", test: "exit 0" } }, null, 2),
);
fs.writeFileSync(path.join(primary, ".gitignore"), "main.js\n");
fs.writeFileSync(path.join(primary, "manifest.json"), '{"id":"sandbox"}\n');
fs.writeFileSync(path.join(primary, "styles.css"), "/* sandbox */\n");
fs.writeFileSync(path.join(primary, "a.txt"), "base\n");
fs.mkdirSync(path.join(primary, ".github", "workflows"), { recursive: true });
fs.writeFileSync(path.join(primary, ".github", "workflows", "ci.yml"), "name: CI\n");
git(primary, "add", "-A");
git(primary, "commit", "-m", "base");
git(primary, "remote", "add", "origin", origin);
git(primary, "push", "-q", "origin", "main");
git(primary, "fetch", "-q", "origin");
git(primary, "worktree", "add", "-q", "--no-track", "-b", "run/x", lane, "origin/main");
fs.writeFileSync(path.join(lane, "main.js"), "// built\n"); // gitignored, as in the real repo

/** Commit one change on the lane's current branch and return HEAD. */
function commit(file: string, body: string, message: string): string {
	fs.writeFileSync(path.join(lane, file), body);
	git(lane, "add", "-A");
	git(lane, "commit", "-q", "-m", message);
	return git(lane, "rev-parse", "HEAD");
}
/** Push a commit to origin/main from the primary, as a parallel run's merge would. */
function moveBase(tag: string): string {
	git(primary, "pull", "-q", "origin", "main");
	fs.writeFileSync(path.join(primary, `${tag}.txt`), `${tag}\n`);
	git(primary, "add", "-A");
	git(primary, "commit", "-q", "-m", tag);
	git(primary, "push", "-q", "origin", "main");
	git(lane, "fetch", "-q", "origin");
	return git(lane, "rev-parse", "origin/main");
}
/** start -> commit -> Build done -> ship -> critic pass -> verify pass. Returns the graded sha. */
function driveToMerge(key: string, file: string, body: string, critic: Record<string, unknown> = {}): string {
	ops(["add", key]);
	const s = ops(["start", key, "--run-branch", "run/x"], { title: `Change ${file}`, description: "d", type: "bug" });
	if (s.code !== 0) throw new Error(`start ${key}: ${JSON.stringify(s.json)}`);
	const sha = commit(file, body, `fix: ${key}`);
	ops(["record", key, "--phase", "build"], { result: "done", gatedSha: sha });
	const shipped = ops(["ship", key]);
	if (shipped.code !== 0) throw new Error(`ship ${key}: ${JSON.stringify(shipped.json)}`);
	const c = ops(["record", key, "--phase", "critic"], { result: "pass", criticVerdict: "pass", criticSha: sha, ...critic });
	if (c.code !== 0) throw new Error(`critic ${key}: ${JSON.stringify(c.json)}`);
	const base = git(lane, "rev-parse", "origin/main");
	ops(["record", key, "--phase", "verify"], { result: "pass", verifyVerdict: "pass", verifiedSha: sha, verifiedBaseSha: base });
	return sha;
}

try {
	// ---------------------------------------------------------------- init
	console.log("init derives the run's flags from its arguments and validates every key");
	{
		const bad = ops(["init", "--args", "NRL-5; rm -rf ~", "--stamp", "s", "--primary", primary, "--worktree", lane, "--run-branch", "run/x"]);
		check("a key carrying shell syntax is refused", bad.code === 1, JSON.stringify(bad.json));
		check("and nothing is claimed", !fs.existsSync(STATE));
		const nm = path.join(sandbox, "nomerge.json");
		const r = ops(["init", "--args", "nrl-5,12 --no-merge", "--stamp", "s", "--primary", primary, "--worktree", lane, "--run-branch", "run/x"], undefined, nm);
		check("--no-merge in the arguments becomes noMerge: true", r.code === 0 && JSON.parse(fs.readFileSync(nm, "utf8")).noMerge === true, JSON.stringify(r.json));
		check("bare numbers and lowercase keys normalise", JSON.stringify(r.json.keys) === '["NRL-5","NRL-12"]', JSON.stringify(r.json.keys));
		const ok = ops(["init", "--args", "NRL-5", "--stamp", "s", "--primary", primary, "--worktree", lane, "--run-branch", "run/x"]);
		check("without --no-merge, noMerge is an explicit false", ok.code === 0 && readState().noMerge === false, JSON.stringify(readState()));
		const again = ops(["init", "--args", "NRL-5", "--stamp", "s", "--primary", primary, "--worktree", lane, "--run-branch", "run/x"]);
		check("a second init on the same state file is refused, not overwritten", again.code === 2, JSON.stringify(again.json));
		check("add refuses a key outside NRL-<n>", ops(["add", "NRL-5x"]).code === 1);
	}

	// ---------------------------------------------------------------- record
	console.log("record writes only well-formed returns, for the phase the ticket is in");
	{
		ops(["add", "NRL-5"]);
		check("a Build return before Start is refused (wrong phase)", ops(["record", "NRL-5", "--phase", "build"], { result: "done" }).code === 1);
		const s = ops(["start", "NRL-5", "--run-branch", "run/x"], { title: "Wikilinks spoken as brackets!", description: "body", type: "bug" });
		check("start names a fix/ branch from key and title", s.json.branch === "fix/nrl-5-wikilinks-spoken-as-brackets", JSON.stringify(s.json));
		check("start leaves the ticket at build", ticket("NRL-5").phase === "build");
		const before = fs.readFileSync(STATE, "utf8");
		check("a malformed sha is refused", ops(["record", "NRL-5", "--phase", "build"], { result: "done", gatedSha: "not-a-sha" }).code === 1);
		check("a result outside the phase's set is refused", ops(["record", "NRL-5", "--phase", "build"], { result: "pass" }).code === 1);
		check("a non-object return is refused", ops(["record", "NRL-5", "--phase", "build"], "[1,2]").code === 1);
		check("a quote inside a string survives the hand-off", ops(["record", "NRL-5", "--phase", "build"], { result: "handoff", handoff: "it's half done; $(not run)" }).code === 0);
		const after = readState();
		check("refusals wrote nothing; the handoff stayed in build", after.tickets[0].phase === "build" && after.tickets[0].handoff === "it's half done; $(not run)", before.length + "");
		const sha = commit("a.txt", "fixed\n", "fix: NRL-5");
		const b = ops(["record", "NRL-5", "--phase", "build"], { result: "done", gatedSha: sha, commitSha: sha, prTitle: "fix: NRL-5" });
		check("a field the phase may not set is dropped and reported", JSON.stringify(b.json.dropped) === '["commitSha"]' && ticket("NRL-5").commitSha == null, JSON.stringify(b.json));
		check("Build done routes to ship", ticket("NRL-5").phase === "ship");
		check("a critic verdict before anything is pushed is refused", ops(["record", "NRL-5", "--phase", "critic"], { result: "pass", criticVerdict: "pass", criticSha: sha }).code === 1);

		// ---------------------------------------------------------- ship
		git(lane, "config", "push.followTags", "true");
		git(lane, "tag", "-a", "9.9.9", "-m", "would cut a release");
		const shipped = ops(["ship", "NRL-5"]);
		check("ship skips the gates when HEAD is the gated commit (typecheck is `exit 7`)", shipped.code === 0, JSON.stringify(shipped.json));
		check("the push reads back as HEAD", remoteHead("fix/nrl-5-wikilinks-spoken-as-brackets") === sha);
		check("no tag reached origin despite push.followTags", git(primary, "ls-remote", "--tags", origin) === "");
		check("a PR was opened against main and carries NOT VERIFIED IN OBSIDIAN", gh().prs["1"]?.baseRefName === "main" && String(gh().prs["1"]?.body).includes("NOT VERIFIED IN OBSIDIAN"));
		check("commitSha is recorded and the ticket waits for the critic", ticket("NRL-5").commitSha === sha && ticket("NRL-5").phase === "critic");

		check("a verdict for another commit is refused", ops(["record", "NRL-5", "--phase", "critic"], { result: "pass", criticVerdict: "pass", criticSha: "0".repeat(40) }).code === 1);
		check("a result without its matching verdict is refused", ops(["record", "NRL-5", "--phase", "critic"], { result: "pass", criticVerdict: "concerns", criticSha: sha }).code === 1);
		check("critic pass on the pushed head routes to verify", ops(["record", "NRL-5", "--phase", "critic"], { result: "pass", criticVerdict: "pass", criticSha: sha }).code === 0 && ticket("NRL-5").phase === "verify");
		const base = git(lane, "rev-parse", "origin/main");
		check("a verifiedBaseSha that is not an origin/main commit is refused", ops(["record", "NRL-5", "--phase", "verify"], { result: "pass", verifyVerdict: "pass", verifiedSha: sha, verifiedBaseSha: "1".repeat(40) }).code === 1);
		ops(["record", "NRL-5", "--phase", "verify"], { result: "pass", verifyVerdict: "pass", verifiedSha: sha, verifiedBaseSha: base });
		check("verify pass routes to merge", ticket("NRL-5").phase === "merge");

		// ---------------------------------------------------------- merge, merged, finish
		check("finish before a recorded merge commit is refused", ops(["finish", "NRL-5", "--run-branch", "run/x"]).code === 1);
		const m = ops(["merge", "NRL-5"]);
		check("merge prints a squash merge pinned to the graded head", JSON.stringify(m.json.run) === JSON.stringify([`gh pr merge 1 --squash --match-head-commit ${sha}`]), JSON.stringify(m.json));
		const g = gh();
		Object.assign(g.prs["1"], { state: "MERGED", headRefOid: sha, mergeCommit: { oid: "f".repeat(40) } });
		writeGh(g);
		const md = ops(["merged", "NRL-5"]);
		check("merged records the merge commit and prints the remote-ref delete", ticket("NRL-5").mergeCommit === "f".repeat(40)
			&& String((md.json.run as string[])[0]).includes("git/refs/heads/fix/nrl-5-wikilinks-spoken-as-brackets"), JSON.stringify(md.json));
		check("the delete is not run by the script", remoteHead("fix/nrl-5-wikilinks-spoken-as-brackets") === sha);
		const early = ops(["finish", "NRL-5", "--run-branch", "run/x"]);
		check("finish blocks while the remote branch still exists", early.code === 3, JSON.stringify(early.json));
	}

	// The block above parked NRL-5; finish's happy path is exercised on NRL-8 below.
	console.log("a verdict is for one commit: a new push clears it, and a moved base re-opens the ticket");
	{
		const sha = driveToMerge("NRL-7", "b.txt", "seven\n");
		moveBase("parallel-merge");
		const m = ops(["merge", "NRL-7"]);
		check("merge refuses when origin/main moved after Verify, routing back to Ship", m.code === 0 && m.json.route === "ship" && !m.json.run && ticket("NRL-7").phase === "ship", JSON.stringify(m.json));
		const again = ops(["ship", "NRL-7"]);
		check("Ship rebases and re-gates the head (typecheck fails here, so: Fix)", again.code === 4 && ticket("NRL-7").phase === "fix", JSON.stringify(again.json));
		check("a lone prNumber: null (half a -followup switch) is refused", ops(["record", "NRL-7", "--phase", "fix"], { result: "handoff", handoff: "x", prNumber: null }).code === 1);
		const rebased = git(lane, "rev-parse", "HEAD");
		ops(["record", "NRL-7", "--phase", "fix"], { result: "done", gatedSha: rebased, roundNote: "rebased onto the moved base" });
		const s = ops(["ship", "NRL-7"]);
		check("the rebased head is pushed with a lease", s.code === 0 && remoteHead("fix/nrl-7-change-b-txt") === rebased, JSON.stringify(s.json));
		check("the new commitSha cleared both verdicts", ticket("NRL-7").criticVerdict === null && ticket("NRL-7").verifyVerdict === null && rebased !== sha);
		check("the Round line was appended to the existing PR", String(gh().prs["2"]?.body).includes("rebased onto the moved base"));
		check("a merge on the cleared verdicts is refused (wrong phase)", ops(["merge", "NRL-7"]).code === 1);
	}

	console.log("Fix may only switch to <branch>-followup, and only as a pair");
	{
		ops(["add", "NRL-6"]);
		ops(["start", "NRL-6", "--run-branch", "run/x"], { title: "gates", description: "d", type: "feature" });
		const pkg = JSON.parse(fs.readFileSync(path.join(lane, "package.json"), "utf8"));
		pkg.scripts.lint = "exit 0 # weakened";
		const sha = commit("package.json", JSON.stringify(pkg, null, 2), "chore: NRL-6");
		ops(["record", "NRL-6", "--phase", "build"], { result: "done", gatedSha: sha });
		const s = ops(["ship", "NRL-6"]);
		check("a diff that changes the gates runs them despite gatedSha, and fails here", s.code === 4 && String(ticket("NRL-6").verifyFindings).includes("npm run typecheck"), JSON.stringify(s.json));
		check("a branch switch to anything else is refused", ops(["record", "NRL-6", "--phase", "fix"], { result: "done", branch: "feature/elsewhere", prNumber: null }).code === 1);
		const f = ops(["record", "NRL-6", "--phase", "fix"], { result: "handoff", handoff: "x", branch: `${ticket("NRL-6").branch}-followup`, prNumber: null });
		check("the -followup pair is accepted", f.code === 0 && ticket("NRL-6").branch.endsWith("-followup"), JSON.stringify(f.json));
		check("halt blocks the ticket and marks the run", ops(["halt", "NRL-6"]).code === 0 && readState().halted === "NRL-6" && ticket("NRL-6").status === "blocked");
		check("unhalt resumes it at fix, round 0", ops(["unhalt", "NRL-6"]).code === 0 && readState().halted === undefined && ticket("NRL-6").phase === "fix");
		check("noTracker can be set", ops(["record", "NRL-6", "--phase", "orchestrator"], { noTracker: true }).code === 0 && ticket("NRL-6").noTracker === true);
		check("and never cleared", ops(["record", "NRL-6", "--phase", "orchestrator"], { noTracker: false }).code === 1 && ticket("NRL-6").noTracker === true);
		const decided = ops(["record", "NRL-6", "--phase", "fix"], { result: "handoff", handoff: "y", clarificationAdd: [{ question: "q?", answer: "a", reason: "r" }] });
		check("a decision on an unowned ticket is never queued for posting", Array.isArray(decided.json.toPost) && (decided.json.toPost as unknown[]).length === 0, JSON.stringify(decided.json));
	}

	console.log("risk: a gate-defining change is reviewed at the deepest depth");
	{
		git(lane, "checkout", "-q", "run/x");
		git(lane, "reset", "-q", "--hard", "origin/main");
		ops(["add", "NRL-9"]);
		ops(["start", "NRL-9", "--run-branch", "run/x"], { title: "adopt", description: "d", type: "bug" });
		const pkg = JSON.parse(fs.readFileSync(path.join(lane, "package.json"), "utf8"));
		pkg.scripts.typecheck = "exit 0";
		const sha = commit("package.json", JSON.stringify(pkg, null, 2), "chore: NRL-9");
		ops(["record", "NRL-9", "--phase", "build"], { result: "done", gatedSha: sha });
		// A PR left by a crash between `gh pr create` and the state write.
		git(lane, "push", "-q", "origin", `refs/heads/fix/nrl-9-adopt:refs/heads/fix/nrl-9-adopt`);
		const g = gh();
		g.prs[String(g.next)] = { number: g.next, url: `https://github.com/o/r/pull/${g.next}`, headRefName: "fix/nrl-9-adopt", baseRefName: "main", body: "orphan", state: "OPEN", mergeable: "UNKNOWN", mergeCommit: null };
		const orphan = g.next;
		g.next += 1;
		writeGh(g);
		const s = ops(["ship", "NRL-9"]);
		check("ship adopts the existing open PR instead of opening a second", s.code === 0 && s.json.prNumber === orphan && gh().next === orphan + 1, JSON.stringify(s.json));
		const r = ops(["risk", "NRL-9"]);
		check("risk flags gatesChanged and forces L2+Double", r.json.gatesChanged === true && r.json.depth === "L2+Double", JSON.stringify(r.json));
		ops(["record", "NRL-9", "--phase", "orchestrator"], { phase: "finish" });
		check("finish without a recorded merge commit is refused", ops(["finish", "NRL-9", "--run-branch", "run/x"]).code === 1);
	}

	console.log("merge: the release surface and --no-merge both leave the PR for the owner");
	{
		git(lane, "checkout", "-q", "run/x");
		driveToMerge("NRL-10", "versions.json", '{"0.2.2":"1.4.0"}\n');
		const r = ops(["merge", "NRL-10"]);
		check("a diff touching versions.json is blocked, not merged", r.code === 3 && ticket("NRL-10").status === "blocked", JSON.stringify(r.json));
		git(lane, "checkout", "-q", "run/x");
		driveToMerge("NRL-11", "c.txt", "eleven\n");
		const st = readState();
		delete st.noMerge;
		fs.writeFileSync(STATE, JSON.stringify(st));
		const nm = ops(["merge", "NRL-11"]);
		check("a state file without an explicit noMerge: false never merges", nm.code === 3 && ticket("NRL-11").status === "blocked", JSON.stringify(nm.json));
		const st2 = readState();
		st2.noMerge = false;
		fs.writeFileSync(STATE, JSON.stringify(st2));
	}

	console.log("finish deletes the local branch only when it IS the merged head");
	{
		git(lane, "checkout", "-q", "run/x");
		const sha = driveToMerge("NRL-8", "d.txt", "eight\n");
		const branch = ticket("NRL-8").branch;
		const prn = String(ticket("NRL-8").prNumber);
		ops(["merge", "NRL-8"]);
		// What `gh pr merge --squash` and the printed delete would do.
		git(primary, "pull", "-q", "origin", "main");
		fs.writeFileSync(path.join(primary, "d.txt"), "eight\n");
		git(primary, "add", "-A");
		git(primary, "commit", "-q", "-m", "fix: NRL-8 (#squash)");
		git(primary, "push", "-q", "origin", "main");
		const g = gh();
		Object.assign(g.prs[prn], { state: "MERGED", headRefOid: sha, mergeCommit: { oid: git(primary, "rev-parse", "HEAD") } });
		writeGh(g);
		ops(["merged", "NRL-8"]);
		git(primary, "push", "-q", "origin", "--delete", branch);
		const f = ops(["finish", "NRL-8", "--run-branch", "run/x"]);
		check("finish succeeds and asks for the Done transition", f.code === 0 && f.json.tracker === "Done", JSON.stringify(f.json));
		check("the local branch is gone", sh(lane, "git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).code !== 0);
		check("the lane is back on the run branch at origin/main", git(lane, "branch", "--show-current") === "run/x" && git(lane, "rev-parse", "HEAD") === git(lane, "rev-parse", "origin/main"));
		check("nothing records onto a done ticket", ops(["record", "NRL-8", "--phase", "orchestrator"], { phase: "fix" }).code === 1);
		check("but the Done transition's outcome is recorded", ops(["record", "NRL-8", "--phase", "orchestrator"], { trackerWrite: { op: "state:Done", ok: true } }).code === 0);
	}

	console.log("gate changes: renames are seen, and every critic must justify one");
	{
		git(lane, "checkout", "-q", "run/x");
		ops(["add", "NRL-13"]);
		ops(["start", "NRL-13", "--run-branch", "run/x"], { title: "move ci", description: "d", type: "chore" });
		fs.mkdirSync(path.join(lane, "docs"), { recursive: true });
		git(lane, "mv", ".github/workflows/ci.yml", "docs/ci.yml");
		git(lane, "commit", "-q", "-m", "chore: NRL-13 park the workflow");
		ops(["record", "NRL-13", "--phase", "build"], { result: "done", gatedSha: git(lane, "rev-parse", "HEAD") });
		const s = ops(["ship", "NRL-13"]);
		check("moving a workflow out of .github/ is a gate change: the gates run (and fail here)", s.code === 4 && String(ticket("NRL-13").verifyFindings).includes("npm run typecheck"), JSON.stringify(s.json));

		const pkg = JSON.parse(fs.readFileSync(path.join(lane, "package.json"), "utf8"));
		pkg.scripts.typecheck = "exit 0";
		const body = JSON.stringify(pkg, null, 2);
		git(lane, "checkout", "-q", "run/x");
		driveToMerge("NRL-14", "package.json", body, { gateReviews: [{ justified: true, reason: "one critic only" }] });
		const one = ops(["merge", "NRL-14"]);
		check("a gate change justified by only one critic is not merged", one.code === 3 && /fewer than two critics/.test(String(one.json.blocked)), JSON.stringify(one.json));
		git(lane, "checkout", "-q", "run/x");
		driveToMerge("NRL-15", "package.json", body, { gateReviews: [{ justified: true, reason: "a" }, { justified: false, reason: "weakens typecheck" }] });
		const split = ops(["merge", "NRL-15"]);
		check("a gate change one of two critics rejects is not merged", split.code === 3 && /not every critic/.test(String(split.json.blocked)), JSON.stringify(split.json));
		git(lane, "checkout", "-q", "run/x");
		driveToMerge("NRL-16", "package.json", body, { gateReviews: [{ justified: true, reason: "a" }, { justified: true, reason: "b" }] });
		const both = ops(["merge", "NRL-16"]);
		check("a gate change both critics justify proceeds to the merge command", both.code === 0 && Array.isArray(both.json.run), JSON.stringify(both.json));
	}

	console.log("ship decides 'base moved' from git, and rebases onto it");
	{
		git(lane, "checkout", "-q", "run/x");
		git(lane, "reset", "-q", "--hard", "origin/main");
		ops(["add", "NRL-17"]);
		ops(["start", "NRL-17", "--run-branch", "run/x"], { title: "rebase", description: "d", type: "bug" });
		const sha = commit("h.txt", "seventeen\n", "fix: NRL-17");
		ops(["record", "NRL-17", "--phase", "build"], { result: "done", gatedSha: sha });
		const moved = moveBase("another-run");
		const s = ops(["ship", "NRL-17"]);
		check("the stale head was rebased onto the moved base", sh(lane, "git", ["merge-base", "--is-ancestor", moved, "HEAD"]).code === 0);
		check("and the rebased head is gated afresh (typecheck fails here), not shipped on the old gatedSha", s.code === 4 && String(ticket("NRL-17").verifyFindings).includes("npm run typecheck"), JSON.stringify(s.json));
	}

	console.log("finish keeps a local branch that holds anything the merge did not");
	{
		git(lane, "checkout", "-q", "run/x");
		const sha = driveToMerge("NRL-12", "f.txt", "twelve\n");
		const branch = ticket("NRL-12").branch;
		const prn = String(ticket("NRL-12").prNumber);
		ops(["merge", "NRL-12"]);
		const g = gh();
		Object.assign(g.prs[prn], { state: "MERGED", headRefOid: sha, mergeCommit: { oid: "e".repeat(40) } });
		writeGh(g);
		ops(["merged", "NRL-12"]);
		git(primary, "push", "-q", "origin", "--delete", branch);
		commit("g.txt", "local only\n", "fix: NRL-12 follow-on never pushed");
		const f = ops(["finish", "NRL-12", "--run-branch", "run/x"]);
		check("finish blocks instead of deleting unmerged local work", f.code === 3 && ticket("NRL-12").status === "blocked", JSON.stringify(f.json));
		check("and the branch is still there", sh(lane, "git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).code === 0);
	}

	// ---------------------------------------------------------------- gate-file coverage
	console.log("GATE_DEFINING covers every file the gate entry points load");
	{
		const src = fs.readFileSync(OPS, "utf8");
		const lit = /const GATE_DEFINING =\s*(\/.+\/);/.exec(src)?.[1];
		check("GATE_DEFINING is found in ticket-ops.mjs", Boolean(lit));
		const gate = new Function(`return ${lit}`)() as RegExp;
		const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
		const roots = new Set<string>(["package.json", "package-lock.json", "scripts/run-tickets/ticket-ops.mjs"]);
		for (const name of ["typecheck", "lint", "build", "pretest", "test", "deploy"]) {
			const cmd = pkg.scripts[name] ?? "";
			for (const tok of cmd.split(/\s+/)) if (/\.(mjs|cjs|js|json)$/.test(tok)) roots.add(tok);
			if (/\btsc\b/.test(cmd)) roots.add("tsconfig.json");
			if (/\beslint\b/.test(cmd)) for (const f of fs.readdirSync(ROOT)) if (/^eslint\.config\./.test(f)) roots.add(f);
		}
		for (const f of fs.readdirSync(path.join(ROOT, ".github", "workflows"))) roots.add(`.github/workflows/${f}`);
		const closure = new Set<string>();
		const visit = (rel: string): void => {
			if (closure.has(rel)) return;
			closure.add(rel);
			if (!/\.(mjs|cjs|js)$/.test(rel)) return;
			const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
			for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|require\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
				visit(path.relative(ROOT, path.resolve(path.dirname(path.join(ROOT, rel)), m[1] ?? "")));
			}
		};
		for (const r of roots) if (fs.existsSync(path.join(ROOT, r))) visit(r);
		const missed = [...closure].filter((f) => !gate.test(f));
		check(`all ${closure.size} files in the gates' closure are gate-defining`, missed.length === 0, missed.join(", "));
		check("the closure is not vacuous", closure.has("run-tests.mjs") && closure.has("tsconfig.json") && closure.has(".github/workflows/ci.yml"), [...closure].join(", "));
		check("a source file is not gate-defining", !gate.test("src/text/extract.ts"));
	}

	// ---------------------------------------------------------------- deploy guard
	console.log("deploy.mjs: a lane deploys merged code only, and only while holding the slot");
	{
		const vault = path.join(sandbox, "vault");
		const dest = path.join(vault, ".obsidian", "plugins", "local-tts-reader");
		fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
		const lock = path.join(sandbox, "deploy.lock");
		const deploy = () => sh(lane, process.execPath, [DEPLOY, vault]);
		git(lane, "checkout", "-q", "run/x");
		git(lane, "reset", "-q", "--hard", "origin/main");

		const control = deploy();
		check("control: a worktree with no lane marker deploys as before", control.code === 0 && fs.existsSync(path.join(dest, "main.js")), control.out);
		fs.rmSync(dest, { recursive: true, force: true });

		const marker = path.join(git(lane, "rev-parse", "--absolute-git-dir"), "run-tickets-lane");
		fs.writeFileSync(marker, JSON.stringify({ lock, base: "origin/main" }));
		const noLock = deploy();
		check("a marked lane without the slot is refused", noLock.code === 1 && /does not hold the deploy slot/.test(noLock.out), noLock.out);
		check("and nothing was written to the vault", !fs.existsSync(dest));

		fs.mkdirSync(lock);
		fs.writeFileSync(path.join(lock, "holder"), "/some/other/lane\n");
		const other = deploy();
		check("a slot held by another lane is refused", other.code === 1 && /held by \/some\/other\/lane/.test(other.out), other.out);

		fs.writeFileSync(path.join(lock, "holder"), `${fs.realpathSync(lane)}\nrunId x\n`);
		commit("e.txt", "unmerged\n", "wip: unmerged");
		const ahead = deploy();
		check("an unmerged HEAD is refused even with the slot", ahead.code === 1 && /merged code only/.test(ahead.out), ahead.out);
		git(lane, "reset", "-q", "--hard", "origin/main");
		fs.writeFileSync(path.join(lane, "a.txt"), "dirty\n");
		const dirty = deploy();
		check("a dirty lane is refused", dirty.code === 1 && /uncommitted/.test(dirty.out), dirty.out);
		git(lane, "checkout", "-q", "--", "a.txt");
		const good = deploy();
		check("the slot holder at origin/main deploys", good.code === 0 && fs.existsSync(path.join(dest, "main.js")), good.out);
	}
} catch (err) {
	failures += 1;
	console.log(`  FAIL harness threw: ${err instanceof Error ? err.stack : String(err)}`);
} finally {
	sh(sandbox, "git", ["-C", primary, "worktree", "remove", "--force", lane]);
	fs.rmSync(sandbox, { recursive: true, force: true });
}

if (failures > 0) {
	console.log(`\n${failures} failure(s)`);
	process.exitCode = 1;
} else {
	console.log("\nall runTickets checks passed");
}
