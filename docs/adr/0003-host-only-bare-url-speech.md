# 0003. Host-only bare URL speech

- Status: accepted
- Date: 2026-09-28
- Ticket: NRL-10 (R-M09)

## Context

R-M09 requires a setting for whether URLs are spoken. The setting existed
(`speakUrls`, stored since NRL-5, ADR 0001) and was rendered as "Speak bare
links", but `extractChunks` never read it: every bare URL was dropped whatever
the toggle said. Reproduced by bundling the real module:
`"See https://example.com/x now please."` returned `["See now please."]` with
the toggle on.

Wiring the toggle raises the question of what "speaking a URL" should sound
like. Reading the whole string is close to useless to a listener:
`https://example.com/a/b?c=d` becomes a long run of "slash", "question mark",
single letters and percent-escapes, and a query string can be dozens of
characters of opaque tokens. The engines also differ in how they pronounce
punctuation, so the same URL would sound different on each.

## Decision

1. **A bare URL is spoken as its host only.** With `speakUrls` on, the scheme
   (`https://`, `http://`), any userinfo (`user:secret@`, see Consequences)
   and one leading `www.` are skipped, the host is the
   longest run of letters, digits, `.` and `-` after that, and everything else
   up to the next whitespace (port, path, query, fragment) is
   dropped. `See https://example.com/a/b?c=d now.` is spoken as
   `See example.com now.` A bare `www.example.com` and a URL alone on a line
   reduce the same way.

2. **The host is the part a listener can use.** It says where the link goes,
   it is short, and it is usually made of words. The path and query are for a
   browser, not an ear.

3. **Trailing `.` and `-` are trimmed from the host.** A sentence period glued
   to a URL (`see https://x.com.`) is not part of the host. The period itself
   is still consumed with the URL, as it was before this change, so the
   sentence loses its final stop in both positions. Restoring it is out of
   scope.

4. **Markdown links and wikilinks are unaffected.** `[label](url)` and
   `[[target|alias]]` are consumed by their own branches before the URL branch
   runs. Their label is always spoken and their target never is, in either
   position of the toggle.

5. **Detection is unchanged.** The existing detector (`http://`, `https://` or
   `www.` at the cursor, consumed to whitespace) is reused. Autolinks in angle
   brackets and scheme-less domains are not recognised as URLs; that is a
   separate question from how a recognised one is spoken.

## Consequences

- Every spoken host character maps to its true raw offset, and the dropped
  scheme, path and query only advance the cursor, so `sourceIndex` stays in
  lockstep and highlighting lands on the host in the editor. Tests pin the host
  offset and the offset of the word after a URL in both positions.
- Two different URLs on the same site sound identical. A user who needs the
  full address has the note open in front of them.
- The default (`speakUrls: false`) is unchanged: bare URLs are dropped.
- The settings description says "site name ... not the full address" so the
  toggle does not promise more than it does.
- Userinfo is never spoken. In `https://user:secret@example.com/` the
  username and password are credentials, and reading them aloud is a privacy
  leak to anyone in earshot. The authority is the text after the scheme up to
  the first `/`, `?` or `#`; the host starts after the last `@` in it (a
  password may itself contain `@`), and a leading `www.` is then skipped as
  usual. An `@` in the path or query is not userinfo and does not move the
  host. The host characters keep their true raw offsets. Tests assert that
  `user` and `secret` are absent from the spoken text for `user@` and
  `user:secret@` forms.
