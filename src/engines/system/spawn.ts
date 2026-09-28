import type { ChildProcessWithoutNullStreams } from "child_process";

/**
 * Thin wrapper over child_process so engines stay testable and so nothing
 * imports node builtins on a path that could run on mobile.
 *
 * Obsidian's desktop build has nodeIntegration on, so this is available in the
 * renderer. On mobile it is never constructed.
 */

export interface RunResult {
	stdout: Buffer;
	stderr: string;
	code: number;
}

export interface ProcessRunner {
	/** Run to completion, optionally writing `stdin`. */
	run(cmd: string, args: string[], stdin?: string, signal?: AbortSignal): Promise<RunResult>;
	/** Start a long-lived process, e.g. one that talks to an audio daemon. */
	spawn(cmd: string, args: string[]): Promise<ChildProcessWithoutNullStreams>;
	/** Resolve the absolute path of an executable, or null if not on PATH. */
	which(cmd: string): Promise<string | null>;
}

class NodeProcessRunner implements ProcessRunner {
	async run(
		cmd: string,
		args: string[],
		stdin?: string,
		signal?: AbortSignal,
	): Promise<RunResult> {
		const { spawn } = await import("child_process");
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
			child.on("close", (code) => {
				signal?.removeEventListener("abort", onAbort);
				resolve({ stdout: Buffer.concat(stdout), stderr: stderr.join(""), code: code ?? 0 });
			});

			if (stdin !== undefined) {
				child.stdin.write(stdin);
				return;
			}
			child.stdin.end();
		});
	}

	async spawn(cmd: string, args: string[]): Promise<ChildProcessWithoutNullStreams> {
		const { spawn: nodeSpawn } = await import("child_process");
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
