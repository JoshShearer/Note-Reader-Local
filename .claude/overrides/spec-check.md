# /spec-check - Local TTS Reader additions

`TARGET` tag is `OBSIDIAN`: a user-observable requirement reaches FULLY MET only on an observation
in a deployed, reloaded plugin (rule 11), named with date, host, engine and build.

## Baseline

No per-requirement baseline is recorded. The historical audit found 2 of 16 MUST met (R-M04,
R-M05), recorded in `AGENTS.md` "Verification rules" and `docs/agent-history.md` "Known state" as
a floor that has not been re-run. Treat everything else as unknown. The first `all` run offers a
baseline; propose `docs/agent-history.md` "Known state" as its home and write nothing unasked.

R-M04 (no external TTS API) and R-M05 (local privacy) are also non-negotiables 1-5. If either
moved off FULLY MET, stop the audit and report that first.

## Check tags (read the requirement in `srs.md`; this is a pointer)

| Tag | Requirements |
|---|---|
| CODE | R-M04, R-M05, R-M08, R-M10, R-M11, R-S04, R-S05, R-S06, R-C03, R-C04, R-C05 |
| CODE + OBSIDIAN | R-M01, R-M06, R-M09, R-M14, R-M15, R-S01 |
| OBSIDIAN | R-M02, R-M07, R-M12, R-M13, R-M16, R-S02, R-S03, R-C01, R-C02 |
| OBSIDIAN on Android | R-M03 (the `readme` bridge engine, ADR 0036; `SPIKE-ANDROID-001`, record in `docs/spikes/`) |

File hints (`git ls-files src` if moved): R-M01 `manifest.json`, the `require-list` gate,
`spawn.ts`, `platform.ts`; R-M02 `src/engines/system/speechd.ts`; R-M03 `src/engines/bridge/`;
R-M04 whole tree, `kokoro.worker.ts` guards; R-M05 `src/diagnostics.ts` and every `trace()` site;
R-M06 `addCommand` calls in `src/main.ts`; R-M07 `player.ts`, `src/ui/controlBar.ts`; R-M08/R-M09
`src/text/extract.ts`, `src/settings/`; R-M10 `src/text/segment.ts`; R-M11 `SpeechChunk` in
`src/audio/types.ts`; R-M12/R-M13 `src/settings/`; R-M14 `EngineCapabilities` and its consumers;
R-M15 `reportError`, `src/audio/fallback.ts`, `registry.ts`; R-M16 `player.ts`, settings tab.

## Known gaps

`CONTEXT.md` "Known structural gaps" pre-empts some verdicts. Judge the spec vocabulary by
substance, not name (`SpeechSegment` vs `SpeechChunk`): R-M11 turns on fields, not the rename.

## Method additions

- Extraction claims: bundle and run (`node build-tests.mjs tests/extract.test.ts`), then drive
  `tests/.build/` with real markdown.
- Performance targets in `srs.md` are checkable only with `tests/perf/`, run this session, numbers
  pasted.
- Deviations need an ADR in `docs/adr/` plus the `srs.md` amendment.
