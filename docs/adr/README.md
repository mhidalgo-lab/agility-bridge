# Architecture Decision Records

Lightweight [MADR](https://adr.github.io/madr/) records: one file per decision, numbered once and never renumbered.
A changed decision gets a new ADR that supersedes the old one, so the reasoning behind every change stays readable
(L-007).

Statuses: `proposed` · `accepted` · `accepted (pending spike PX-NN)` · `superseded by NNNN` · `rejected`.

| ADR | Title | Status |
|---|---|---|
| [0001](0001-markdown-planning.md) | Markdown files for decisions and tasks | accepted (owner) |
| [0002](0002-name-and-trademark.md) | Project name `agility-bridge` and trademark posture | accepted (owner) |
| [0003](0003-license-apache-2.md) | Apache-2.0 license with DCO | accepted (owner) |
| [0004](0004-typescript-runtime-agnostic-core.md) | TypeScript monorepo, runtime-agnostic core, Hono | accepted (owner) |
| [0005](0005-mcp-sdk-v2-stateless.md) | MCP SDK v2, stateless HTTP, dual protocol era | accepted (2026-10-21, P0-07) |
| [0006](0006-storage-sqlite-d1-yaml.md) | One SQLite schema for Node and D1, YAML for stdio | proposed |
| [0007](0007-secrets-envelope-encryption.md) | Envelope encryption of Agility access tokens | proposed |
| [0008](0008-access-model.md) | Instances, credentials, workspaces, grants, device tokens; bring-your-own-token | accepted (token policy) / proposed |
| [0009](0009-authentication.md) | Device tokens first, OAuth 2.1 next; admin sign-in providers | proposed (spike P0-08) |
| [0010](0010-platform-limits-strategy.md) | Budgets, concurrency and retries | proposed (spikes P0-06, P0-09) |
| [0011](0011-agility-api-surface.md) | Agility API surface: which endpoint for what | accepted (2026-10-21, P0-06) |
| [0012](0012-structured-query-no-raw-passthrough.md) | Validated generic query tool with bound parameters; no raw passthrough | accepted (owner) |
| [0013](0013-opt-in-writes-human-approval.md) | Opt-in write tools with human approval by default | accepted (policy) / proposed (approval details, D-10 – D-12) |
| [0014](0014-supported-agility-installations.md) | Hosted and on-premises instances, HTTPS, custom CA, access tokens | accepted (owner) |
| [0015](0015-tool-output-contract.md) | Tool output contract and untrusted-data envelope | accepted (2026-10-21, P0-11) |
| [0016](0016-mcp-client-support.md) | MCP client support policy | accepted (owner) |

"accepted (owner)" means the project owner took the decision on 2026-10-16 while reviewing the initial plan; the
details of those ADRs can still be refined by the tasks they reference.
