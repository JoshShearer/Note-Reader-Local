# Override: /finish - Local TTS Reader

## Step 1

Auto-delete-after-merge has never run on this repo, so merged branches usually still exist on the
remote: expect the second scan to find them. Leave `run/<stamp>` branches and `<primary>-run-*`
lanes to `/run-tickets`.

## Step 7: worktree residue and the deploy slot

Dirty residue after a merge is usually `main.js`, `kokoro-worker.js`, `ort/`, `tests/.build/` and
`node_modules`. Still confirm before `--force`.

Stale-build check, read-only (`<vault>` is the default vault in `deploy.mjs`):

```bash
SLOT="<vault>/.obsidian/plugins/local-tts-reader"
cat "$SLOT/.deployed-from" 2>/dev/null || echo "no marker"
{ [ -f main.js ] && cmp -s main.js "$SLOT/main.js"; } && echo "slot=primary" || echo "slot=elsewhere-or-stale"
```

`slot=elsewhere-or-stale`, or the marker names the removed worktree: tell the user to run `npm run
deploy` from the primary once `main` is synced (and `.claude/deploy.lock/` is not held by a `/run-tickets`
lane), then reload.

## Step 10: Local TTS Reader specifics

- The known-defects section is `docs/agent-history.md` "Known state"; per-area defects are listed
  there, not in `AGENTS.md`.
- The "2 of 16 MUST" figure moves only with a requirement ID closed on an Obsidian observation
  (date, host, build). Never on a guess.
- `CONTEXT.md`: edit only for architecture (a new file in "Layout", a vocabulary term, a closed
  "Known structural gaps" entry). Never log bug fixes there.
- Deviation: ADR in `docs/adr/` after the highest number, plus the `srs.md` amendment, same commit.
