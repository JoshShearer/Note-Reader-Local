# /worktrees override - Local TTS Reader

The target is one fixed plugin folder in one vault, so the slot is that folder. `<vault>` is the
default vault in `deploy.mjs` (`npm run deploy` passes no argument);
`SLOT=<vault>/.obsidian/plugins/local-tts-reader`.

`deploy NRL-N` is an alias for `take NRL-N`.

## The slot: who Obsidian is running

- **Install step**: `npm run deploy`. Prerequisite: the vault exists (`.obsidian/` present).
- **Marker**: `$SLOT/.deployed-from`, two lines: absolute worktree path, then
  `branch=<name> commit=<short> at=<ISO>` (a `/run-tickets` lane writes its `runId` and commit).
  It survives `deploy.mjs`'s prune only because dotfiles are kept by name: never rename it to a
  non-dot name. Obsidian ignores it.
- **Ownership check** (`main.js` is gitignored, each tree builds its own). Include `run-*` lanes:
  `/run-tickets` deploys merged `main` from its lane, and omitting them attributes the slot to
  nobody:

```bash
shopt -s nullglob
for d in "$PRIMARY" "${PRIMARY}"-nrl-* "${PRIMARY}"-run-*; do
  [ -f "$d/main.js" ] || continue
  cmp -s "$d/main.js" "$SLOT/main.js" && echo "OWNS SLOT: $d" || echo "stale:    $d"
done
```

## Create

- Step 5: nothing to copy. `data.json` is per-vault in the slot, and Kokoro weights live in the
  vault outside the plugin folder (`CONTEXT.md`), shared by every worktree.
- Step 6: `npm ci` (slow). Step 7: run `npm run build` before `npm test` (`tests/release.test.ts`
  reads `main.js`).
- Branch kinds: `feature/`, `fix/`.

## Take

- Step 6: after deploying, write the marker (format above) and tell the user to reload Obsidian
  (Ctrl+P, `Reload app without saving`). An un-reloaded deploy produces a "fix did not work"
  report against the previous build.
- Never take the slot from a live `/run-tickets` lane without saying so. While this lock is held,
  `/run-tickets` skips its deploys and reports the holder.
- Step 5: never delete or overwrite `$SLOT/data.json` to get a deploy through; it holds the user's
  settings and every reading position (non-negotiable 10).

## Remove

`--force` deletes only gitignored output (`node_modules`, `main.js`, `kokoro-worker.js`, `ort/`).

## Conflicts: high-collision files

| File | Why |
|---|---|
| `src/text/extract.ts`, `src/text/segment.ts`, `src/audio/words.ts` | Two edits merge cleanly and jointly break the `sourceIndex` invariant (8); whoever merges second re-runs `tests/extract.test.ts` and re-checks `sourceIndex.length === text.length` |
| `src/audio/player.ts` | The single playback controller (9) |
| `src/audio/types.ts` | The engine contract; a capability added on one branch is invisible to another |
| `src/settings/index.ts`, `src/settings/data.ts` | Settings, defaults, normalisation and data versioning in one place (10, ADR 0001) |
| `src/main.ts`, `src/ui/settingsTab.ts` | Every command and every setting lands here |
| `package.json` `pretest` + `AGENTS.md` gate line | Two new suites collide in the registry `tests/suiteRegistry.test.ts` asserts |
| `docs/adr/` | Two branches pick the same next number (`tests/adrNumbers.test.ts`) |
