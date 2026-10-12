# /test-issue override - Local TTS Reader

## Step 2: workflows

| Workflow | Trigger | Job | A failure means |
|---|---|---|---|
| `CI` (`ci.yml`) | `push` on `branches: ["**"]` **and** `pull_request` | `gates` | Always real |
| `Release` (`release.yml`) | bare-semver tags only | `build`, `release`, `provenance` | See the structural rule |

A branch with an open PR therefore has **two** `gates` entries per commit (accepted, per the
workflow's own comment). Deduplicate before counting. `gates` is a **job** name: `gh run list`
cannot filter on it.

**Structural rule.** A `Release` run on a branch push is expected for refs predating `01c9a84`
(GitHub compiles the workflow from the pushed ref; that file's old defects fail in 0 s, 0 jobs,
no log). Recorded in `docs/agent-history.md`. Never a merge blocker for a ticket. A red
`CI / gates` is never dismissable this way.

## Step 4: step-to-gate map

| Failing step (`ci.yml`) | Run locally |
|---|---|
| `Install dependencies` | `npm ci` |
| `Typecheck` | `npm run typecheck` |
| `Lint` | `npm run lint` |
| `Build` | `npm run build` |
| `Assert main.js require() list` | `npm run build`, then the `require-list` gate |
| `Test` | `npm test`, then the single failing suite from its `FAILING SUITES:` line |

Local-versus-CI differences to check first:

- CI sets `NRL_SKIP_REAL_SPEECHD=1`; your shell may not. `tests/engine.test.ts` runs real
  `spd-say` checks locally and skips them in CI, so it can be red on one side only.
- CI builds before testing; `tests/release.test.ts` reads `main.js`, so a local `npm test` without
  a build fails for that reason alone.
- `tests/espeak.test.ts` uses a fake `ProcessRunner`: no real-binary claim either way.
- CI is `ubuntu-latest`, Node 22, clean `npm` cache.

## Step 5

Repair prompt also names the area's rule: `extract.ts` -> `sourceIndex` lockstep (8); engines ->
rate once (9); settings -> unknown keys preserved (10); anything logging -> no note text (1).
