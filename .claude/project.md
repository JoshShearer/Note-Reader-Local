# Project facts - Note-Reader-Local

Read by every shared `claude-workflow` command (see `.claude/workflow/contract.md`).
**The `##` headings are an interface.** Keep them as written. Project-specific steps that aren't
facts live in `.claude/overrides/<command>.md`.

## Identity

| Field | Value |
|---|---|
| Name | Note-Reader-Local (plugin id `local-tts-reader`, display name Local TTS Reader) |
| One line | Obsidian community plugin that reads notes aloud entirely on-device (Kokoro, espeak, Speech Dispatcher, Web Speech, and the optional Read Me Offline bridge on Android), with source-offset highlighting |
| Default branch | `main` |
| Agent instructions | `AGENTS.md` (`CLAUDE.md` is a symlink to it). Architecture: `CONTEXT.md`. History, known state and measurements: `docs/agent-history.md` |
| Remote | `origin` (`JoshShearer/Note-Reader-Local`, public) |

## Gates

The canonical list is the "Quality gates" block in `AGENTS.md`. Its `npm test` line is asserted
by `tests/suiteRegistry.test.ts` against `package.json`'s `pretest` registry; never restate the
suite count or names anywhere else.

| Gate | Command | Required when the diff touches |
|---|---|---|
| test | `npm test` | any of `src/`, `tests/`, `run-tests.mjs`, `build-tests.mjs`, `package.json`, `.github/workflows/` |
| typecheck | `npm run typecheck` | any TS (`src/`, `tests/`) |
| lint | `npm run lint` (errors fail, warnings tolerated, ADR 0033) | anything under `src/` |
| build | `npm run build` | `esbuild.config.mjs`, `src/engines/onnx/**`, `manifest.json`, `package.json` dependencies, any new import |
| require-list | after `build`: `grep -oE 'require\("[^"]+"\)' main.js \| sort -u` must be exactly `@codemirror/state`, `@codemirror/view`, `child_process`, `obsidian`; `grep -oE 'import\("[^"]+"\)' main.js` must list no node builtin (rule 7, ADR 0033; same check as CI's "Assert main.js require() list" step) | whenever `build` is required |
| inline-worker | `npm run test:inline-worker` (its `pretest` runs a build) | `src/engines/onnx/**`, `esbuild.config.mjs` |

Setup in a fresh checkout: `npm ci`. `tests/release.test.ts` reads `main.js`, so in a fresh
checkout run `npm run build` before `npm test` (CI orders them the same way), or a red
`release` suite means nothing.

`tests/engine.test.ts` runs real `spd-say` checks that need a running speech-dispatcher daemon.
`NRL_SKIP_REAL_SPEECHD=1` bypasses them (CI sets it) and prints SKIP lines; a run with skips is
partial coverage, never a full pass. Unset, missing tooling must fail. Check `spd-say --version`
and `spd-say -O` before blaming the diff.

CI: `.github/workflows/ci.yml`, one job `gates`, on `push` to every branch **and** on
`pull_request` (so a branch with an open PR runs it twice). `.github/workflows/release.yml` runs
on bare-semver tags only. Read a check result once. Never wait on it. Branch protection is out of
scope, so a red check does not block a merge.

## Verification

| Field | Value |
|---|---|
| Target | A real Obsidian on this machine running the deployed plugin from the vault `deploy.mjs` writes to (its default vault, `<vault>/.obsidian/plugins/local-tts-reader`). Android-only behaviour (the `readme` bridge engine, mobile placement, R-M03) needs Obsidian on the phone, driven over CDP |
| How | Take the slot, `npm run deploy`, write the `.deployed-from` marker, reload Obsidian, then drive the change through the plugin's real UI. `npm run test:obsidian` (CDP, port 9222) supplements it, never replaces it. Procedure in `overrides/verify.md`; CDP traps in `docs/agent-history.md` "Driving a real Obsidian over CDP" |
| Verified wording | `VERIFIED IN OBSIDIAN` (name the engine: a pass on one engine is not a pass on the others) |
| Not-verified wording | `NOT VERIFIED IN OBSIDIAN` (`/verify`'s verdict: `GATES GREEN, NOT VERIFIED`) |
| Exclusive resource | none (`.claude/deploy.lock/` binds `/run-tickets` lanes only; interactive sessions check it but don't take it, see `overrides/verify.md`) |

## Risk areas

Highest risk first. The numbers are `AGENTS.md` non-negotiables.

- `source offsets` (+2) - a dropped span or a new join forgets its `sourceIndex` entry, so the
  highlight drifts on every later word with no error; or highlighting starts searching the editor
  for the spoken string (8). Match: `src/text/**`, `src/audio/words.ts`, `src/ui/highlight.ts`,
  `sourceIndex`, `pushSpace`, `indexOf\(`, `\.search\(`
- `note text in logs` (+2) - a `trace()` detail, `Notice` or error message carries chunk,
  selection, spoken text or the bridge token; `trace()` sanitises nothing and writes into the
  vault (1). Match: `src/diagnostics.ts`, `trace\(`, `reportError\(`, `new Notice\(`, `console\.`,
  `new Error\(`, `throw `
- `kokoro network guards` (+2) - `isRemote` / `assertLocal` / the fetch shim / the
  `env.allow*`/`useFS*` flags loosened to fix a load path, so the worker can reach a CDN (5).
  Match: `src/engines/onnx/**`, `isRemote`, `assertLocal`, `installFetchShim`, `allowRemoteModels`,
  `useFS`, `useBrowserCache`, `wasmPaths`
- `outbound fetch` (+2) - a fetch reachable from `onload`, layout-ready prewarm, `prepare()`,
  `isAvailable()` or a settings render, or to anything other than the Hugging Face download in
  `src/ui/modelStore.ts` and the loopback bridge (4, 6). Match: `fetch\(`, `XMLHttpRequest`,
  `requestUrl`, `https?://`, `sendBeacon`, `src/ui/modelStore.ts`
- `bridge engine` (+2) - the `readme` engine talks to something other than `127.0.0.1`, puts the
  token or text in a URL, log or error, or gets constructed off Android (1, 4; ADR 0036). Match:
  `src/engines/bridge/**`, `BRIDGE_HOST`, `Authorization`, `Bearer`, `token`
- `rate handling` (+2) - rate applied by both an `ownsPlayback` engine and `Player`, so 1.5x plays
  at 2.25x (it shipped once), or the pinning test is softened (9). Match: `ownsPlayback`,
  `playbackRate`, `req\.rate`, `setRate`, `\bspeed\b`, `tests/player.test.ts`
- `node builtins on mobile` (+2) - a builtin evaluates at module scope or via `import()` and the
  plugin dies on Android while every test passes (7). Match: `child_process`, `from ["']fs`,
  `from ["']path`, `from ["']os`, `node:`, `src/engines/system/spawn.ts`,
  `src/engines/registry.ts`, `src/engines/platform.ts`, `isDesktopOnly`
- `settings and persisted data` (+2) - normalisation rebuilds from a whitelist and the next rate
  nudge erases reading positions or other keys; `deploy.mjs` prunes `data.json` (10). Match:
  `src/settings/**`, `normaliseSettings`, `DEFAULT_SETTINGS`, `saveData`, `loadData`, `deploy.mjs`
- `speech text to argv` (+2) - text pushed into an `args` array or a shell string, visible in `ps`
  and spawn errors (2). Match: `src/engines/system/**`, `args\.push`, `runner\.(run|spawn)\(`,
  `exec(Sync)?\(`, `shell:`
- `playback lifetime` (+1) - an added `await` without a `runToken`/`signal` recheck lets an
  abandoned chunk advance the index; a worker message posted without the generation check; `stop()`
  stops cancelling pending synthesis. Match: `src/audio/player.ts`, `runToken`, `currentGeneration`,
  `cancelPending`, `kokoro.worker.ts`
- `worker or bundle boundary` (+1) - Match: `esbuild.config.mjs`, `kokoro.worker.ts`,
  `browser-environment.ts`, `manifest.json`
- `engine contract` (+1) - a capability added or flipped that engines or UI consumers don't read.
  Match: `src/audio/types.ts`, `capabilities`

## Non-negotiables

`AGENTS.md`, sections "Non-negotiables" (rules 1-10) **and** "Verification rules" (rules 11-14).
A BLOCK in either stops `/ship`.

## Spec

| Field | Value |
|---|---|
| File | `srs.md` (requirements under "## Must Have", "## Should Have", "## Could Have"; the Android spike is `## SPIKE-ANDROID-001`, its record in `docs/spikes/`) |
| Requirement ID pattern | `R-[MSC]\d{2}`, `SPIKE-ANDROID-\d{3}` |
| Baseline | None recorded per requirement. The only figure is the historical floor "2 of 16 MUST met" in `AGENTS.md` "Verification rules" and `docs/agent-history.md` "Known state"; it is not a current tally |
| Deviation record | An ADR in `docs/adr/` (numbered after the highest existing one; `tests/adrNumbers.test.ts` checks the numbering), plus an `srs.md` amendment that points to it, in the same commit |

## Push policy

`allowed` - this repo's commands may push, open PRs and post Linear comments without asking.
docs-only commits to the default branch: allowed (`/update-docs` and `/finish` doc fixes).

## Worktrees

| Field | Value |
|---|---|
| Location | sibling of the primary checkout (find the primary with `git rev-parse --git-common-dir`) |
| Name pattern | `note-reader-local-nrl-{N}` (multi-issue: `note-reader-local-nrl-57-58`), lowercase as in `/run-tickets`. `note-reader-local-run-*` lanes belong to `/run-tickets` |
| Setup | `npm ci` (no machine-local files to copy; Kokoro weights live in the vault, outside the plugin folder) |

## Docs to keep in sync

- `AGENTS.md` - the "Quality gates" block (its `npm test` line is test-asserted), the
  non-negotiables, the historical-floor paragraph
- `docs/agent-history.md` - "Known state" is the known-defects section; dated measurements
- `srs.md` - deviations and their amendments, the release-gate bullet under R-M01 that states the suite count
- `CONTEXT.md` - "Layout", "Pipeline", "Load-bearing decisions", "Known structural gaps"
- `README.md`
- `docs/adr/` - new decision records only. Don't diff these. Write one when a deviation needs it
- `.claude/COMMANDS.md`
