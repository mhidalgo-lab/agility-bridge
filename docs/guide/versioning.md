# Support, versioning and deprecation policy

> Policy for agility-bridge **0.8 and later** (P9-05). The 1.x support window below is a recommendation the owner
> confirms before 1.0 ([D-366](../pending-decisions/phase-9.md)). Upgrading: [upgrading](upgrading.md). Reporting a
> vulnerability: [SECURITY.md](../../SECURITY.md).

## Semantic versioning

agility-bridge follows [semantic versioning](https://semver.org). One version number covers the npm package, the Docker
image and the Cloudflare Worker bundle; they are built from the same commit.

**Public surface** (what a version number promises):

| Surface | Breaking | Not breaking |
|---|---|---|
| Tool names, arguments, output fields and error codes ([tool conventions](../dev/tool-conventions.md)) | Renaming or removing a tool, argument, output field or `AB_*` error code; making an optional argument required; narrowing an accepted value; changing a field's type or meaning | Adding a tool, an optional argument, an output field or an error code; rewording a description |
| Configuration: `AB_*` environment variables and their defaults ([configuration](configuration.md)) | Renaming or removing a variable; changing what a value means; changing a default so that existing deployments behave differently | Adding a variable whose default keeps today's behaviour |
| CLI commands, flags and exit codes ([CLI reference](../reference/cli.md)) | Renaming or removing a command or flag; changing an exit code; changing the output format of a command meant for scripts | New commands or flags; changes to human-readable text |
| HTTP routes: `/w/{slug}/mcp`, the admin API, the OAuth and well-known endpoints ([admin API](../reference/admin-api.md)) | Removing or renaming a route, changing a method, status code, or required header or field | New routes, optional fields and headers |
| Storage: the SQLite and D1 schema and the config export format | A migration that cannot run on the previous minor's data, or one that loses data | Forward-only migrations that add tables, columns or indexes ([storage](../dev/storage.md)) |
| Supported runtimes (Node versions, below) and MCP protocol revisions | Dropping a Node version or a protocol revision | Adding one |

Internal modules, the admin panel's HTML and CSS, log message text and anything not listed above are not part of the
surface.

**Security exception.** A fix for a vulnerability may tighten a default or refuse input that used to be accepted without
the deprecation period. The advisory and the release notes say so ([SECURITY.md](../../SECURITY.md)).

### Before 1.0

`0.x` follows semver's 0.x convention: a **minor** release (`0.8` to `0.9`) may contain breaking changes, a **patch**
release (`0.8.1`) never does. Every breaking change is listed in the release notes with what to do. Pre-1.0
deprecations last at least one minor release: a deprecated tool argument keeps working, with a `Note:` in the result and
one warning in the log, until the version the registry names (below).

### From 1.0

Breaking changes only in a **major** release, after the deprecation window below. Minor releases add features;
patch releases fix bugs and security problems.

## What is supported

### Node.js

| Node | Status |
|---|---|
| 24 | Supported: `engines` is `>=24`, the CI runs it on Linux, and the CLI and `node:sqlite` also on macOS and Windows. The Docker image is built on it. |
| 26 | Supported: the CI test matrix runs it on Linux. |
| 22 and older | Not supported (`engines`). |

A new Node release joins the CI matrix when it is released. We drop a Node version in a **minor** release (a major from
1.0), announced one release ahead, and not before the Node project ends its security support for it. The Cloudflare
Worker bundle runs on `workerd`, not on Node.

### Digital.ai Agility

| Agility | Status |
|---|---|
| Hosted (SaaS) instances, current release | Supported. Verified on 26.0.3.2 ([research](../RESEARCH.md)); the public APIs we use (`query.v1`, `meta.v1`, `rest-1.v1`) have been stable for years. |
| On-premises | Best effort, with a private CA through `AB_CA_FILE`. The **minimum on-premises version is unknown** (*unverified*): testing it needs a tenant ([D-367](../pending-decisions/phase-9.md)). No minimum is promised until then. |

An Agility change that breaks an API we use is handled as a bug.

### MCP protocol revisions and clients

The server serves both protocol eras and negotiates with each client: **2026-07-28** and the 2025-era revisions
(2025-06-18, 2025-11-25). Dropping a revision is a breaking change and follows the deprecation window. Which clients were
verified, with which version and on which date, is in the
[client compatibility page](../reference/client-compatibility.md), the source of truth.

- **Primary clients** (in the release gate): GitHub Copilot (VS Code, JetBrains, CLI), Claude Code, Claude Desktop,
  claude.ai and Claude mobile, Cursor, Windsurf, MCP Inspector.
- **Secondary clients** (best effort): Copilot cloud agent, Visual Studio, Zed, Cline, Roo Code, ChatGPT connectors,
  Gemini CLI.

A client release that breaks the connection is handled as a bug. A verified cell names the tested client version; newer
versions are expected to work and older ones are not promised.

## Security fixes

| Version | Security fixes |
|---|---|
| Latest minor (`0.8.x` today) | Yes, as a patch release. |
| Older `0.x` | No: upgrade to the latest minor. |
| 1.x (recommended, [D-366](../pending-decisions/phase-9.md)) | The latest minor, and the **previous minor for 90 days** after a new minor is released, through a `release/x.y` branch ([backports](../dev/releasing.md)). Older minors: upgrade. |

A fix lands on `main` first. Severity targets, reporting and advisories in dependencies are in
[SECURITY.md](../../SECURITY.md). Every backport is released with the same checks as any release (provenance, SBOM,
signed image): [verify a release](verify-release.md).

## Deprecation

- **From 1.0:** a deprecated tool, argument, output field, environment variable, CLI flag or route keeps working for **at
  least one minor release and six months**, whichever is longer, and is removed only in a major release. Before 1.0 the
  minimum is one minor release.
- The announcement is the release notes of the version that deprecates (a *Deprecated* section) and, for tools, the
  `Deprecated:` prefix in the description.
- The machine-readable registry (`DEPRECATIONS` in `packages/core/src/deprecations.ts`, L-045) lists each item with the
  version that deprecated it (`since`), its replacement and the first version that removes it (`removeIn`). A server
  logs one warning per process for a deprecated environment variable that is set, and a deprecated tool argument adds a
  `Note:` to the result.
- Entries deprecated before this policy (`get_work_item.minimal_output`, deprecated in 0.6.0) keep the window they were
  announced with.

## Where to find things

- Release notes: GitHub Releases and the changeset entries in the repository.
- The tools: [tool reference](../reference/tools.md).
- Verifying a download: [verify a release](verify-release.md).
