# Override: /create-issue - Local TTS Reader

## Step 1

`spec-gap` is the common type here: most open work is a gap against `srs.md`. `security` has no
label (see `tickets.md`); carry it in `## Constraints`.

## Step 3: reproduction routes

- **Bundled module, real input.** `node build-tests.mjs tests/<suite>.test.ts` bundles `src/` into
  `tests/.build/`; drive the bundled module from a scratch script with real markdown and paste the
  actual output.
- **Real Obsidian.** Deploy, mark and reload per `overrides/verify.md` Step 4, run the command,
  record what happened, and say that you deployed (never while a `/run-tickets` lane holds `.claude/deploy.lock/`).
- **Real binary.** The exact command and its output, including which stream: `spd-say` reports
  some failures on stdout with exit 0. Check what is installed first (rule 14): `which spd-say
  espeak-ng`; the history's "not installed" notes are dated.

Before filing, check `docs/agent-history.md` "Known state" as the known-defects list.

**Extraction bugs need vault evidence (rule 15, ADR 0039).** Before filing an extraction
mismatch, run the shape through the vault check or count vault notes that contain it and fire.
No real note and no owner report: do not file; say so and stop. A filed ticket carries
`Vault evidence: <n> notes (vault check, <date>, main <sha>)` and a synthetic repro. Never a note's
text or path: Linear is a cloud service and the vault is private (rule 1). Never file a
"residual" or "remainder" ticket for shapes found only by a generator.

## Cross-repo work

The phone side of the bridge (Read Me Offline's `BridgeServer`) belongs in the Read-Me repo's own
workspace. File only the plugin half here (as or under NRL-130), link the other by URL, and add
`Read-Me side: <url>` to `## Out of scope`. Never file through `linear-rea`.

## Step 4: area to constraint (`AGENTS.md` numbers)

| Area touched | Name |
|---|---|
| `src/text/**`, `src/ui/highlight.ts` | 8 |
| `src/audio/player.ts`, any engine | 9; engines also 4 |
| `src/diagnostics.ts`, any `trace()`/`throw` | 1, 3 |
| `src/engines/system/**` | 2, 7 |
| `src/engines/onnx/**` | 5, 6 |
| `src/engines/bridge/**` | 1, 4 (token and text never logged; loopback only), ADR 0036 |
| `src/settings/**` | 10 |
| New import or dependency | 7, with the `require-list` gate |
| Anything that downloads | 6 |
| A performance claim | 13 |

## Step 5: body

`## Context` names the engine (`kokoro`, `espeak`, `speechd`, `webspeech`, `readme`) and the
platform when it matters. The on-target acceptance line is what must be seen in Obsidian after
`npm run deploy` and a reload.
