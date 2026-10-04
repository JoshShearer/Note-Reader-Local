/** Minimal typed event emitter; enough for a plugin, small enough to read. */

export type Listener<T> = (payload: T) => void;

export class Emitter<Events extends Record<string, unknown>> {
	private handlers = new Map<keyof Events, Set<Listener<never>>>();

	on<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
		let set = this.handlers.get(event);
		if (!set) {
			set = new Set();
			this.handlers.set(event, set);
		}
		set.add(fn);
		return () => this.off(event, fn);
	}

	off<K extends keyof Events>(event: K, fn: Listener<Events[K]>): void {
		this.handlers.get(event)?.delete(fn);
	}

	emit<K extends keyof Events>(event: K, payload: Events[K]): void {
		const set = this.handlers.get(event);
		if (!set) return;
		for (const fn of [...set]) {
			try {
				(fn as Listener<Events[K]>)(payload);
			} catch (err) {
				// A broken listener must not take down playback.
				console.error("Local TTS Reader: listener threw", err);
			}
		}
	}

	clear(): void {
		this.handlers.clear();
	}
}
