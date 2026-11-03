---
id: P9-12
title: "Consent page client names: compatibility-form look-alikes"
phase: 9
status: todo
priority: low
depends_on: [P9-02]
adr: []
lessons: [L-121]
owner: ""
---

# P9-12 — Consent page client names: compatibility-form look-alikes

## Goal
Make the unverified-client name on the consent page harder to use for impersonation (T10), a gap the internal pre-review
(P9-02) found.

## Scope
- `safeClientName` (`packages/http-app/src/oauth/clients.ts`) refuses mixed Latin and Cyrillic or Greek names, but not
  fullwidth or mathematical Latin ("Ｃｌａｕｄｅ", "𝐂𝐥𝐚𝐮𝐝𝐞"), Cherokee letters or all-Cyrillic words that look Latin.
- Options (decide in the PR and record it as a decision): refuse a name that changes under NFKC; or show the NFKC form and
  keep the original out of the page; and add Armenian and Cherokee to the mixed-script check. Legitimate names with `™` or
  ligatures change under NFKC, so refusing needs a small allowlist or a display-only approach.

## Acceptance criteria
- [ ] A name made of compatibility-form Latin letters is refused or shown in its normal form, by test; legitimate names
      (`Claude`, `Visual Studio Code`, `Cursor™`) still connect.
- [ ] The consent page still marks dynamic clients as not verified and names the redirect host.

## Security notes
T10 (consent phishing), A13.

## Lessons applied
- L-121 — Negative tests that fail when the fix is reverted.

## Docs to update
- docs/THREAT_MODEL.md, docs/guide/oauth-operator.md

## Out of scope
- Verified-client lists.
