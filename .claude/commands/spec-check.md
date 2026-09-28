---
description: Map the working tree against srs.md and report FULLY MET / PARTIAL / MISSING per requirement with file:line evidence, flagging anything that moved from the AGENTS.md baseline.
---

Audit the code against `srs.md`, the written contract.

Conventions: `.claude/linear.md`.

Argument: `$ARGUMENTS`

- A requirement id (`R-M06`, `r-m06`, `M06`) to audit one requirement in depth.
- `all` to audit all 16 MUST requirements.
- `must`, `should`, `could` to audit one MoSCoW tier.
- Omitted: audit only the requirements the current working tree touches. Work out which
  from `git status --short` and `git diff --name-only`, then map changed files back through
  the Requirement map below.

## The rule that makes this command worth anything

**Code reading cannot mark a user-observable requirement as met.** Most of this repo's
known defects were present in code that reads correctly. `ExtractOptions.skipCode` is
plumbed from settings and rendered as a toggle and never read; reading the settings tab
would have shown a working feature. Pause is wired to an `<audio>` element that `speechd`
and `webspeech` never touch; reading `player.ts` shows a pause implementation.

So each requirement below is tagged:

- **CODE** - a grep or a bundled-module run settles it. You may mark FULLY MET.
- **OBSIDIAN** - user-observable. The highest verdict code reading may award is
  `PARTIAL (code present, unverified)`. To reach FULLY MET you must have run it in the
  deployed plugin this session. If you did not, say `needs Obsidian` in the evidence
  column and leave it PARTIAL.
- **BLOCKED** - cannot be checked on this machine at all. Say why.

Never quote a latency, a size or a ratio you did not measure (`AGENTS.md` rule 13). The
performance targets at `srs.md:2076` are checkable with `tests/perf/`, but only if you run
it and paste the number.

## Baseline (from AGENTS.md "Known state")

The recorded audit found **2 of 16 MUST requirements fully met**.

| Baseline verdict | Requirements |
|---|---|
| FULLY MET | `R-M04`, `R-M05` |
| FAILING | `R-M01`, `R-M03`, `R-M06`, `R-M07`, `R-M09`, `R-M12` |
| Not recorded | `R-M02`, `R-M08`, `R-M10`, `R-M11`, `R-M13`, `R-M14`, `R-M15`, `R-M16` and all of `R-S*` / `R-C*` |

Treat "not recorded" as unknown, not as met. Assess it fresh.

**Flag every change against this baseline.** A requirement that moved is the headline of
your report:

- FAILING to FULLY MET: verify hard before claiming it. If it is an OBSIDIAN requirement
  and you did not run Obsidian, you cannot claim it.
- FULLY MET to anything else: this is a regression against a promise and it is a BLOCK.
  `R-M04` (no external TTS API) and `R-M05` (local privacy) are also non-negotiables 1
  through 5 in `AGENTS.md`. If either slipped, stop the audit and report that first.
- Not recorded to a verdict: normal, and it improves the baseline. Offer to update the
  `AGENTS.md` "Known state" paragraph at the end.

## Requirement map

Line numbers are into `srs.md`. Read the requirement before judging it; the summary here
is a pointer, not the contract.

### Must Have

| ID | srs.md | Demands, in short | Check | Where the code is |
|---|---|---|---|---|
| R-M01 | 102 | Ordinary community plugin. No companion app, server, account, API key. `isDesktopOnly: false` honoured; no desktop-only import evaluated on mobile | CODE | `manifest.json`, `main.js` require list, `src/engines/system/spawn.ts` |
| R-M02 | 128 | Linux speaks via Speech Dispatcher, not tied to one engine | OBSIDIAN | `src/engines/system/speechd.ts` |
| R-M03 | 159 | Android is a target; the native bridge MUST be demonstrated by a spike, not assumed | BLOCKED | no spike exists; `srs.md:1082` SPIKE-ANDROID-001 |
| R-M04 | 184 | No note text to any external synthesis provider, no API keys, no automatic cloud fallback | CODE | whole tree; `kokoro.worker.ts` `isRemote` / `assertLocal` |
| R-M05 | 203 | Local processing. No telemetry with note content. Debug logs MUST NOT contain spoken text | CODE | `src/diagnostics.ts` and every `trace()` call site |
| R-M06 | 218 | Start from selection, from cursor, and whole note. Three named commands | CODE + OBSIDIAN | `src/main.ts` `addCommand` calls |
| R-M07 | 236 | Play, pause/resume, stop, previous segment, next segment | OBSIDIAN | `src/audio/player.ts`, `src/ui/controlBar.ts` |
| R-M08 | 254 | Markdown converted, not spoken raw. Headings, lists, quotes, bold, italic, links, wikilinks, frontmatter, fenced code, inline code, images, embeds | CODE | `src/text/extract.ts`, `tests/extract.test.ts` |
| R-M09 | 281 | User-configurable exclusions for frontmatter, code blocks, inline code, URLs, image alt, embeds, with the stated defaults | CODE + OBSIDIAN | `src/settings/index.ts`, `src/ui/settingsTab.ts`, `src/text/extract.ts` |
| R-M10 | 307 | Independently addressable segments, sentence-sized, Unicode-capable, `Intl.Segmenter` preferred over an English regex | CODE | `src/text/extract.ts` |
| R-M11 | 321 | Every segment keeps `id`, `sequence`, `blockType`, and `source.filePath/from/to` | CODE | `src/audio/types.ts` `SpeechChunk` |
| R-M12 | 360 | Per-note reading position persisted, resumable, tolerant of a changed document | OBSIDIAN | `src/settings/index.ts`, `src/audio/player.ts` |
| R-M13 | 388 | Settings persist via Obsidian plugin data; notes are not modified to store globals | OBSIDIAN | `src/settings/index.ts` `normaliseSettings()` |
| R-M14 | 419 | Every backend advertises capabilities; unsupported controls disabled, hidden or marked | CODE + OBSIDIAN | `src/audio/types.ts` `EngineCapabilities`, `src/ui/` consumers |
| R-M15 | 448 | Actionable errors for the eight named failures; a failure never corrupts notes, settings or progress, nor locks playback | CODE + OBSIDIAN | `src/diagnostics.ts` `reportError()`, `src/engines/registry.ts` |
| R-M16 | 472 | Rate 0.5x to 2.0x, default 1.0x, persists across sessions, changing it does not reset document, segment or progress | OBSIDIAN | `src/audio/player.ts`, `src/ui/settingsTab.ts` |

### Should Have

| ID | srs.md | Demands, in short | Check |
|---|---|---|---|
| R-S01 | 545 | Voice selection with normalised voice objects; never claim offline when unknown | CODE + OBSIDIAN |
| R-S02 | 569 | Pitch where supported, hidden or disabled where not | OBSIDIAN |
| R-S03 | 583 | Current segment highlighted, following playback, via source mapping not editor search | OBSIDIAN |
| R-S04 | 593 | An offline-preference toggle, presented as a preference and not a guarantee | CODE |
| R-S05 | 613 | Language-aware voice matching; explicit user choice always wins | CODE |
| R-S06 | 621 | Sleep timer with presets, stopping at a safe boundary | CODE |

### Could Have

| ID | srs.md | Demands, in short | Check |
|---|---|---|---|
| R-C01 | 642 | Local neural TTS via WebGPU/WASM, not required for the Linux MVP | OBSIDIAN |
| R-C02 | 693 | Install and remove local voice models, explicit user action, name/language/download size/installed size/license shown first | OBSIDIAN |
| R-C03 | 715 | Queue multiple notes | CODE |
| R-C04 | 721 | Frontmatter overrides for selected settings | CODE |
| R-C05 | 740 | Audio export, kept out of the playback pipeline | CODE |

## Known structural gaps that pre-empt some verdicts

From `CONTEXT.md`. These are design-level, so do not report them as fresh discoveries:

- `Player` is a chunk-queue player with no file path and no document identity. `R-M12`
  cannot be satisfied without changing that.
- Capabilities are advertised and almost never consumed. Three call sites, one of which is
  a label. That is the ceiling on `R-M14`.
- No engine fallback chain. A failed engine yields a notice telling the user to change a
  dropdown. That bears on `R-M15`.
- Segmentation is the single regex `/[.!?...]+["')\]]*\s+/g`, no `Intl.Segmenter`, so CJK
  never splits. That is `R-M10` directly.
- Spec vocabulary differs from the code: `SpeechSegment` vs `SpeechChunk`,
  `TTSCapabilities` vs `EngineCapabilities`. Judge the substance, not the name. `R-M11`
  fails on missing fields (`id`, `sequence`, `blockType`, `filePath`), not on the rename.

## Method

1. Read the requirement text in `srs.md` at the line given. Do not audit from the summary
   table above.
2. Gather evidence. Grep the files in the map; read them. For `extract.ts` behaviour,
   bundle and run rather than reason:

   ```bash
   node build-tests.mjs tests/extract.test.ts
   ```

   then drive `tests/.build/` from a small node script with real markdown and paste the
   actual output.
3. Cite `file:line`. A verdict with no location is not evidence, and the next session
   cannot check your work.
4. For an OBSIDIAN requirement you want to mark FULLY MET, run it:

   ```bash
   npm run deploy
   ```

   then exercise it in the Flatpak `md.obsidian.Obsidian` and record what you saw. If you
   did not do this, the verdict stays PARTIAL. Say `needs Obsidian` and move on.
5. Compare each verdict to the baseline table and mark the delta.

## Verdict definitions

| Verdict | Criterion |
|---|---|
| `FULLY MET` | Every MUST clause in the requirement is satisfied, with evidence. For OBSIDIAN requirements, observed this session. |
| `PARTIAL` | Some clauses met. Name the specific clause that is not. "Partial" with no named gap is useless. |
| `MISSING` | No implementation, or an implementation that does not run (plumbed and never read counts as MISSING for the user-facing clause). |
| `BLOCKED` | Cannot be assessed here. `R-M03` is the standing example: Android, and no spike. |

A SHOULD or MAY clause inside a MUST requirement does not block FULLY MET on its own, but
note it. `R-M10`'s `Intl.Segmenter` is a SHOULD; its Unicode support is a MUST.

## Output

Lead with the deltas, then the table.

```
spec-check: <scope>   (working tree: <clean | N files changed>)

Changed since baseline
  R-M09  MISSING -> PARTIAL   skipCode now read at src/text/extract.ts:141
  R-M05  no change            still met

Requirements
| ID | Verdict | Evidence | vs baseline |
|---|---|---|---|
| R-M01 | PARTIAL | manifest.json:7 isDesktopOnly false; main.js requires only obsidian, @codemirror/view, @codemirror/state; R-M03 spike absent | = failing |
| R-M04 | FULLY MET | no fetch to any provider; kokoro.worker.ts:58 assertLocal | = met |
| R-M06 | MISSING | src/main.ts:81-105 registers 4 commands; no read-selection, no read-from-cursor | = failing |
| R-M12 | MISSING | Player holds no filePath; src/audio/player.ts:1 | = failing |
...

Not assessable
  R-M03  BLOCKED  Android; SPIKE-ANDROID-001 (srs.md:1082) has not been run

Needs Obsidian before any of these can move past PARTIAL
  R-M07, R-M12, R-M13, R-M16, R-S03

Score: N of 16 MUST fully met (baseline 2 of 16)
```

Keep the table compact. One line per requirement, evidence in one clause.

## After the report

- If any verdict moved, offer to update the "Known state" paragraph in `AGENTS.md` with
  the new count and any newly reproduced defect. Do not edit it without being asked.
- For each MISSING or PARTIAL that is not already ticketed, offer `/create-issue spec-gap`
  with the requirement ID prefilled. Run `list_issues` first to avoid duplicates. Resolve
  the real prefixed Linear tool names from your available tool list; do not hardcode a
  prefix. If Linear is unavailable, list the issues you would have filed.
- If the code deliberately diverges from `srs.md`, that is allowed but must not be silent:
  it needs an ADR in `docs/adr/` and an amendment to `srs.md`. Note that `docs/` does not
  currently exist, so the first ADR creates it.
