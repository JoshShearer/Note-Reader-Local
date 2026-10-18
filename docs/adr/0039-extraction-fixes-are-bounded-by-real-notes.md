# 0039. Extraction fixes are bounded by real notes

- Status: accepted
- Date: 2026-10-17
- Ticket: none (owner decision during a whole-project review)
- Requirements: R-M08, R-M09
- Amends: ADR 0018 ("Speak what the renderer shows"), which stays the direction of a fix but no
  longer decides which mismatches are worth fixing

## Context

The project started with about 33 planned tickets (NRL-5 to NRL-37) and reached 221 by
2026-10-17. About 120 of them, by a keyword sort of titles, are markdown-extraction mismatches
against Obsidian's renderer. 48 of the 49 tickets created in the week of 2026-10-12 were
extraction, and 43 titles name an earlier ticket as a "remainder" or "residual".
`src/text/extract.ts` grew from 391 lines on 2026-09-28 to 10,040.

The inputs came from generators: fuzzers, census grids and critic-written corpora built to
find where the extractor and the parser harness disagree. ADR 0018 made every disagreement a
defect, and `docs/agent-history.md` records the cascade: removing one accidental stop exposes the
next misjudgement downstream. With critics required to write a new generator per change and no
human deciding what gets filed, the inflow could not reach zero.

The owner's vault was measured the same day (2,329 notes, main `38f3fce`, harness 1.14.4, the
vault check in `~/.local/share/note-reader-local/vault-check/`):

- Five defect shapes found by the vault check fire on real notes. Numeric `#123` is dropped
  as if it were a tag, in 145 notes. Bare `www.` links are dropped. HTML entities are spoken
  raw. A lone `*` inside a word is dropped, and `word[1][2]` joins into one word. Also, one
  5.2 MB note takes 50 s in `extractChunks`. None of these had a ticket.
- Of the 32 open extraction tickets, the trigger shape of 25 occurs in no note at all. Seven
  occur, and a window-and-ablation check attributes a mismatch to one of them, NRL-190 (a pipe
  table directly under a paragraph line, 5 notes). The trigger shapes are regex approximations
  of each ticket's repro, so this is strong evidence, not a proof.

## Decision

1. **An extraction mismatch is worth a ticket only with real-note evidence.** Either the vault
   check (or a direct run of the extractor and the harness on a vault note) shows it firing,
   with the note count recorded, or the owner reported it from use. The ticket carries a
   `Vault evidence:` line with the count and never the note text or path.
2. **Generated inputs test a fix; they do not create work.** Fuzzers, census grids and critic
   generators remain the way a fix is checked against regressions. A mismatch they find that
   the vault does not contain is listed in the PR body under "Residuals (generated inputs)" and
   goes nowhere else: no ticket, no BLOCK, no Fix round.
3. **A BLOCK on an extraction change needs a regression against base** on the vault check, the
   suite, or a shape a person plausibly types. Speaking a hidden `%%` or `<!-- -->` comment
   body on such a shape stays a BLOCK, because people hide private text in comments.
4. **Open extraction tickets without vault evidence are canceled**, not deleted, with a comment
   saying why. A canceled ticket is reopened when vault evidence or an owner report appears.
5. **`/run-tickets` triage blocks an extraction ticket without a `Vault evidence:` line** or an
   owner report.

## Consequences

- The extractor will keep diverging from the renderer on shapes nobody writes. That is accepted.
- The vault is one person's. A shape that is common elsewhere but absent here is not evidence
  either way. The owner's reports from use are the second route in.
- The vault check compares word bags. It cannot see order, offsets or pauses, and it has known
  noise. Its README lists both.
- Whether to replace the hand-written scanner with a real parser (for example CodeMirror's
  syntax tree, which carries source offsets) is a separate, open question this ADR does not
  decide.
