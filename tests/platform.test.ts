/**
 * Linux-desktop construction gate (NRL-27, R-M01, srs.md:1023-1027).
 *
 * Pure over `PlatformFlags`, mirroring tests/engineSelection.test.ts's style:
 * a plain `check()` harness, no obsidian import needed since platform.ts has
 * none (registry.ts does import "obsidian" at module scope and cannot be
 * bundled for this bare-Node harness; that is why the predicate was
 * extracted into its own module rather than tested through registry.ts).
 *
 * This is the entire fix: `shouldConstructLinuxDesktopEngines` is the exact
 * boolean expression the spec gives (`Platform.isDesktopApp &&
 * Platform.isLinux`), so proving its truth table here proves the predicate
 * correct for every platform combination. What it does NOT prove: that the
 * real `Platform` object reports these flags correctly on macOS or Windows,
 * or that registry.ts actually calls this function at the right place -
 * those need a real Obsidian build (AGENTS.md rule 11) and a source read
 * respectively.
 */

import {
	shouldConstructLinuxDesktopEngines,
	type PlatformFlags,
} from "../src/engines/platform.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
	if (cond) console.log(`  ok   ${name}`);
	else {
		failures += 1;
		console.log(`  FAIL ${name} ${detail}`);
	}
}

const linuxDesktop: PlatformFlags = { isDesktopApp: true, isLinux: true };
const macOrWindowsDesktop: PlatformFlags = { isDesktopApp: true, isLinux: false };
const mobileLinuxIfItExisted: PlatformFlags = { isDesktopApp: false, isLinux: true };
const mobile: PlatformFlags = { isDesktopApp: false, isLinux: false };

console.log("Linux desktop: true (today's fix target, unchanged from before)");
check(
	"isDesktopApp=true, isLinux=true -> true",
	shouldConstructLinuxDesktopEngines(linuxDesktop) === true,
);

console.log("macOS/Windows desktop: false (the bug this ticket closes)");
check(
	"isDesktopApp=true, isLinux=false -> false",
	shouldConstructLinuxDesktopEngines(macOrWindowsDesktop) === false,
);

console.log("isLinux alone is not enough: isDesktopApp=false vetoes construction");
check(
	"isDesktopApp=false, isLinux=true -> false",
	shouldConstructLinuxDesktopEngines(mobileLinuxIfItExisted) === false,
);

console.log("mobile: false (unchanged from before this ticket)");
check(
	"isDesktopApp=false, isLinux=false -> false",
	shouldConstructLinuxDesktopEngines(mobile) === false,
);

console.log("");
if (failures > 0) {
	console.log(`${failures} FAILURE(S)`);
	process.exit(1);
}
console.log("all platform gating tests passed");
