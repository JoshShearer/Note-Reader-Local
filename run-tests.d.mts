/**
 * Types for run-tests.mjs (NRL-80).
 *
 * tests/suiteRegistry.test.ts imports `suitePathsFromPretest` to assert the
 * runner derives the same suite list `pretest` registers. Without this sidecar
 * `tsc --noEmit --skipLibCheck` fails that import with TS7016 (implicitly `any`,
 * no declaration file). With it, tsconfig.json needs no change: no `allowJs`,
 * no `include` edit. Only the exported surface is declared; the runner's
 * internals are deliberately not part of any contract.
 */

/** Built suite paths (`tests/.build/<name>.test.mjs`) in `pretest`'s textual order. */
export declare function suitePathsFromPretest(script: string): string[];
