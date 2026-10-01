# 0033. child_process is require()d lazily, not import()ed

- Status: accepted
- Date: 2026-10-01
- Ticket: NRL-135 (R-M02 `srs.md:154`, "Linux desktop MUST support local speech synthesis")
- Amends: `AGENTS.md` non-negotiable 7 (the `main.js` `require()` allowlist), the
  `Assert main.js require() list` step in `.github/workflows/ci.yml`, and the rule 7 rows in
  `.claude/commands/` (`ship.md`, `start-issue.md`, `orient.md`, `create-issue.md`,
  `run-tickets.md`). `srs.md` needs no amendment: it states R-M02 and says nothing about
  how a builtin is loaded.

## Context

`src/engines/system/spawn.ts` is the only place the plugin touches `child_process`. Since
the initial commit (`2beecb4`) it loaded the module with `await import("child_process")`
inside the two `NodeProcessRunner` method bodies, which kept `main.js`'s `require()` list
at `obsidian`, `@codemirror/view`, `@codemirror/state`, the list rule 7 pinned.

That never worked in Obsidian. esbuild bundles to CJS with every node builtin external,
and leaves a dynamic import of an external exactly as written, so `main.js` carried a
native `import("child_process")`. Obsidian's renderer resolves that through its ESM
loader, which has no resolution for a bare builtin specifier. Reproduced on 2026-10-01
in a real Obsidian 1.13.7 (native, Electron 43) over CDP:

| Probe in the plugin's renderer | Result |
| --- | --- |
| `getEngineStatuses()` | `speechd: false` ("spd-say could not be found"), `espeak: false` ("not installed") |
| `require("child_process").spawn("which", ["spd-say"])` | exit 0, `/usr/bin/spd-say` |
| the plugin's own `runner.run("which", ["spd-say"])` | `TypeError: Failed to resolve module specifier 'child_process'` |

`which()` caught that throw and returned null, so both Linux engines reported a missing
binary on a machine where both were installed, and with no Kokoro model downloaded the
user got "no speech engine is available". R-M02 was unmet in every real Obsidian.

No suite could see it. The test bundles are ESM run in bare Node, whose own loader
resolves `import("child_process")` fine, so `tests/engine.test.ts` drove the real
`spd-say` through the same code and passed.

## Decision

1. **`spawn.ts` loads `child_process` with a plain `require("child_process")`, inside a
   function called from the two `NodeProcessRunner` method bodies.** In Obsidian's
   renderer the CJS `require` that `nodeIntegration` provides is the only thing that
   resolves a builtin. The call stays at call time, never module scope, so evaluating
   `main.js` on mobile still evaluates no builtin.
2. **There is no `import()` fallback.** The first version of the fix kept one for the ESM
   test bundles, where esbuild's `__require` shim throws. Instead `build-tests.mjs` gives
   every test bundle a real `require` through `createRequire(import.meta.url)` in a
   banner, which the shim picks up. The shipped bundle then holds no `import()` of a
   builtin at all, so the guard in decision 4 can be strict rather than carrying an
   exception for a branch that is never taken.
3. **Rule 7's allowlist becomes `obsidian`, `@codemirror/view`, `@codemirror/state`,
   `child_process`, and `child_process` is allowed only in this shape**: a call-time
   `require` in `src/engines/system/spawn.ts`, reached only through engines constructed
   when `shouldConstructLinuxDesktopEngines` passes. Any other builtin, or this one at
   module scope, is still a BLOCK. Rule 7's intent was always "no builtin evaluates on
   mobile", and this keeps that intent exactly: the `require` is as unreachable on mobile
   as the `import()` it replaces, because the same gate decides whether either runs.
4. **The artifact is checked for the failure shape, in two places.** The CI step now also
   fails on any `import()` whose specifier is a node builtin (from
   `require("node:module").builtinModules`, bare or `node:`-prefixed), and
   `tests/release.test.ts` carries the same check plus the exact `require()` list, so a
   local `npm test` sees the CI verdict. Both are mutation-tested: restoring the original
   `await import("child_process")` turns both release checks and the CI step red, and the
   fix turns them green.
5. **The check is not evaded.** A computed specifier, `window.require`, or any other form
   that hides the builtin from the regex would defeat the guard rather than satisfy it.
   The allowlist names the builtin so a reviewer sees it.

## Consequences

- R-M02 works in a real Obsidian: after deploying the fix, `getEngineStatuses()` reported
  `espeak` and `speechd` available, Auto selected `speechd` with voice
  `speechd:English (America)`, the player went `preparing -> playing`, and a direct
  `runner.run("spd-say", ...)` spoke for 4.8 s with exit 0. That was measured with the
  first version of the fix (require plus `import()` fallback). The shipped code differs only
  in dropping the fallback, which is never reached in Obsidian, and is re-verified there
  under NRL-135 before merge.
- The `main.js` `require()` list grows by one entry. A future dependency that pulls in
  another builtin still fails CI, as before.
- Test bundles now have a real `require` in scope. Nothing in `tests/` declared its own,
  checked at the time of this change; a test that does would collide with the banner and
  fail loudly at load, not silently.
- Not established: macOS and Windows never construct these engines, so nothing about them
  changes; Android never constructs them either. Word highlighting on speechd is
  sentence-only by design (`timing: "none"`) and is untouched.
