# CLI reference

```text
agility-bridge [stdio]      Serve MCP on stdin/stdout (the default; started by your MCP client)
agility-bridge --version    Print the version
agility-bridge --help       Print the help
```

| Exit code | Meaning |
|---|---|
| `0` | Normal end (the client closed stdin), or `--version` / `--help` |
| `1` | Invalid configuration: one line on stderr says what to fix |
| `2` | Unknown argument, or a secret passed as a flag (refused: secrets come from the environment) |

In stdio mode stdout carries only MCP messages; logs are JSON lines on stderr, redacted. Configuration:
[guide](../guide/configuration.md). `serve` and the management commands arrive with Phase 2; this page is generated
from the CLI once they exist (P1-13).
