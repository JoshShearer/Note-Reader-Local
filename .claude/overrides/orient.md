# /orient override - Local TTS Reader

Rules: `AGENTS.md` "Non-negotiables". Modules: `CONTEXT.md` "Layout". Known defects:
`docs/agent-history.md` "Known state".

## Step 1

Deps marker for `npm ci` is `node_modules/.package-lock.json`.

## Step 4: what Obsidian is running

The single most time-saving check here: a running Obsidian may be executing another branch's or
another worktree's build. Read-only; never run `npm run deploy` from here. `<vault>` is the
default vault in `deploy.mjs`.

```bash
SLOT="<vault>/.obsidian/plugins/local-tts-reader"
if [ ! -f "$SLOT/main.js" ]; then echo "DEPLOY=none"; else
  echo "DEPLOY_MTIME=$(stat -c '%y' "$SLOT/main.js")"
  cat "$SLOT/.deployed-from" 2>/dev/null || echo "no marker"
  { [ -f main.js ] && cmp -s main.js "$SLOT/main.js"; } && echo "OWNER=this-tree" || echo "OWNER=other-tree-or-older-build"
  NEWER=$(find src manifest.json styles.css esbuild.config.mjs -newer "$SLOT/main.js" 2>/dev/null | head -5)
  [ -n "$NEWER" ] && { echo "DEPLOY=STALE, newer sources:"; echo "$NEWER"; } || echo "DEPLOY=current vs this tree"
fi
```

| Result | Report |
|---|---|
| `DEPLOY=none` | Nothing deployed; any claim a change works is unverified |
| `OWNER=other-tree-or-older-build` | Obsidian runs someone else's build; name the holder from the marker, `/worktrees slot` for the byte comparison |
| `DEPLOY=STALE` | Deploy and reload before testing anything |
| Vault folder missing | Report `DEPLOY=none`; do not create it |

## Step 6: hazards

| Area | Non-negotiables (`AGENTS.md`) |
|---|---|
| `src/text/**`, `src/ui/highlight.ts` | 8 |
| `src/audio/player.ts`, any engine | 9; engines also 4 |
| `src/engines/system/**` | 2, 7 |
| `src/engines/onnx/**` | 5, 6 |
| `src/engines/bridge/**` | 1, 4, 7 (Android-only construction); ADR 0036 |
| `src/settings/**`, `src/ui/settingsTab.ts`, `deploy.mjs` | 10 |
| `src/diagnostics.ts`, any new logging or `throw` | 1, 3 |
| `manifest.json`, `package.json`, `esbuild.config.mjs` | 7; run the `require-list` gate |

Also surface the matching "Known state" entries from `docs/agent-history.md` for that area.

## Next action

Item 5: point at `srs.md` and `/spec-check`; the "2 of 16 MUST" figure is a historical floor, not
a current tally.
