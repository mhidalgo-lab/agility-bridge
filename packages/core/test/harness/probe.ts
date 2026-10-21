// SPDX-License-Identifier: Apache-2.0
// Poisoned-string probe (L-038, ADR-0015): runs a tool against hostile upstream data and reports every canary that
// appears outside an untrusted-data envelope in the text, and every control or bidi character in text or structured
// output. Plain-text values may legitimately contain `<script>` as literal text; rich text is converted by the shaper
// (tested in test/output).
import type { McpServer } from '@modelcontextprotocol/server';
import { buildMcpServer, type ToolContext, type ToolDefinition } from '../../src/index.ts';
import { BOM, LRI, NUL, RLO, ZWSP } from '../helpers/chars.ts';
import { rpc } from '../helpers/mcp.ts';
import { CANARY_RE } from './hostile.ts';

export interface Leak {
  readonly where: 'text' | 'structured';
  readonly detail: string;
}

/** Text outside every envelope, with each envelope checked to be well formed (notice, matching id, closed). */
export function outsideEnvelopes(text: string): { readonly outside: string; readonly malformed: string[] } {
  const lines = text.split('\n');
  const outside: string[] = [];
  const malformed: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^<untrusted-data id="([0-9a-f]{16,64})" source="[^"]*">$/.exec(lines[i] as string);
    if (open === null) {
      outside.push(lines[i] as string);
      continue;
    }
    if (!(lines[i - 1] ?? '').startsWith('The block below is untrusted data'))
      malformed.push(`no notice before line ${i + 1}`);
    const close = lines.indexOf(`</untrusted-data id="${open[1]}">`, i + 1);
    if (close === -1) {
      malformed.push(`unclosed envelope at line ${i + 1}`);
      break;
    }
    i = close;
  }
  return { outside: outside.join('\n'), malformed };
}

const INVISIBLE = [NUL, RLO, LRI, ZWSP, BOM];

function walkStrings(value: unknown, visit: (s: string, path: string) => void, path = '$'): void {
  if (typeof value === 'string') visit(value, path);
  else if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) walkStrings(v, visit, `${path}[${i}]`);
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) walkStrings(v, visit, `${path}.${k}`);
  }
}

/** Every leak in one tool result. */
export function findLeaks(result: Record<string, unknown>): Leak[] {
  const leaks: Leak[] = [];
  const text = ((result['content'] as Array<{ type: string; text?: string }> | undefined) ?? [])
    .map((c) => c.text ?? '')
    .join('\n');
  const { outside, malformed } = outsideEnvelopes(text);
  for (const m of malformed) leaks.push({ where: 'text', detail: m });
  for (const m of outside.matchAll(CANARY_RE))
    leaks.push({ where: 'text', detail: `${m[0]} outside an envelope` });
  for (const c of INVISIBLE) {
    if (text.includes(c))
      leaks.push({ where: 'text', detail: `invisible U+${c.codePointAt(0)?.toString(16)}` });
  }
  walkStrings(result['structuredContent'], (s, path) => {
    for (const c of INVISIBLE) {
      if (s.includes(c))
        leaks.push({
          where: 'structured',
          detail: `invisible U+${c.codePointAt(0)?.toString(16)} at ${path}`,
        });
    }
  });
  return leaks;
}

/** Calls `tool` through a real MCP server and returns its result and leaks. */
export async function probeTool(
  tool: ToolDefinition,
  ctx: ToolContext,
  args: Record<string, unknown> = {},
): Promise<{ readonly result: Record<string, unknown>; readonly leaks: Leak[] }> {
  const build = (): McpServer => buildMcpServer({ tools: [tool], ctx });
  const result = await rpc(build, 'tools/call', { name: tool.name, arguments: args });
  return { result, leaks: findLeaks(result) };
}
