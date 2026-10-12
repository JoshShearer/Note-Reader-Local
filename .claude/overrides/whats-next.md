# /whats-next override - Local TTS Reader

Rules: `AGENTS.md` "Verification rules" 11 and 13.

## Section 5: blockers

Also: Obsidian not running or not reloadable; CDP port 9222 not listening; WebGPU flag absent;
Read-Me-side bridge work in the other workspace (link by URL).

## Section 6: extra measurement rows

| Capture | How |
|---|---|
| Suites | the `npm test` per-suite table, aggregate counts and any `FAILING SUITES:` line, verbatim; SKIP lines if `NRL_SKIP_REAL_SPEECHD` was set |
| Bundle | `ls -l main.js` and the `require-list` gate output, verbatim |
| Extraction timings | from `tests/perf/`, with input word count |
| Latency | command to first audible sound, and how timed (a stopwatch is fine if said) |
| Binaries | `spd-say --version`, `spd-say -O`, `which espeak-ng` |
| Engine and host | engine; for Kokoro the weights build and WebGPU vs WASM; Obsidian version and install type |

Numbers already in `docs/agent-history.md` are cited from there, not presented as this session's.

## Section 7: extra unverified checks

- Whether `npm run deploy` ran, from which worktree, whether `.deployed-from` was written, and
  whether Obsidian was **reloaded** after it (a deploy without a reload proves nothing).
- Whether a `/run-tickets` lane held `.claude/deploy.lock/` and blocked a deploy.
- Engines exercised and engines not exercised.
- Whether `npm run test:obsidian` ran and the CDP port was actually listening.
