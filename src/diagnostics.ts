import { Notice, type App } from "obsidian";

const LOG_NAME = "local-tts-diagnostics.log";
const writes = new WeakMap<App, Promise<void>>();

/** Local diagnostic metadata only; never log note text. */
export function trace(app: App, manifestDir: string, step: string, detail?: unknown): void {
	// Typed unknown so String() takes the value as given; `detail ?? ""` alone
	// would type as `{}`, which the linter reads as a possible [object Object].
	const fallback: unknown = detail ?? "";
	const error = detail instanceof Error
		? [detail.stack ?? detail.message,
			(detail as Error & { workerStack?: string }).workerStack].filter(Boolean).join("\n")
		: String(fallback);
	const body = `[${new Date().toISOString()}] ${manifestDir}: ${step}\n${error}\n\n`;
	// Serialize read-modify-write operations so simultaneous trace events do not
	// overwrite each other. Keep the log bounded across long reading sessions.
	const next = (writes.get(app) ?? Promise.resolve()).then(async () => {
		const adapter = app.vault.adapter;
		const existing = await adapter.exists(LOG_NAME) ? await adapter.read(LOG_NAME) : "";
		await adapter.write(LOG_NAME, (existing + body).slice(-256 * 1024));
	}).catch(err => console.error("Local TTS diagnostics write failed", err));
	writes.set(app, next);
}

export function reportError(app: App, manifestDir: string, context: string, err: unknown): void {
	new Notice(`Local TTS Reader: ${err instanceof Error ? err.message : String(err)}`, 10000);
	trace(app, manifestDir, context, err);
}
