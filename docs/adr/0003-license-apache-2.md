# ADR-0003 — Apache-2.0 license with DCO

- **Status:** accepted (owner, 2026-10-16)
- **Date:** 2026-10-16
- **Related:** P0-02, P0-03

## Context

The server is meant to be deployed by companies inside their own networks and shared across teams. Companies need a
permissive license with an explicit patent grant; contributors need a lightweight way to certify their contributions.

## Decision

- License: **Apache License 2.0**, with a `NOTICE` file and SPDX headers (`SPDX-License-Identifier: Apache-2.0`) in
  source files (checked in CI).
- Contributions: **Developer Certificate of Origin** sign-off on every commit (`git commit -s`), enforced by a local hook
  and a required CI check. No CLA.

## Consequences

- Permissive reuse with patent protection; `NOTICE` must ship in published packages (it is not added by `pnpm pack`
  automatically, so the package files list includes it).
- DCO enforcement must handle bots (Renovate, release automation) explicitly.

## Alternatives considered

- **MIT:** simpler, but no explicit patent grant.
- **Apache-2.0 with a CLA:** heavier for contributors; not needed for a community project.
