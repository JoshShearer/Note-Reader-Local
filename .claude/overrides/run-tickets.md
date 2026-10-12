# /run-tickets override - Local TTS Reader

The facts are in `.claude/project.md` `## Autonomous runs`. These are the steps no other project
has. Subagent prompts get the sections their phase names, verbatim. `<vault>` is the default vault
in `deploy.mjs`; `SLOT=<vault>/.obsidian/plugins/local-tts-reader`.

## Facts

| Fact | Consequence |
|---|---|
| **One deploy slot.** `npm run deploy` writes one fixed plugin folder in the owner's vault. | `.claude/deploy.lock/` in the primary binds `/run-tickets` lanes only. Interactive sessions (`/verify`, `/ship`, `/worktrees`) check it and never deploy while it is held, but never take it. A lane that cannot take it skips the deploy and says so; never wait. |
| **A deploy is not live until Obsidian restarts.** On 2026-09-28 two tickets were "passed" against a stale in-memory build after an in-app reload. | A run never starts, stops or restarts Obsidian, so a lane can **never** claim `VERIFIED IN OBSIDIAN`. A CDP smoke is recorded as a supplement under its own name, and the end-of-run report tells the owner to fully quit and relaunch Obsidian. |
| **Linear is `linear-nrl`, team `NRL`.** | Never call `linear-rea`, which is another workspace. |
| **Reproduced defects are listed** in `docs/agent-history.md` "Known state", with exact triggering inputs. | Triage copies a known defect's repro into `reproduction` rather than asking for one. |
| **CI is the workflow named `CI`, one job `gates`**, on `push` to every branch and on `pull_request`. | The workflow name for "Reading a CI conclusion" is `CI`; `gates` is a job name and `gh run list` cannot see it. |

## Step 2: the config

`tests/release.test.ts` reads `main.js`, so a stale or missing bundle fails `npm test` for a reason
unrelated to the change. In the run's config, put the `build` gate **before** `test` and give it
`when: null` (always). `require-list` stays `run: null`: Build and Verify run it from `## Gates`
after the build.

## Step 4: lane setup

`npm ci`, then `npm run build`, then `$OPS gates` (the order `.github/workflows/release.yml` uses).
Do **not** set `NRL_SKIP_REAL_SPEECHD`: this machine has `spd-say` and a live daemon, and a skipped
run must never read as a full one. A red `engine` suite: check `spd-say --version` and `spd-say -O`
before blaming `origin/main`; a `release`-suite `ENOENT` on `main.js` means the build did not run.

## Phase 0: Triage

Also block: a ticket needing an Android device (R-M03, the `readme` bridge engine, mobile
placement), a second GPU or a non-Linux desktop. A ticket that amends `srs.md` needs an ADR in the
same PR (`tests/adrNumbers.test.ts` checks the numbering).

## Build and Fix

A bug is reproduced by bundling the real module from the session scratchpad, never the repo:
`npx esbuild <probe>.ts --bundle --platform=node --format=esm --outfile=<scratch>/probe.mjs && node <scratch>/probe.mjs`.
Consult the matching non-negotiable: `extract.ts` means the `sourceIndex` lockstep rule, engines
the `ownsPlayback` rate rule, settings the normalisation rule, anything logging means no note text.
Read `npm test` by its per-suite table, aggregate counts and `FAILING SUITES:` line. The PR body's
Manual Test Plan gives exact note contents to paste and the expected speech for each.

## Critic: must-BLOCK

Prose silently lost; private text spoken; `sourceIndex` drift; a node builtin reachable at module
scope or through `import()`; note text, spoken text or the bridge token in a `trace()`, `Notice`,
log or error.

## Verify: probes

For `extract.ts` changes, also check `sourceIndex` lockstep on every probe: equal length to the
text, and every non-space character maps to the same raw character. Run `require-list` after the
build.

## Taking the target: deploy and CDP smoke

Only if Obsidian is reachable on the CDP port
(`curl -s --max-time 2 http://127.0.0.1:9222/json/version`); otherwise
`CDP smoke: not run (port 9222 not reachable)`.

1. `$OPS lock <KEY> --take`. Not held → `CDP smoke: not run (deploy lock held by <holder>)`.
2. `npm run deploy`, then write the marker with this lane's path, branch, commit and `runId`:

   ```bash
   printf '%s\nbranch=%s commit=%s at=%s purpose=run %s\n' "$(git rev-parse --show-toplevel)" \
     "$(git branch --show-current)" "$(git rev-parse --short HEAD)" "$(date -u +%FT%TZ)" "<runId>" \
     > "$SLOT/.deployed-from"
   ```

3. `npm run test:obsidian`, record the result as `CDP smoke: <result>`, and say which build was
   loaded if you can tell. It ran against whatever Obsidian has in memory, so it is a supplement,
   never `VERIFIED IN OBSIDIAN`.
4. `$OPS lock <KEY> --release`, whatever happened.

The `target` line is `NOT VERIFIED IN OBSIDIAN: <CDP smoke line>`.

## Finish: deploy merged main

After `$OPS finish` resets the lane to `origin/main`: `npm ci` if the lockfile moved, take the lock,
`npm run deploy`, write the marker, release the lock, so the owner's vault carries the latest merged
build. Lock held → skip the deploy and name the holder; never wait.

## Report

**The vault now has `main` at `<sha>`. Fully quit and relaunch Obsidian to load it**; an in-app
reload has proven unreliable. Nothing in this run was verified in Obsidian by a human, and each
PR's Manual Test Plan says what to look at. If a deploy was skipped for a held lock, name the lane
that held it.
