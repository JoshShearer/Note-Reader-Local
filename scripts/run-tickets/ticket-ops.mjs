#!/usr/bin/env node
/**
 * The mechanical half of `/run-tickets` (.claude/commands/run-tickets.md).
 *
 * Start, Ship, Merge and Finish make no judgement calls - name a branch, push,
 * read the push back, open a PR, read a merge back, delete a branch - yet as
 * subagents each one paid for the always-loaded instructions on every tool call
 * and could improvise. Here they are deterministic steps the orchestrator runs
 * with one Bash call each.
 *
 * Linear is reachable only through the MCP server, which a script cannot call,
 * so every tracker read and write stays with the orchestrator. It records each
 * write's outcome here (`record --phase orchestrator` with `trackerWrite`), and
 * `record` lists the pipeline decisions it still has to post (`toPost`).
 *
 * This script is the ONLY writer of ticket entries in the run's state file.
 * Agents return one JSON object and the orchestrator pipes it into
 * `record --phase <phase>`, which keeps only the fields that phase may set,
 * refuses a verdict that names any commit but the current `commitSha`, and
 * moves `phase` by the routing table (NEXT), so `--resume` continues where the
 * run was. A verdict describes one commit: when `commitSha` changes, both
 * verdicts are cleared.
 *
 * The orchestrator runs a FROZEN copy of this file, taken from origin/main at
 * Step 0c before any ticket branch is checked out: a ticket that edits it must
 * not change the gate that merges it.
 *
 * `gh pr merge` and the remote-branch delete are never run here. `merge` and
 * `merged` PRINT them (`run: [...]`) and the orchestrator runs them as plain
 * Bash, so the permission layer sees exactly what merges into main.
 *
 *   node <ops>/scripts/run-tickets/ticket-ops.mjs --state <file> <cmd> <KEY> [...]
 *
 *   init --args "<$ARGUMENTS>" --stamp <s> --primary <p> --worktree <w> --run-branch <b>
 *                                  parse and validate the run's arguments, claim the state file
 *   add <KEY>                      register a pending ticket (idempotent)
 *   show <KEY> [field,...]         print the ticket entry, or a subset
 *   record <KEY> --phase <p> [--input <file>]
 *                                  merge one JSON object (file, else stdin) - see above
 *   start <KEY> --run-branch <b>   snapshot (JSON on stdin), branch off the run branch
 *   ship <KEY>                     gates unless HEAD == gatedSha, leased push, read back,
 *                                  PR create or Round-line append
 *   risk <KEY>                     critic depth for origin/main...commitSha
 *   pr-append <KEY> <textFile>     append text to the PR body and read it back
 *   merge <KEY>                    preflight; prints the `gh pr merge` to run
 *   merged <KEY>                   read the merge back; prints the remote-branch delete
 *   finish <KEY> --run-branch <b>  resync the lane, delete the local branch by head equality
 *   halt <KEY>                     Fix cap reached: block the ticket, set top-level `halted`
 *   unhalt <KEY>                   --resume of a halted run: back to phase fix, round 0
 *
 * Output: one JSON line. Exit codes: 0 ok, 1 usage or malformed input (for
 * `record`: re-run that agent once, then block), 2 infrastructure error (stop
 * the run), 3 blocked (status and blockedReason are already set), 4 fail (route
 * to Fix; verifyFindings is set).
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";

const EXIT = { ok: 0, usage: 1, error: 2, blocked: 3, fail: 4 };
const VERDICT_FIELDS = ["criticVerdict", "criticSha", "gateReviews", "verifyVerdict", "verifiedSha", "verifiedBaseSha"];

/**
 * The community installer reads `versions.json` from the repository's HEAD, not
 * from a Release (release.yml, NRL-105), so merging a change to it reaches users
 * at once. That is a release decision, and the run never takes one.
 */
const RELEASE_SURFACE = ["versions.json"];

/**
 * Files that define what the gates DO. Freezing this script does not freeze
 * them: a ticket could weaken `npm run lint`, the suite registry, the runner or
 * CI and then pass through its own weakened gate. A diff touching one is
 * reviewed at the deepest depth with the critic told so, and Ship never skips
 * its gates for it on the strength of an agent's earlier run.
 */
// tests/runTickets.test.ts derives the import closure of every gate entry point named in
// package.json's scripts and fails if a file in it falls outside this pattern.
const GATE_DEFINING =
	/^(package\.json|package-lock\.json|\.npmrc|\.nvmrc|\.node-version|(.+\/)?tsconfig[^/]*\.json|eslint\.config\.[cm]?js|esbuild\.config\.mjs|run-tests\.mjs|run-tests\.d\.mts|build-tests\.mjs|deploy\.mjs|opencode\.json|tests\/suiteRegistry\.test\.ts|\.claude\/settings[^/]*\.json|\.claude\/commands\/(run-tickets|critique|check-constraints)\.md)$|^(\.github|scripts\/run-tickets)\//;

/** Ticket keys reach branch names and shell commands, so nothing else is accepted. */
const KEY_RE = /^(NRL-[1-9][0-9]{0,5}|DOCS-[0-9]{8}-[0-9]{6})$/;

/** What each phase's return may set. Anything else is dropped and reported. */
const COMMON = ["handoff", "blockedReason", "clarificationAdd"];
const FIELDS_BY_PHASE = {
	triage: ["type", "requirement", "knownDefect", "reproduction", ...COMMON],
	build: [
		"planNote", "reproduction", "reproConfirmed", "implementationSummary", "gatedSha",
		"prTitle", "prBody", "docsCandidate", ...COMMON,
	],
	fix: [
		"gatedSha", "verifyFindings", "implementationSummary", "roundNote", "branch", "prNumber",
		"docsCandidate", ...COMMON,
	],
	critic: ["criticVerdict", "criticSha", "gateReviews", "verifyFindings", "criticNotes", "blockedReason"],
	verify: ["verifyVerdict", "verifiedSha", "verifiedBaseSha", "verifyNotes", "verifyFindings", "ciStatus", ...COMMON],
	orchestrator: [
		"fixRound", "status", "blockedReason", "noTracker", "phase", "handoff", "trackerWrite",
		"postedQuestions",
	],
};
/** The `result` values each phase may return. Anything else is malformed. */
const RESULTS = {
	triage: ["done", "blocked"],
	build: ["done", "handoff", "blocked"],
	fix: ["done", "handoff", "blocked"],
	critic: ["pass", "concerns", "block", "blocked"],
	verify: ["pass", "fail", "handoff", "blocked"],
	orchestrator: [undefined, "blocked"],
};
const SHA = (v) => v === null || (typeof v === "string" && /^[0-9a-f]{40}$/.test(v));
const STR = (v) => v === null || typeof v === "string";
const BOOL = (v) => typeof v === "boolean";
const INT = (v) => Number.isInteger(v) && v >= 0;
const OBJ = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const QUESTIONS = (v) => Array.isArray(v) && v.every((c) => OBJ(c) && typeof c.question === "string" && typeof c.answer === "string");
/** Field shapes. A return that breaks one writes nothing at all. */
const SHAPE = {
	handoff: STR, blockedReason: STR, clarificationAdd: QUESTIONS, type: (v) => ["bug", "feature", "chore", "docs"].includes(v),
	requirement: STR, knownDefect: BOOL, reproduction: STR, reproConfirmed: BOOL, planNote: STR,
	implementationSummary: STR, gatedSha: SHA, prTitle: STR, prBody: STR, docsCandidate: STR,
	verifyFindings: STR, roundNote: STR, branch: (v) => typeof v === "string" && /^[A-Za-z0-9._/-]+$/.test(v),
	prNumber: (v) => v === null, criticVerdict: (v) => ["pass", "concerns", "block"].includes(v), criticSha: SHA,
	criticNotes: STR, verifyVerdict: (v) => ["pass", "fail"].includes(v), verifiedSha: SHA, verifiedBaseSha: SHA,
	verifyNotes: STR, ciStatus: STR, fixRound: INT, status: (v) => ["in_progress", "blocked", "done"].includes(v),
	// Monotonic: a ticket the run does not own never becomes owned again mid-run.
	noTracker: (v) => v === true, phase: (v) => ["start", "build", "ship", "critic", "verify", "fix", "merge", "finish"].includes(v),
	trackerWrite: (v) => OBJ(v) && typeof v.op === "string" && typeof v.ok === "boolean",
	postedQuestions: (v) => Array.isArray(v) && v.every((q) => typeof q === "string"),
	gateReviews: (v) => Array.isArray(v) && v.every((r) => OBJ(r) && typeof r.justified === "boolean" && typeof r.reason === "string"),
};

/** Routing for agent results: phase -> result -> next phase. `handoff` stays in the same phase. */
const NEXT = {
	build: { done: "ship" },
	fix: { done: "ship" },
	critic: { pass: "verify", concerns: "verify", block: "fix" },
	verify: { pass: "merge", fail: "fix" },
};

class Stop extends Error {
	constructor(kind, message) {
		super(message);
		this.kind = kind;
	}
}

// ------------------------------------------------------------------ argv

// Options first: the orchestrator puts `--state <file>` BEFORE the subcommand.
const argv = process.argv.slice(2);
const opt = (name) => {
	const i = argv.indexOf(`--${name}`);
	if (i === -1) return undefined;
	const v = argv[i + 1];
	argv.splice(i, 2);
	return v;
};
const STATE = opt("state");
const PHASE = opt("phase");
const RUN_BRANCH = opt("run-branch");
const INPUT = opt("input");
const INIT = { args: opt("args"), stamp: opt("stamp"), primary: opt("primary"), worktree: opt("worktree") };
const [cmd, KEY, ...REST] = argv;

// ------------------------------------------------------------------ shell helpers

/** Run and return trimmed stdout; throws on a non-zero exit. */
function sh(bin, args, { input } = {}) {
	return execFileSync(bin, args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] }).trim();
}
/** Run without throwing. `out` is stdout+stderr, tail-capped for reporting. */
function run(bin, args, env) {
	const r = spawnSync(bin, args, { encoding: "utf8", env, maxBuffer: 256 * 1024 * 1024 });
	const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
	return { code: r.status ?? 1, stdout: r.stdout ?? "", out: out.length > 4000 ? `...${out.slice(-4000)}` : out };
}
const git = (...a) => sh("git", a);
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

// ------------------------------------------------------------------ state file

function loadState() {
	if (!STATE) throw new Stop("usage", "--state <file> is required");
	return JSON.parse(fs.readFileSync(STATE, "utf8"));
}
/** Atomic replace: a crash mid-write must not leave a truncated state file. */
function saveState(state) {
	const tmp = `${STATE}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
	fs.renameSync(tmp, STATE);
}
function ticketOf(state, key) {
	const t = state.tickets.find((x) => x.id === key);
	if (!t) throw new Stop("usage", `${key} is not in ${STATE}`);
	return t;
}
const baseOf = (state) => state.baseBranch ?? "main";
/** Apply fields. A new commitSha invalidates every verdict not set in the same call. */
function apply(t, fields, phase, result) {
	const shaChanged = "commitSha" in fields && fields.commitSha !== t.commitSha;
	Object.assign(t, fields);
	if (shaChanged) for (const f of VERDICT_FIELDS) if (!(f in fields)) t[f] = null;
	t.history ??= [];
	t.history.push({ phase: phase ?? t.phase, at: now(), result: result ?? "recorded" });
}
/**
 * Saves even when fn throws, so what happened before a block is on record -
 * except a usage refusal, which by contract writes nothing at all.
 */
function mutate(key, fn) {
	const state = loadState();
	const t = ticketOf(state, key);
	let save = true;
	try {
		return fn(t, state);
	} catch (e) {
		if (e instanceof Stop && e.kind === "usage") save = false;
		throw e;
	} finally {
		if (save) {
			state.heartbeat = now();
			saveState(state);
		}
	}
}
/** A step may only act on a ticket that is live and in the phase it belongs to. */
function expectPhase(t, ...phases) {
	if (t.status === "done") throw new Stop("usage", `${t.id} is done; nothing records onto it`);
	if (t.status === "blocked") throw new Stop("usage", `${t.id} is blocked`);
	if (!phases.includes(t.phase)) throw new Stop("usage", `${t.id} is at phase ${t.phase}, not ${phases.join("/")}`);
}
/**
 * `--no-renames`, deletions included: with rename detection a moved file lists only its NEW
 * path, so moving a workflow or config out of a watched path would read as no gate change.
 */
const changedFiles = (base, to) =>
	git("diff", "--name-only", "--no-renames", `origin/${base}...${to}`).split("\n").filter(Boolean);
const isAncestor = (a, b) => run("git", ["merge-base", "--is-ancestor", a, b]).code === 0;
/** Pipeline decisions the orchestrator still has to post (never on a ticket the run does not own). */
const toPost = (t) =>
	t.noTracker ? [] : (t.clarification ?? []).filter((c) => c.decidedBy === "pipeline" && !c.posted);

// ------------------------------------------------------------------ git/gh helpers

const remoteHead = (branch) => {
	const line = git("ls-remote", "origin", `refs/heads/${branch}`);
	return line ? line.split(/\s+/)[0] : null;
};
const prView = (pr, fields) => JSON.parse(sh("gh", ["pr", "view", String(pr), "--json", fields]));
/**
 * Through the REST API, not `gh pr edit`: on this repo `gh pr edit` has failed
 * silently (it exits 0 having written nothing), so the body is also read back.
 */
function appendToPrBody(pr, text) {
	const body = prView(pr, "body").body;
	if (body.includes(text)) return true;
	sh("gh", ["api", "-X", "PATCH", `repos/{owner}/{repo}/pulls/${pr}`, "--input", "-"], {
		input: JSON.stringify({ body: `${body}\n\n${text}\n` }),
	});
	return prView(pr, "body").body.includes(text);
}
/**
 * Push exactly one branch ref. An explicit refspec plus --no-follow-tags means a
 * `push.followTags` config cannot carry a tag along: a bare-semver tag on origin
 * cuts a public Release (release.yml), which no run may do.
 */
function pushBranch(branch, lease) {
	const ref = `refs/heads/${branch}:refs/heads/${branch}`;
	return lease
		? run("git", ["push", "--no-follow-tags", `--force-with-lease=refs/heads/${branch}:${lease}`, "origin", ref])
		: run("git", ["push", "--no-follow-tags", "origin", ref]);
}

/**
 * CI's gates, in CI's order. Build strictly before test: tests/release.test.ts
 * reads the built main.js. NRL_SKIP_REAL_SPEECHD is removed: CI sets it because
 * its runner has no speech-dispatcher; this machine has one, and a skipped
 * engine check must never read as a full run (AGENTS.md).
 */
function runGates() {
	const env = { ...process.env };
	delete env.NRL_SKIP_REAL_SPEECHD;
	for (const script of ["typecheck", "lint", "build", "test"]) {
		const r = run("npm", ["run", script], env);
		if (r.code !== 0) return { ok: false, gate: `npm run ${script}`, output: r.out };
	}
	return { ok: true };
}

// ------------------------------------------------------------------ commands

/** Parse `$ARGUMENTS`. Flags are DERIVED here, never typed into a template by hand. */
function parseArgs(raw) {
	const out = { keys: [], all: false, build: false, noMerge: false, keepWorktree: false };
	for (const tok of String(raw ?? "").split(/[\s,]+/).filter(Boolean)) {
		if (tok === "all") out.all = true;
		else if (tok === "--build") out.build = true;
		else if (tok === "--no-merge") out.noMerge = true;
		else if (tok === "--keep-worktree") out.keepWorktree = true;
		else if (/^[1-9][0-9]{0,5}$/.test(tok)) out.keys.push(`NRL-${tok}`);
		else if (/^nrl-[1-9][0-9]{0,5}$/i.test(tok)) out.keys.push(tok.toUpperCase());
		else throw new Stop("usage", `unrecognised argument ${JSON.stringify(tok)} (--resume is handled before init)`);
	}
	if (out.all === (out.keys.length > 0)) throw new Stop("usage", "give ticket keys or `all`, not both and not neither");
	out.keys = [...new Set(out.keys)];
	return out;
}

const commands = {
	init() {
		if (!STATE) throw new Stop("usage", "--state <file> is required");
		for (const [k, v] of Object.entries({ ...INIT, "run-branch": RUN_BRANCH }))
			if (k !== "args" && !v) throw new Stop("usage", `init needs --${k}`);
		const args = parseArgs(INIT.args);
		if (fs.existsSync(STATE)) throw new Stop("error", `${STATE} exists: a stamp collision; re-run, never reuse it`);
		const state = {
			runId: now(), stamp: INIT.stamp, primary: INIT.primary, worktree: INIT.worktree,
			runBranch: RUN_BRANCH, baseBranch: "main", noMerge: args.noMerge, build: args.build,
			keepWorktree: args.keepWorktree, tickets: [],
		};
		// `wx`: exclusive create, so two runs minting the same stamp cannot both claim it.
		fs.writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx" });
		return { ok: true, ...args };
	},

	add() {
		const state = loadState();
		if (state.tickets.some((t) => t.id === KEY)) return { ok: true, existed: true };
		state.tickets.push({
			id: KEY, status: "pending", phase: "start", fixRound: 0,
			clarification: [], trackerWrites: [], history: [],
		});
		state.heartbeat = now();
		saveState(state);
		return { ok: true, existed: false };
	},

	show() {
		const t = ticketOf(loadState(), KEY);
		const fields = REST[0]?.split(",");
		return fields ? Object.fromEntries(fields.map((f) => [f, t[f] ?? null])) : t;
	},

	/** The single write path for agent and orchestrator results. stdin: one JSON object. */
	record() {
		const allowed = FIELDS_BY_PHASE[PHASE];
		if (!allowed) throw new Stop("usage", `--phase must be one of ${Object.keys(FIELDS_BY_PHASE)}`);
		let input;
		try {
			input = JSON.parse(fs.readFileSync(INPUT ?? 0, "utf8"));
		} catch (e) {
			throw new Stop("usage", `malformed return: ${e.message}`);
		}
		if (!OBJ(input)) throw new Stop("usage", "return must be one JSON object");
		const { result, note, ...rest } = input;
		if (!RESULTS[PHASE].includes(result)) throw new Stop("usage", `result ${JSON.stringify(result)} is not one of ${PHASE}'s`);
		if (note !== undefined && typeof note !== "string") throw new Stop("usage", "note must be a string");
		const fields = {};
		const dropped = [];
		for (const [k, v] of Object.entries(rest)) allowed.includes(k) ? (fields[k] = v) : dropped.push(k);
		const bad = Object.entries(fields).filter(([k, v]) => !SHAPE[k]?.(v)).map(([k]) => k);
		if (bad.length) throw new Stop("usage", `malformed field(s): ${bad.join(", ")}`);
		const { clarificationAdd = [], trackerWrite, postedQuestions = [] } = fields;
		delete fields.clarificationAdd;
		delete fields.trackerWrite;
		delete fields.postedQuestions;

		return mutate(KEY, (t, state) => {
			if (PHASE === "triage") {
				if (t.status !== "pending" || t.phase !== "start") throw new Stop("usage", `${KEY} is past triage`);
			} else if (PHASE === "orchestrator") {
				// A done ticket takes only the record of a tracker write (the Done transition itself).
				const stateFields = Object.keys(fields).filter((k) => !["trackerWrite", "postedQuestions"].includes(k));
				if (t.status === "done" && (stateFields.length || result)) throw new Stop("usage", `${KEY} is done; nothing records onto it`);
			} else {
				expectPhase(t, PHASE);
			}
			// A verdict that names any commit but the current pushed one describes nothing the
			// run will merge. `null` is not a commit: nothing pushed means nothing to grade.
			for (const [verdict, sha] of [["criticVerdict", "criticSha"], ["verifyVerdict", "verifiedSha"]]) {
				if (!(verdict in fields)) continue;
				if (!t.commitSha) throw new Stop("usage", `${verdict} recorded before anything was pushed`);
				if (fields[sha] !== t.commitSha)
					throw new Stop("usage", `${verdict} is for ${fields[sha]}, not commitSha ${t.commitSha}`);
			}
			// The base Verify graded against is checked, not trusted: it must be a commit that was
			// on origin/main and that the graded head contains. `merge` then compares it with the
			// base as it is at merge time.
			if (fields.verifyVerdict === "pass") {
				const b = fields.verifiedBaseSha;
				if (!b) throw new Stop("usage", "verify pass without verifiedBaseSha");
				if (!isAncestor(b, `origin/${baseOf(state)}`) || !isAncestor(b, t.commitSha))
					throw new Stop("usage", `verifiedBaseSha ${b} is not an origin/${baseOf(state)} commit contained in ${t.commitSha}`);
			}
			// A Fix may only move to `<branch>-followup` (PR merged outside the run), and only
			// as a pair with clearing the PR: half a switch fails every later Ship until the cap.
			if (fields.branch === t.branch) delete fields.branch;
			if ("prNumber" in fields && fields.prNumber === t.prNumber) delete fields.prNumber;
			const followup = "branch" in fields && fields.branch === `${t.branch}-followup`;
			if ("branch" in fields && !followup) throw new Stop("usage", `branch may only become ${t.branch}-followup`);
			if ("prNumber" in fields && !(followup && fields.prNumber === null))
				throw new Stop("usage", "prNumber may only be cleared, and only with the -followup switch");
			if (followup) Object.assign(fields, { prNumber: null, prUrl: null });

			if (result === "blocked") {
				fields.status = "blocked";
				fields.blockedReason ??= note ?? "blocked (no reason given)";
			} else if (result === "handoff") {
				if (!fields.handoff) throw new Stop("usage", "result handoff without a handoff note");
				fields.phase = PHASE;
			} else if (NEXT[PHASE]) {
				// Critic and Verify route on their verdict, so a result without one routes nowhere.
				const verdict = { critic: "criticVerdict", verify: "verifyVerdict" }[PHASE];
				if (verdict && fields[verdict] !== result)
					throw new Stop("usage", `result ${result} without a matching ${verdict}`);
				fields.phase = NEXT[PHASE][result];
				if (!("handoff" in fields)) fields.handoff = null;
			}
			apply(t, fields, PHASE, [result, note].filter(Boolean).join(": ") || undefined);

			t.clarification ??= [];
			for (const c of clarificationAdd) {
				if (!c?.question || t.clarification.some((x) => x.question === c.question)) continue;
				t.clarification.push({ ...c, decidedBy: c.decidedBy ?? "pipeline", posted: false });
			}
			for (const q of postedQuestions) {
				const c = t.clarification.find((x) => x.question === q);
				if (c) c.posted = true;
			}
			if (trackerWrite) {
				t.trackerWrites ??= [];
				t.trackerWrites.push({ ...trackerWrite, at: now() });
			}
			return { ok: true, phase: t.phase, status: t.status, dropped, toPost: toPost(t) };
		});
	},

	/** stdin: {"title","description","type"} read by the orchestrator from Linear. */
	start() {
		if (!RUN_BRANCH) throw new Stop("usage", "--run-branch is required");
		let issue;
		try {
			issue = JSON.parse(fs.readFileSync(INPUT ?? 0, "utf8"));
		} catch (e) {
			throw new Stop("usage", `start needs the issue as JSON: ${e.message}`);
		}
		if (!OBJ(issue) || !STR(issue.title ?? null) || !STR(issue.description ?? null))
			throw new Stop("usage", "start input must be {title, description, type}");
		return mutate(KEY, (t, state) => {
			if (t.status === "done" || t.status === "blocked" || t.phase !== "start")
				throw new Stop("usage", `${KEY} is ${t.status} at ${t.phase}, not ready to start`);
			const base = baseOf(state);
			if (git("status", "--porcelain")) throw new Stop("error", "lane is not clean before Start");
			git("fetch", "origin");
			// Another run may have merged since Step 0d; the lane is clean, so resync.
			if (!t.branch && git("rev-parse", RUN_BRANCH) !== git("rev-parse", `origin/${base}`)) {
				git("checkout", RUN_BRANCH);
				git("reset", "--hard", `origin/${base}`);
			}
			const type = t.type ?? (SHAPE.type(issue.type) ? issue.type : "feature");
			const slug = String(issue.title ?? "")
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-+/, "")
				.slice(0, 50)
				.replace(/-+$/, "");
			const kind = type === "bug" ? "fix" : type === "docs" ? "docs" : "feature";
			const branch = t.branch ?? `${kind}/${KEY.toLowerCase()}${slug ? `-${slug}` : ""}`;
			const local = run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).code === 0;
			if (t.branch && local) {
				git("checkout", branch); // resume: the branch is ours
			} else {
				if (local || remoteHead(branch)) throw new Stop("blocked", `branch collision: ${branch} exists`);
				git("checkout", "--no-track", "-b", branch, RUN_BRANCH);
			}
			apply(t, {
				title: t.title ?? issue.title ?? null,
				type,
				descriptionSnapshot: t.descriptionSnapshot ?? issue.description ?? null,
				branch,
				status: "in_progress",
				phase: "build",
			}, "start", `branch ${branch}`);
			return { ok: true, branch, type };
		});
	},

	ship() {
		return mutate(KEY, (t, state) => {
			expectPhase(t, "ship");
			const base = baseOf(state);
			const fail = (reason, output = "") => {
				apply(t, { verifyFindings: `Ship failed: ${reason}\n${output}`.trim(), phase: "fix" }, "ship", `fail: ${reason}`);
				return { ok: false, route: "fix", reason };
			};
			if (git("branch", "--show-current") !== t.branch) throw new Stop("error", `lane is not on ${t.branch}`);
			if (git("status", "--porcelain")) return fail("uncommitted changes in the lane");
			if (/^wip:/m.test(git("log", "--format=%s", `origin/${base}..HEAD`)))
				return fail("a wip: commit is still on the branch - squash it before shipping");

			// Whether the base moved is decided here, from git, never from an agent's note: a head
			// that does not contain origin/main would be graded against code it does not include.
			git("fetch", "origin");
			if (!isAncestor(`origin/${base}`, "HEAD")) {
				const r = run("git", ["-c", "core.editor=true", "rebase", `origin/${base}`]);
				if (r.code !== 0) {
					run("git", ["rebase", "--abort"]);
					return fail(`origin/${base} moved and the rebase onto it conflicts - resolve it`, r.out);
				}
			}
			const head = git("rev-parse", "HEAD");
			const gatesChanged = changedFiles(base, head).some((f) => GATE_DEFINING.test(f));
			if (head !== t.gatedSha || gatesChanged) {
				const gates = runGates();
				if (!gates.ok) return fail(`gate ${gates.gate}`, gates.output);
			}

			if (t.prNumber) {
				const pr = prView(t.prNumber, "state,baseRefName");
				if (pr.state === "MERGED") return fail("PR was merged outside the run - work on a -followup branch");
				// Pushing to a closed PR never moves its head, so Verify would fail forever: owner's call.
				if (pr.state === "CLOSED") throw new Stop("blocked", `PR #${t.prNumber} was closed unmerged`);
				if (pr.baseRefName !== base) return fail(`PR base is ${pr.baseRefName}, not ${base}`);
			}

			// Lease against what the run last pushed, so a commit someone else pushed is never
			// overwritten. `remote === head` is a push that landed but reported failure: ours.
			const remote = remoteHead(t.branch);
			if (remote && remote !== t.commitSha && remote !== head)
				throw new Stop("blocked", `${t.branch} on origin is ${remote}, not the run's ${t.commitSha}`);
			if (remote !== head) {
				const push = pushBranch(t.branch, remote);
				if (push.code !== 0 && remoteHead(t.branch) !== head) return fail("push refused", push.out);
			}
			if (remoteHead(t.branch) !== head) return fail("push did not read back as HEAD");
			// Record the push before anything else can fail: a retry must recognise it as ours.
			if (t.commitSha !== head) apply(t, { commitSha: head, mergeAttempts: 0 }, "ship", `pushed ${head.slice(0, 8)}`);

			let { prNumber, prUrl } = t;
			if (!prNumber) {
				// A crash between `gh pr create` and the state write leaves a PR the state does not
				// know. Adopt it, or every retry fails on "a PR already exists" until the Fix cap.
				const open = JSON.parse(sh("gh", ["pr", "list", "--head", t.branch, "--state", "open", "--json", "number,url,baseRefName"]));
				if (open.length > 1) throw new Stop("blocked", `${open.length} open PRs for ${t.branch}`);
				if (open.length === 1) {
					if (open[0].baseRefName !== base) return fail(`open PR #${open[0].number} is based on ${open[0].baseRefName}, not ${base}`);
					({ number: prNumber, url: prUrl } = open[0]);
				}
			}
			const round = t.roundNote ? `Round ${t.fixRound}: ${t.roundNote}` : null;
			if (!prNumber) {
				const body = [
					t.prBody ?? t.implementationSummary ?? "",
					round,
					"NOT VERIFIED IN OBSIDIAN",
					`Resolves ${KEY}`,
					"🤖 Generated with [Claude Code](https://claude.com/claude-code)",
				].filter(Boolean).join("\n\n");
				const title = t.prTitle ?? git("log", "-1", "--format=%s");
				const created = run("gh", ["pr", "create", "--base", base, "--head", t.branch, "--title", title, "--body", body]);
				const m = created.stdout.match(/https:\/\/\S+\/pull\/(\d+)/);
				if (created.code !== 0 || !m) return fail("gh pr create failed", created.out);
				prUrl = m[0];
				prNumber = Number(m[1]);
			} else if (round && !appendToPrBody(prNumber, round)) {
				return fail("PR body Round line did not read back");
			}
			apply(t, { prNumber, prUrl, roundNote: null, phase: "critic" }, "ship", `PR #${prNumber}`);
			return { ok: true, prNumber, prUrl, commitSha: head, gatesChanged };
		});
	},

	/** Critic depth from .claude/commands/critique.md Step 3's factors, plus the pipeline's own. */
	risk() {
		const state = loadState();
		const t = ticketOf(state, KEY);
		if (!t.commitSha) throw new Stop("usage", `${KEY} has no pushed commit`);
		const range = `origin/${baseOf(state)}...${t.commitSha}`;
		// Unfiltered: a deletion (of a guard, a test, this script) is the change most worth reviewing.
		const files = changedFiles(baseOf(state), t.commitSha);
		const diff = git("diff", "-U0", "--no-renames", range);
		const changed = []; // [file, line] for every added or removed line
		let file = null;
		for (const line of diff.split("\n")) {
			if (line.startsWith("+++ ")) file = line.slice(4).replace(/^b\//, "");
			else if (/^[+-](?![+-]{2} )/.test(line) && file) changed.push([file, line]);
		}
		const has = (re) => files.some((f) => re.test(f));
		const lines = (fileRe, re) => changed.some(([f, l]) => fileRe.test(f) && re.test(l));
		const added = (fileRe, re) => changed.some(([f, l]) => l.startsWith("+") && fileRe.test(f) && re.test(l));
		const [plus, minus] = [changed.filter(([, l]) => l.startsWith("+")).length, changed.filter(([, l]) => l.startsWith("-")).length];
		const factors = [];
		const add = (name, w, hit) => hit && factors.push([name, w]);
		add("source-offset mapping", 2, has(/^src\/(text\/extract|audio\/words)\.ts$/));
		add("log or error call site", 2, has(/^src\/diagnostics\.ts$/) || added(/^src\//, /\b(trace|reportError)\(|new (Notice|Error)\(|console\./));
		add("Kokoro network guards", 2, lines(/^src\/engines\/onnx\//, /isRemote|assertLocal|installFetchShim|resolveLocal|allowRemoteModels|useFS|wasmPaths/));
		add("rate handling", 2, lines(/^src\/(audio|engines)\//, /ownsPlayback|playbackRate|req\.rate|setRate|\bspeed\b/));
		add("settings normalisation", 2, lines(/^src\/settings\/index\.ts$/, /normaliseSettings|DEFAULT_SETTINGS/) || added(/^src\//, /saveData\(/));
		add("node builtin", 2, has(/^src\/engines\/(system\/spawn|registry)\.ts$/) || added(/^src\//, /child_process|from ["'](node:)?(fs|path|os)["']|["']node:/));
		const gatesChanged = has(GATE_DEFINING);
		add("changes the gates that grade it", 4, gatesChanged);
		add("worker or bundle boundary", 1, has(/^(esbuild\.config\.mjs|manifest\.json)$|kokoro\.worker\.ts$|browser-environment\.ts$/));
		add("engine contract", 1, has(/^src\/audio\/types\.ts$/));
		add("no test changes alongside code", 1, has(/^src\//) && !has(/^tests\//));
		add("dependency manifest", 1, has(/^package\.json$/));
		add("deletes more than it adds", 1, minus > plus);
		add("more than 8 files", 1, files.length > 8);
		const score = factors.reduce((n, [, w]) => n + w, 0);
		// critique.md: a workflow change is always at least L2 - it reaches every later session.
		const floor = has(/^\.claude\//) ? 2 : 0;
		return {
			ok: true, score,
			depth: score >= 4 ? "L2+Double" : Math.max(score, floor) >= 2 ? "L2" : "L1",
			factors: factors.map((f) => f[0]),
			gatesChanged,
			files: files.length,
		};
	},

	"pr-append"() {
		const t = ticketOf(loadState(), KEY);
		if (!t.prNumber) throw new Stop("usage", `${KEY} has no PR`);
		const text = fs.readFileSync(REST[0], "utf8").trim();
		if (!appendToPrBody(t.prNumber, text)) throw new Stop("error", "PR body did not read back");
		return { ok: true };
	},

	/** Preflight only: prints the merge for the orchestrator to run as plain Bash. */
	merge() {
		return mutate(KEY, (t, state) => {
			expectPhase(t, "merge");
			const base = baseOf(state);
			// Must be an explicit false: a state file from before the field cannot prove the
			// run was allowed to merge. Blocks the ticket (PR left open), never the run.
			if (state.noMerge !== false) throw new Stop("blocked", "run is --no-merge (or predates noMerge): PR left open");
			const sha = t.commitSha;
			if (!sha || !["pass", "concerns"].includes(t.criticVerdict) || t.verifyVerdict !== "pass"
				|| t.criticSha !== sha || t.verifiedSha !== sha)
				throw new Stop("error", "merge called without both verdicts on the current commitSha");
			// The base is pinned as well as the head: Verify graded this commit against one
			// origin/main, and a parallel run (or a hand merge) may have moved it since.
			git("fetch", "origin");
			const baseNow = git("rev-parse", `origin/${base}`);
			if (!t.verifiedBaseSha) throw new Stop("error", "merge called without verifiedBaseSha");
			if (baseNow !== t.verifiedBaseSha) {
				// Back to Ship, which rebases mechanically (or fails to Fix on a conflict); the new
				// head then needs a fresh critic and Verify. Not a Fix round: nothing was wrong.
				apply(t, { phase: "ship" }, "merge", `base moved ${t.verifiedBaseSha.slice(0, 8)} -> ${baseNow.slice(0, 8)}`);
				return { ok: true, route: "ship", reason: "base moved since Verify" };
			}
			const files = changedFiles(base, sha);
			// A gate change merges only when EVERY critic that reviewed this head justified it.
			if (files.some((f) => GATE_DEFINING.test(f))) {
				const reviews = t.gateReviews ?? [];
				if (reviews.length < 2 || !reviews.every((r) => r.justified))
					throw new Stop("blocked", `changes the gates that grade it, and ${reviews.length < 2 ? "fewer than two critics reviewed that" : "not every critic justified it"}`);
			}
			const surface = files.filter((f) => RELEASE_SURFACE.includes(f));
			if (surface.length) throw new Stop("blocked", `touches the release surface (${surface.join(", ")}): the owner merges`);
			const pr = prView(t.prNumber, "state,baseRefName,headRefOid");
			// Merged by us or by hand, what merged must be the commit that was graded.
			if (pr.headRefOid !== sha) throw new Stop("blocked", `PR head ${pr.headRefOid} is not the graded ${sha}`);
			if (pr.state === "CLOSED") throw new Stop("blocked", `PR #${t.prNumber} was closed unmerged`);
			if (pr.state === "MERGED") return { ok: true, run: [] };
			if (pr.baseRefName !== base) throw new Stop("blocked", `PR base is ${pr.baseRefName}`);
			t.mergeAttempts = (t.mergeAttempts ?? 0) + 1;
			if (t.mergeAttempts > 2) throw new Stop("blocked", "gh pr merge did not land in two attempts");
			return { ok: true, run: [`gh pr merge ${t.prNumber} --squash --match-head-commit ${sha}`] };
		});
	},

	/** After the orchestrator ran `gh pr merge`: read the PR back, never trust the exit code. */
	merged() {
		return mutate(KEY, (t, state) => {
			expectPhase(t, "merge");
			const sha = t.commitSha;
			const s = prView(t.prNumber, "state,mergeable,headRefOid,mergeCommit");
			if (s.state !== "MERGED") {
				if (s.headRefOid !== sha) throw new Stop("blocked", "PR head moved after Verify; someone else pushed");
				if (s.mergeable === "CONFLICTING") {
					apply(t, { verifyFindings: `Merge conflict with origin/${baseOf(state)}; rebase.`, phase: "fix" }, "merge", "conflict");
					return { ok: false, route: "fix", reason: "conflict" };
				}
				// `mergeable` is computed lazily and a fresh PR reads UNKNOWN; `merge` caps retries.
				spawnSync("sleep", ["10"]);
				return { ok: true, retry: true };
			}
			if (s.headRefOid !== sha) throw new Stop("error", "PR reads back MERGED at a head that was not graded");
			// The code is on main from here on: record it before anything can block.
			apply(t, { mergeCommit: s.mergeCommit?.oid ?? null, phase: "finish" }, "merge", "merged");
			// Delete the remote branch only when it holds exactly what merged.
			const remote = remoteHead(t.branch);
			if (remote && remote !== sha) throw new Stop("blocked", `merged; origin/${t.branch} moved to ${remote} after, so it was kept`);
			return {
				ok: true,
				mergeCommit: s.mergeCommit?.oid ?? null,
				run: remote ? [`gh api -X DELETE "repos/{owner}/{repo}/git/refs/heads/${t.branch}"`] : [],
			};
		});
	},

	finish() {
		if (!RUN_BRANCH) throw new Stop("usage", "--run-branch is required");
		return mutate(KEY, (t, state) => {
			expectPhase(t, "finish");
			if (!t.mergeCommit) throw new Stop("usage", `${KEY} has no recorded merge commit`);
			if (git("status", "--porcelain")) {
				git("add", "-A");
				git("commit", "-m", "wip: left after merge", "--no-verify");
				throw new Stop("blocked", "lane had uncommitted work after merge; committed as wip on the ticket branch, not pushed");
			}
			git("checkout", RUN_BRANCH);
			git("fetch", "origin");
			git("reset", "--hard", `origin/${baseOf(state)}`);
			if (remoteHead(t.branch)) throw new Stop("blocked", `merged, but origin/${t.branch} was not deleted (run merged's command)`);
			// Squash-merge makes `git branch -d` lie. Delete only when the local branch IS the merged head.
			const local = run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${t.branch}`]);
			if (local.code === 0) {
				if (local.stdout.trim() !== t.commitSha)
					throw new Stop("blocked", `local ${t.branch} holds commits that were not merged`);
				git("branch", "-D", t.branch);
			}
			apply(t, { status: "done", phase: "finish" }, "finish", "done");
			// The run never moves a ticket it does not own.
			return { ok: true, tracker: t.noTracker ? "skip" : "Done" };
		});
	},

	halt() {
		const state = loadState();
		const t = ticketOf(state, KEY);
		if (t.status !== "in_progress") throw new Stop("usage", `${KEY} is ${t.status}`);
		state.halted = KEY;
		apply(t, { status: "blocked", blockedReason: `Fix cap reached after ${t.fixRound} rounds: needs the owner` }, "fix", "halted");
		state.heartbeat = now();
		saveState(state);
		return { ok: true, halted: KEY };
	},

	unhalt() {
		const state = loadState();
		if (state.halted !== KEY) throw new Stop("usage", `run is not halted on ${KEY}`);
		const t = ticketOf(state, KEY);
		delete state.halted;
		apply(t, { status: "in_progress", phase: "fix", fixRound: 0, blockedReason: null }, "fix", "resumed after halt");
		state.heartbeat = now();
		saveState(state);
		return { ok: true };
	},
};

// ------------------------------------------------------------------ main

try {
	if (!commands[cmd]) throw new Stop("usage", `commands: ${Object.keys(commands).join(" | ")}`);
	if (cmd !== "init" && !KEY_RE.test(KEY ?? "")) throw new Stop("usage", `${cmd} needs a ticket key matching ${KEY_RE}`);
	const out = commands[cmd]();
	console.log(JSON.stringify(out));
	process.exitCode = out?.ok === false ? EXIT.fail : EXIT.ok;
} catch (e) {
	const kind = e instanceof Stop ? e.kind : "error";
	if (kind === "blocked" && STATE && KEY_RE.test(KEY ?? "")) {
		try {
			mutate(KEY, (t) => apply(t, { status: "blocked", blockedReason: e.message }, cmd, `blocked: ${e.message}`));
		} catch {
			// The block is still reported on stdout and by the exit code.
		}
	}
	console.log(JSON.stringify({ ok: false, [kind]: e.message }));
	process.exitCode = EXIT[kind] ?? EXIT.error;
}
