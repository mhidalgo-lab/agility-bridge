---
title: agility-bridge
# Starlight titles a page "<page> | <site>", which reads "agility-bridge | agility-bridge" here.
head:
  - tag: title
    content: agility-bridge documentation
description: An open-source MCP server that lets AI agents work with Digital.ai Agility through its public APIs.
---

An open-source [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI agents (GitHub Copilot,
Claude, Cursor, Windsurf and others) work with **Digital.ai Agility** through its public APIs, using **each member's own
access token**.

## Start here

- One person, on your machine: [local quickstart](/guide/quickstart-local/).
- A team, on a server or a Cloudflare Worker: [remote quickstart](/guide/quickstart-remote/), then the
  [admin guide](/guide/admin-guide/).
- Connect a client: [client setup](/guide/clients/) and [client compatibility](/reference/client-compatibility/).
- What the tools return: [tool reference](/reference/tools/) and [output formats](/guide/output-formats/).
- Something wrong: [troubleshooting](/guide/troubleshooting/).

## How it is built and secured

- [Architecture](/architecture/) and the [decision records](/adr/).
- [Threat model](/threat_model/), [secrets](/guide/secrets/) and [data protection](/security/data-protection/).
- [Roadmap](/roadmap/) and [lessons learned](/lessons-learned/).

The source and the issue tracker are on [GitHub](https://github.com/mhidalgo-lab/agility-bridge). These pages are built
from the repository's `docs/` folder on every change to `main`; tasks and pending decisions stay in the repository.
