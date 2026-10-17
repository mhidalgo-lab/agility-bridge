# ADR-0002 — Project name `agility-bridge` and trademark posture

- **Status:** accepted (owner, 2026-10-16)
- **Date:** 2026-10-16
- **Related:** P0-02, [RESEARCH.md](../RESEARCH.md) (trademarks)

## Context

The project is an unofficial, community MCP server for the Digital.ai Agility platform (formerly VersionOne).
"Digital.ai" is a trademark of Digital.ai Software, Inc., which also owns the Agility product and the legacy VersionOne
brand. Its Terms of Use forbid using its trademarks "in connection with any product or service that is not ours, or in
any manner that is likely to cause confusion" (RESEARCH §1.10). A project name must be recognisable to Agility users
without suggesting that the vendor builds, endorses or supports it.

Its Acceptable Use Policy also restricts use of the service to "interfaces provided or expressly authorized" (the
documented REST APIs) and prohibits using service data to create, train or improve machine-learning systems.

## Decision

- The project, repository, npm package and CLI binary are named **`agility-bridge`**. Configuration variables use the
  `AB_` prefix and device tokens the `ab_` prefix.
- The name, logo and package metadata never use "Digital.ai" or "VersionOne" as part of the project's own name. Product
  names appear only descriptively ("an MCP server for Digital.ai Agility").
- Every public surface (README, docs site, npm description, MCP registry entry, admin panel footer) carries the
  disclaimer: *agility-bridge is an unofficial, community project. It is not affiliated with, endorsed by, or supported
  by Digital.ai. Digital.ai, Agility and VersionOne are trademarks of their respective owners.*
- No vendor logos or screenshots of vendor branding beyond what is needed to explain configuration.
- agility-bridge uses only the documented Agility APIs, connects with each organisation's own credentials, keeps no
  corpus of Agility data and trains nothing. The README states that use is subject to the organisation's Agility
  license and Digital.ai's Terms of Use and Acceptable Use Policy, and that tool output is sent to whatever model the
  MCP client uses.

## Consequences

- Users can find the project by searching for Agility while the posture stays clearly unofficial.
- If the trademark owner objects, the rename cost is contained: the `AB_`/`ab_` prefixes do not embed a vendor mark.

## Alternatives considered

- **`digitalai-agility-mcp` / `versionone-mcp`:** rejected; embeds the vendor's marks and implies affiliation.
- **A name without "agility":** rejected; poor discoverability for the intended users.
