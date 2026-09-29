# 0007. Angle-bracket autolinks

- Status: accepted
- Date: 2026-09-29
- Ticket: NRL-39 (R-M08, R-M09)

Supplements ADR 0003, which reduced a bare URL to its host and explicitly left
autolinks unrecognised (clause 5).

## Context

CommonMark autolinks, `<https://example.com>` and `<me@example.com>`, render in
Obsidian as a plain link with no brackets. `extractChunks` had no autolink
branch, so the brackets were markup that reached the listener. Reproduced by
bundling the real module from this branch and running both recorded fixtures in
both toggle positions before any source edit:

```
speakUrls false   "See <https://x.com> ok."    -> "See < ok."
speakUrls true    "See <https://x.com> ok."    -> "See < x.com ok."
speakUrls false   "Mail <me@example.com> now." -> "Mail <me@example.com> now."
speakUrls true    "Mail <me@example.com> now." -> "Mail <me@example.com> now."
```

The URL form loses its opening `<` to the bare-URL branch, which only starts
matching at the `h` of `https`, so the `<` is emitted as an ordinary character
and spoken. The email form matches nothing at all and is read whole, mailbox
and brackets included.

Two questions had to be answered rather than inherited. Whether an email
address is spoken at all, since ADR 0003 only decided the matter for URLs; and
how confident the recogniser has to be before it consumes a span, since
everything it consumes is text that stops being spoken.

## Decision

1. **A complete autolink is recognised before HTML and before the bare URL.**
   One branch in `cleanLine`, after the `<!--` comment branch and before the
   HTML tag branch, matching two anchored patterns: a URI form (a generic
   scheme of 2 to 32 characters as CommonMark requires, `://`, then non-space
   non-bracket characters, then `>`), and an email form (an optional
   `mailto:`, a local part, `@`, a dotted domain, then `>`). Both forbid
   whitespace, `<` and `>` inside, which is what leaves `a < b` and
   `x<y and z>w` alone.

2. **The brackets are never spoken, in either toggle position.** They are
   markup: Obsidian does not render them.

3. **The content obeys `speakUrls` and is reduced by ADR 0003's host rule.**
   Off, the whole `<...>` is dropped. On, the host is spoken and nothing else:
   no scheme, no userinfo, no leading `www.`, no port, path, query or fragment.
   `<ftp://files.example.com/x>` says `files.example.com`.

4. **An email autolink follows the same setting, and the mailbox is never
   spoken.** Off it is silent; on it says the domain only. `<me@example.com>`
   and `<mailto:me@example.com>` both say `example.com`. A mailbox is a
   personal identifier read to whoever is in earshot, which is the same
   objection ADR 0003 raised to userinfo, and `mailto:` is a scheme, which
   clause 1 of that ADR already drops. Speaking the domain still tells the
   listener there is an address and where it points.

5. **There is no full-address fallback.** The host reduction is one helper,
   `hostSpan`, shared with the bare-URL branch. An empty span means silence,
   never "read the whole thing instead". A reduction that falls back to the
   full string would defeat the privacy rule exactly when the parse is least
   trustworthy.

6. **Recognition requires positive evidence, and leaked markup is preferred to
   a swallowed word.** An email autolink needs a domain with at least one dot,
   so `<a@b>` stays text. A scheme-less `<example.com>` is not an autolink. An
   opening `<` with no closing `>` on the line is not an autolink, so
   `See <https://x.com and more here.` keeps today's behaviour, stray `<`
   included. A scheme shorter than 2 characters or longer than 32 is not an
   autolink either, matching CommonMark: with a one-character scheme allowed,
   `x<y://z>w` would be consumed here while Obsidian renders it literally,
   deleting visible text and joining `x` to `w`. This is the trade the HTML
   element whitelist already makes: a false positive eats a sentence, a false
   negative reads a bracket.

7. **A glued sentence period is spoken, unlike the bare-URL form.** Consumption
   stops exactly at the closing `>`, so `See <https://x.com>.` keeps its full
   stop. ADR 0003 clause 3 consumes the period with a bare URL because a bare
   URL's extent is only knowable from whitespace; an autolink's extent is
   delimited, so nothing has to be guessed. This is a deliberate difference
   between the two forms, not an inconsistency.

## Consequences

- Clause 5 of ADR 0003 is superseded in part: angle-bracket autolinks are now
  recognised. Scheme-less domains still are not.
- Every spoken host character maps to its true raw offset, computed from the
  position of the `<` plus one, and the dropped brackets, scheme, mailbox and
  path only advance the cursor. `sourceIndex` stays in lockstep with the
  emitted characters (AGENTS.md non-negotiable 8). Tests pin the host offset
  and the offset of the word after an autolink in both toggle positions.
- The existing bare-URL behaviour is unchanged. `hostSpan` was extracted from
  that branch verbatim; the only change is that its scheme prefix is generic
  rather than `https?://`. The prefix is anchored and requires `://`, so it
  still matches `https://`, still matches nothing for a bare `www.` host, and
  matches nothing for `me@example.com` or `mailto:me@example.com`, which is why
  the email forms need no special case: the last `@` of the authority already
  lands on the domain. The whole NRL-10 URL suite passes unchanged as proof.
- The email local part excludes `/`, `?` and `#`. Those are legal in an
  RFC 5322 local part but would be read as the end of the authority by the host
  reduction. Such an address is not recognised as an autolink and keeps today's
  behaviour rather than being mis-reduced.
- Dropping an autolink leaves the source's own space before it, so
  `See <https://x.com>.` is spoken `See .` with the toggle off and
  `See x.com .` with it on. The full stop survives, which is the point of
  clause 7, but a space precedes it. The existing `<!-- -->` branch produces
  the same shape (`See <!-- c -->.` is `See .`), and no engine renders the
  difference audibly. Tests pin it so it stays a decision rather than drift.
- Not addressed: bare unbracketed email addresses and `mailto:` URIs in prose,
  scheme-less `<domain.tld>`, and speaking any full URL or full address.
- NOT VERIFIED IN OBSIDIAN. The reproduction and the fix were both exercised by
  bundling the real module and running it; no deployment, restart or live
  reading was performed in this phase, so actual Reading-view equivalence,
  audible speech and following-word highlighting remain unverified by a human.
