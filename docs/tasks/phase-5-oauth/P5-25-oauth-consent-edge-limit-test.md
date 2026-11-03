---
id: P5-25
title: Test the consent post's edge limit in workerd
phase: 5
status: todo
priority: low
depends_on: [P5-19]
adr: ["0010"]
lessons: [L-121]
owner: ""
---

# P5-25 — Test the consent post's edge limit in workerd

> Created by P5-19: the workerd OAuth test Worker uses a consent stand-in that has no `/oauth/consent` route, so the consent post's
> `RL_OAUTH` wiring is covered only where the http-app routes are (same `limited(..., edge)` call as authorize and token).

## Goal
A negative test that fails when the edge hook is removed from the consent post, on the real built-in consent screen.

## Scope
- A test on the panel's test server (`packages/http-app/test/helpers/panel.ts`) that passes `limits.beforeOAuth` and shows a refusal
  reaches the consent screen's code never (no session lookup, no handle taken).

## Acceptance criteria
- [ ] The test exists and fails when `edge` is dropped from the consent route in `app.ts`.

## Security notes
THREAT_MODEL T20.

## Lessons applied
- L-121 — Negative authorization tests that fail when the fix is reverted.

## Docs to update
- None.

## Out of scope
- Changing the limits.
