# /ship override - Local TTS Reader

## Step 4: gates

Read `npm test` as `overrides/verify.md` Step 3 says. A red `engine` suite from a missing
`spd-say` or a dead daemon is an environment failure: name what was missing and do not present the
suite as green.

## Step 4b: Obsidian

Deploy, mark, reload and record exactly as `overrides/verify.md` Steps 4-5 (check the lock but don't take it, `npm run
deploy`, `.deployed-from`, reload, instance). Say in the report that this tree deployed
(the plugin folder now holds its build). What to touch, by area:

| Changed | Do this in Obsidian |
|---|---|
| `src/text/**` | A note with a wikilink, an embed, a code fence, a URL and `---` on line 1: `Read this note aloud`. No spoken brackets, highlight on the right word, chunks at all |
| `src/audio/player.ts` | `Read note aloud`, `Pause or resume reading` twice, `Repeat current sentence`, `Next sentence`, `Stop reading`. Watch `n / total` and listen for overlap |
| Any engine | Read the same note on each engine touched, at 1x and 1.5x. Rate applied twice is audible |
| `src/engines/onnx/**` | Kokoro cold: first-utterance stall, and no network request in DevTools |
| `src/settings/**`, `src/ui/settingsTab.ts` | Change the rate, reload, confirm it survived and nothing else in `data.json` was lost |
| `src/ui/highlight.ts` | A long note: the highlight tracks through a heading, a list and a code fence |
| `src/engines/bridge/**`, mobile UI | Android Obsidian over CDP with Read Me Offline (see `overrides/verify.md`), or `NOT VERIFIED IN OBSIDIAN` for that half |

## Step 7: commit

- Scopes mirror `CONTEXT.md` "Layout": `extract`, `segment`, `player`, `words`, `wav`, `engines`,
  `espeak`, `speechd`, `webspeech`, `kokoro`, `bridge`, `settings`, `ui`, `highlight`, `paths`,
  `diagnostics`, `build`, `release`, `agents`, `run-tickets`.
- Footer `Resolves NRL-<N>` (it does not close the issue; `/finish` does). No em-dashes.
- Never stage: `main.js`, `kokoro-worker.js`, `ort/`, `*.map`, `tests/.build/`, `data.json`,
  `models/`, `.claude/deploy.lock/`, `.claude/pipeline-state*.json`, `.claude/last-critique.md`,
  `.claude/scratch/`. Any of them tracked or staged: stop and check `.gitignore`.

## Step 9: PR body additions

- `### Source Offsets` under Implementation Notes whenever `src/text/**`, `words.ts` or
  `highlight.ts` changed: how you confirmed every dropped span still pushes a `sourceIndex` entry.
- `### Dependencies`: if any were added, the `require-list` gate's output after build.
- Manual Test Plan starts `npm run deploy`, then reload Obsidian, then named UI actions from
  `overrides/verify.md` Step 5 (`Test the plugin` is not a test plan).
- Non-negotiables checklist: no note text in logs; text on stdin not argv; no network added and
  worker guards intact; `main.js` require list unchanged; `sourceIndex` in lockstep; rate applied
  once; settings normalisation preserves unknown keys.
