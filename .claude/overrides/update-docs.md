# /update-docs - Local TTS Reader additions

## Step 2a: claims to test

| Claim | How to test it now |
|---|---|
| `AGENTS.md` gate line (`npm test # N suites: ...`) | `npm test` runs `tests/suiteRegistry.test.ts`, which asserts the count and ordered names against `package.json` `pretest`; it must be green. Also `srs.md`'s release-gate bullet under R-M01 states the same count |
| Host facts in `docs/agent-history.md` (Obsidian install, `espeak-ng` presence, flags file) | Re-check on this machine (rule 14): `which obsidian spd-say espeak-ng`, `flatpak list --app`. Dated facts stay dated; correct with a new date, not silently |
| A "Known state" defect | Run it: bundle the module and drive it with the input the entry names, or reproduce in Obsidian. Remove a fixed entry; narrow a partial one |
| The "2 of 16 MUST" floor | Moves only by running `/spec-check`; otherwise leave it and keep its "historical floor" wording |

`AGENTS.md` "Read on demand" says to keep `AGENTS.md` compact: detailed ticket narratives and
measurements go to `docs/agent-history.md`, ADRs or `docs/spikes/`, with only a pointer in
`AGENTS.md`. Preserve corrections and scope limits when moving evidence.

## Step 2c: `CONTEXT.md`

- "Layout" against `git ls-files src | sort`.
- "Pipeline": the `SynthResult` kinds and which engines produce them, against
  `src/audio/types.ts` and each engine's capabilities (rule 9 depends on it).
- "Known structural gaps": each is greppable; a closed gap is removed, a narrowed one rewritten.

Known permanent divergence, not drift: the spec's `TTSBackend`/`SpeechSegment` vocabulary versus
the code's `SpeechEngine`/`SpeechChunk` (`CONTEXT.md` "Vocabulary").

## Step 3

`AGENTS.md` "Style": no em-dashes; cite stable anchors (functions, constants, headings), not line
numbers.
