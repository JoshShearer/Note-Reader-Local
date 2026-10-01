/**
 * Which platform gets the subprocess-backed engines (NRL-27, srs.md, R-M02
 * Linux Support).
 *
 * No obsidian import, following src/engines/selection.ts and
 * src/ui/affordances.ts: the guard itself is the part worth testing, and the
 * tests run in plain Node. `Platform` (the real obsidian export) satisfies
 * `PlatformFlags` structurally, so registry.ts can pass it straight through
 * with no conversion.
 */

export interface PlatformFlags {
	isDesktopApp: boolean;
	isLinux: boolean;
}

/**
 * Only Linux desktop gets `EspeakEngine`/`SpeechDispatcherEngine` (both wrap
 * Linux-only system binaries: `espeak-ng`, `spd-say`). Deliberately does not
 * take `isMobile`: it is redundant with `isDesktopApp` (a mobile device is
 * never `isDesktopApp: true`), and the spec's own guard does not read it
 * either: srs.md's "Linux Backend" section, which serves R-M02 Linux Support,
 * requires only that "Desktop-only Node functionality MUST be loaded only
 * after determining that the plugin is running on Linux desktop."
 */
export function shouldConstructLinuxDesktopEngines(platform: PlatformFlags): boolean {
	return platform.isDesktopApp && platform.isLinux;
}
