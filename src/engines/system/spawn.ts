import type { ChildProcessWithoutNullStreams } from "child_process";

/**
 * Thin wrapper over child_process so engines stay testable and so nothing
 * imports node builtins on a path that could run on mobile.
 *
 * Obsidian's desktop build has nodeIntegration on, so this is available in the
 * renderer. It is only ever constructed on Linux desktop, though: registry.ts
 * gates EspeakEngine/SpeechDispatcherEngine construction on
 * `Platform.isDesktopApp && Platform.isLinux`, so a macOS or Windows desktop
 * never reaches this file's NodeProcessRunner any more than mobile does.
 */

export interface RunResult {
	stdout: Buffer;
	stderr: string;
	code: number;
	/**
	 * The signal that terminated the child, or null if it exited on its own.
	 *
	 * `code` deliberately cannot carry this. A terminated child closes with a
	 * null exit code and `run()` resolves `code ?? 0`, which is load-bearing:
	 * speechd.ts's Stop SIGKILLs its own spd-say and must keep reading that as a
	 * success (NRL-41). The cost is that any other kill - a deadline, an OOM
	 * killer, a stray `pkill` - also arrives looking like a clean exit that
	 * simply printed less, and a silently truncated stdout is worse than a
	 * missing one for anything that reasons about what was *absent* from the
	 * output. This field is the only way to tell the two apart, so a caller that
	 * cannot tolerate truncation checks it.
	 *
	 * Required rather than optional on purpose: a forgotten optional field reads
	 * as "not signal-terminated", which is the unsafe default, so the compiler
	 * is made to point at every construction site instead.
	 */
	signal: NodeJS.Signals | null;
}

export interface ProcessRunner {
	/** Run to completion, optionally writing `stdin`. */
	run(cmd: string, args: string[], stdin?: string, signal?: AbortSignal): Promise<RunResult>;
	/** Start a long-lived process, e.g. one that talks to an audio daemon. */
	spawn(cmd: string, args: string[]): Promise<ChildProcessWithoutNullStreams>;
	/** Resolve the absolute path of an executable, or null if not on PATH. */
	which(cmd: string): Promise<string | null>;
}

/**
 * Load child_process at call time, never at module scope (AGENTS.md rule 7,
 * docs/adr/0033).
 *
 * A native `import("child_process")` cannot work in Obsidian: esbuild leaves a
 * dynamic import of an external untouched, and the renderer's ESM loader has
 * no resolution for a bare builtin specifier, so it throws "Failed to resolve
 * module specifier 'child_process'". Every run() then rejected, which() caught
 * that as "not on PATH", and both Linux engines reported themselves missing on
 * a machine where spd-say and espeak-ng were installed (NRL-135). The CJS
 * `require` that nodeIntegration provides is what resolves builtins there.
 * The ESM test bundles get a real `require` from build-tests.mjs's banner, so
 * no import() fallback is needed and none may come back: CI fails the build
 * if main.js holds an `import()` of any node builtin.
 */
function loadChildProcess(): typeof import("child_process") {
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- mobile safety (AGENTS.md rule 7, docs/adr/0033): a call-time CJS require is the only form that resolves a builtin in Obsidian's renderer, is never evaluated on mobile, and import() must never replace it
	return require("child_process") as typeof import("child_process");
}

class NodeProcessRunner implements ProcessRunner {
	async run(
		cmd: string,
		args: string[],
		stdin?: string,
		signal?: AbortSignal,
	): Promise<RunResult> {
		const { spawn } = loadChildProcess();
		return await new Promise<RunResult>((resolve, reject) => {
			const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
			const stdout: Buffer[] = [];
			const stderr: string[] = [];

			child.stdout.on("data", (d: Buffer) => stdout.push(d));
			child.stderr.on("data", (d: Buffer) => stderr.push(d.toString()));

			const onAbort = (): void => {
				child.kill("SIGKILL");
			};
			signal?.addEventListener("abort", onAbort, { once: true });

			child.on("error", (err) => {
				signal?.removeEventListener("abort", onAbort);
				reject(err);
			});
			// `close` passes (code, killedBy): exactly one of the two is non-null.
			// `code ?? 0` stays as it is - see RunResult.signal for why - so the
			// second argument is reported alongside it rather than folded into it.
			child.on("close", (code, killedBy) => {
				signal?.removeEventListener("abort", onAbort);
				resolve({
					stdout: Buffer.concat(stdout),
					stderr: stderr.join(""),
					code: code ?? 0,
					signal: killedBy,
				});
			});

			// Always close stdin. A reader like `spd-say -e` waits for EOF before
			// it speaks, so writing without ending hangs it forever.
			child.stdin.end(stdin);
		});
	}

	async spawn(cmd: string, args: string[]): Promise<ChildProcessWithoutNullStreams> {
		const { spawn: nodeSpawn } = loadChildProcess();
		return nodeSpawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
	}

	async which(cmd: string): Promise<string | null> {
		try {
			const { stdout } = await this.run("which", [cmd]);
			const path = stdout.toString().trim();
			return path === "" ? null : path;
		} catch {
			return null;
		}
	}
}

let cached: ProcessRunner | null = null;

export function getProcessRunner(): ProcessRunner {
	if (!cached) cached = new NodeProcessRunner();
	return cached;
}
