# Local TTS Reader - agent instructions

An Obsidian community plugin that reads notes aloud entirely on-device, with
source-offset highlighting and multiple speech engines behind one interface.

This file is the canonical instruction set. `CLAUDE.md` is a symlink to it, so
Claude Code and opencode read the same rules.

## Read on demand

- **Contract:** read the relevant requirements in `srs.md` before changing behaviour.
  MoSCoW IDs `R-M01` through `R-C05` are acceptance criteria. Record deviations in
  `docs/adr/` and amend `srs.md`.
- **Architecture:** read `CONTEXT.md` before structural changes.
- **Linear:** read `.claude/linear.md` before tracker operations or ticket workflows.
- **History:** before changing extraction, playback, engines, highlighting, settings,
  persistence, distribution or the test runner, search `docs/agent-history.md` for
  the affected function, requirement or ticket and read the matching entries.
  It preserves prior measurements, accepted trades, regression traps and evidence
  limits. Read relevant ADRs in `docs/adr/` and spikes in `docs/spikes/` as needed.
- **Real-host verification:** before CDP or device work, read the history's
  “Driving a real Obsidian over CDP” section and the relevant platform entries.
  Historical install paths and host capabilities must be rechecked on this machine.

Keep this entry point compact. Put detailed ticket narratives and measurements in
ADRs, spikes or the historical reference, and add a task-specific pointer here
only when needed. Preserve corrections and scope limits when moving evidence.

## Quality gates

Run gates locally before committing; CI is a backstop. CI runs `npm ci`, typecheck,
lint, build and tests on pushes and PRs. The release workflow gates tagged commits
without lint.

```bash
npm test          # 26 suites: extract, engine, player, paths, kokoro, settings, positionThrottle, highlightColour, highlight, affordances, engineSelection, webspeechVoices, fallback, espeak, types, release, voiceChoice, platform, readSelection, modelStore, adrNumbers, vaultPersistence, loadingNotice, suiteRegistry, bridge, runTickets
npm run typecheck # tsc --noEmit --skipLibCheck
npm run lint      # eslint src; errors fail CI, warnings are tolerated
npm run build     # typecheck + esbuild production; worker and ONNX runtime inlined into main.js
```

Tests and typecheck must pass before any commit. Run build for changes affecting
the bundle, worker or esbuild configuration.

Lint uses `eslint-plugin-obsidianmd`'s recommended config as an approximation of
the community directory's source review. Preserve the deliberate warning cases
for bare-Node timers, the worker, the parser copy and call-time `require` (ADR 0033).
Find the measured warning count and TypeScript-version caveat in the history's
“Quality gates” section.

`package.json`'s `pretest` is the suite registry. `tests/suiteRegistry.test.ts`
asserts this file's gate count and full ordered name list against it. Keep exactly
one gate line of the above shape. When adding a suite, update the registry, this
line and `srs.md`'s release-gate bullet; the runner derives paths from the registry.

Runner invariants: preserve its basename main guard, exit-code classification,
both registry derivation and planned-versus-produced execution checks, and
`process.exitCode` plus return for failures so piped output flushes completely.
The detailed reasons and mutation evidence are in `docs/agent-history.md` under
“Quality gates” and the suite-count entry.

```bash
npm run deploy             # builds and deploys three files to ~/Documents/Notes/.obsidian/plugins/; prunes other top-level entries except data.json and dotfiles
npm run test:obsidian      # CDP smoke test; requires Obsidian with --remote-debugging-port=9222
npm run test:inline-worker # separate production-bundle check, outside npm test's bare-Node chain
```

Only one worktree may own the deployed build at a time; say when deploying.
Verify the target before deployment. Fresh worktrees need `npm ci`.

`tests/engine.test.ts` has real `spd-say` checks requiring Linux and a running
speech-dispatcher daemon. `NRL_SKIP_REAL_SPEECHD=1` bypasses those checks, as CI
does, and reports skips separately. With it unset, missing tooling must fail.
Report skipped real-host checks as partial coverage. The espeak suite uses a fake
ProcessRunner; that is not real-binary evidence.

## Non-negotiables

Breaking a product promise is a BLOCK.

### Privacy

1. **No note text in any log, ever.** `trace()` takes counts, IDs and durations.
   Never interpolate chunk, selection or spoken text, including in errors.
2. **Speech text reaches subprocesses on stdin, never argv.** Command lines are
   visible in `ps` and spawn errors. Keep both Linux engines' stdin piping.
3. **No telemetry.** No analytics, beacons, crash reporting or anonymous usage.

### Network

4. **No cloud TTS or automatic fallback to it.** No API keys or accounts.
5. **The Kokoro worker refuses remote fetches at runtime.** Preserve `isRemote`
   and `assertLocal` in `kokoro.worker.ts`. Fix broken local paths rather than
   relaxing the guards; upstream libraries default to CDN URLs.
6. **Every byte downloaded is user-initiated.** Weights and voices download on
   an explicit click, never on load, prewarm or first read.

### Mobile safety

7. **`manifest.json` keeps `isDesktopOnly: false`.** Node builtins must not
   evaluate on mobile. `child_process` stays type-only plus call-time
   `require("child_process")` in `src/engines/system/spawn.ts`, reached only by
   engines constructed through `shouldConstructLinuxDesktopEngines` in
   `src/engines/platform.ts`. The gate is Linux desktop, not merely non-mobile.
   After dependency changes, check `main.js`'s requires: only `obsidian`,
   `@codemirror/view`, `@codemirror/state` and call-time `child_process` are allowed.
   Native dynamic imports of builtins cannot resolve in Obsidian's renderer.
   Keep builtin accesses visible to CI and release tests, without computed
   specifiers or `window.require`. See ADR 0033.

### Correctness

8. **Source offsets drive highlighting.** `SpeechChunk.sourceIndex[i]` maps
   spoken characters to raw markdown offsets. Never search the editor for spoken
   strings. Keep stripping and index mapping in lockstep, including dropped spans.
9. **Apply playback rate exactly once.** Engines with `ownsPlayback: true`
   receive the rate; buffer engines render at natural speed and the player
   applies it. Preserve the check against double application.
10. **Settings normalisation preserves unknown keys.** Plugin data also holds
    reading positions; whitelist rebuilding can erase them on a rate change.

## Verification rules

11. **Green unit tests do not establish user-facing behaviour.** Tests run in
    bare Node against fakes. Before claiming a user-facing change works, deploy
    and exercise the real plugin in Obsidian. Report unobserved behaviour honestly.
12. **Reproduce bugs end-to-end before fixing them.** Bundle and run real modules
    against real input rather than relying only on reasoning or fake tests.
13. **Only assert measurements taken or cited.** Ratios, sizes and latencies must
    come from this session or a named prior measurement with its scope attached.
14. **Verify actual install paths and commands.** Repository existence is not
    proof that a tool or file exists on this host.

The old audit found 2 of 16 MUST requirements met. That is a historical floor,
not a current tally. Closing a ticket or passing bare-Node tests does not move a
requirement to met. Consult the contract and relevant historical evidence first.
Reading-view parser execution is not a live Obsidian run or Live Preview evidence.

## Style

- Use a plain hyphen or rephrase instead of em-dashes.
- Comments explain why when the reason cannot be reconstructed from the code.
  `player.ts` and `kokoro.ts` illustrate the house style.
- State what is true, including failures, unverified behaviour and guesses.
- Cite stable anchors: functions, constants, headings or quoted sentences,
  rather than line numbers that drift after edits.
