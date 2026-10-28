// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { ToolDefinition, ToolKind } from './tool.ts';

const NAME_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const KINDS: ReadonlySet<ToolKind> = new Set(['read', 'write', 'destructive']);

/** Input property names that look like secrets (tool conventions, secret-field lint; THREAT_MODEL T23, L-070). */
export const SECRET_FIELD_RE: RegExp =
  /token|api[_-]?key|apikey|password|passwd|secret|authorization|cookie|session|credential|private[_-]?key/i;

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryError';
  }
}

export interface RegistryOptions {
  /** Allow `write` / `destructive` tools to be registered at all (ADR-0013). Default false. */
  readonly allowNonRead?: boolean;
}

export interface SelectOptions {
  /** Tool names granted to the caller; unknown names are ignored. Undefined: every registered tool of the kinds. */
  readonly allowed?: Iterable<string>;
  /** Groups enabled for the caller. Undefined: every group. */
  readonly groups?: Iterable<string>;
  /** Kinds permitted for this caller (default: read only). */
  readonly kinds?: Iterable<ToolKind>;
  /** The deployment's per-call Agility request budget: tools whose declared cost exceeds it are hidden (L-115). */
  readonly maxCost?: number;
}

/** Every property name anywhere in a JSON Schema (properties, items, combinators, `$defs`). */
export function collectPropertyNames(schema: unknown, out: Set<string> = new Set(), depth = 0): Set<string> {
  if (depth > 32 || schema === null || typeof schema !== 'object') return out;
  if (Array.isArray(schema)) {
    for (const s of schema) collectPropertyNames(s, out, depth + 1);
    return out;
  }
  const obj = schema as Record<string, unknown>;
  const props = obj['properties'];
  if (props && typeof props === 'object') {
    for (const [k, v] of Object.entries(props)) {
      out.add(k);
      collectPropertyNames(v, out, depth + 1);
    }
  }
  for (const key of ['items', 'prefixItems', 'additionalProperties', 'anyOf', 'oneOf', 'allOf', 'not']) {
    const v = obj[key];
    if (v && typeof v === 'object') collectPropertyNames(v, out, depth + 1);
  }
  for (const key of ['$defs', 'definitions']) {
    const v = obj[key];
    if (v && typeof v === 'object') for (const d of Object.values(v)) collectPropertyNames(d, out, depth + 1);
  }
  return out;
}

/** The JSON Schema (2020-12) clients see for a tool's input. */
export function inputJsonSchema(def: Pick<ToolDefinition, 'inputSchema'>): Record<string, unknown> {
  return z.toJSONSchema(def.inputSchema, { target: 'draft-2020-12' }) as Record<string, unknown>;
}

/**
 * The catalogue of tool definitions. Immutable after setup: it holds definitions only, never request data (T21).
 * Per-request filtering happens with `select()`; the MCP server is then built with just those tools.
 */
export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition>();
  readonly #allowNonRead: boolean;

  constructor(options: RegistryOptions = {}) {
    this.#allowNonRead = options.allowNonRead ?? false;
  }

  register(def: ToolDefinition): this {
    if (!NAME_RE.test(def.name) || def.name.length > 64) {
      throw new RegistryError(`Tool name "${def.name}" must be snake_case, at most 64 characters.`);
    }
    if (this.#tools.has(def.name)) throw new RegistryError(`Duplicate tool name "${def.name}".`);
    if (typeof def.title !== 'string' || def.title.trim() === '') {
      throw new RegistryError(`Tool "${def.name}" needs a title.`);
    }
    if (typeof def.description !== 'string' || def.description.trim().length < 20) {
      throw new RegistryError(`Tool "${def.name}" needs a real description (agents choose tools by it).`);
    }
    if (!KINDS.has(def.kind))
      throw new RegistryError(`Tool "${def.name}" has an unknown kind "${String(def.kind)}".`);
    if (def.kind !== 'read' && !this.#allowNonRead) {
      throw new RegistryError(
        `Tool "${def.name}" is "${def.kind}": non-read tools need allowNonRead (ADR-0013).`,
      );
    }
    if (typeof def.group !== 'string' || !NAME_RE.test(def.group)) {
      throw new RegistryError(`Tool "${def.name}" needs a snake_case group.`);
    }
    if (!Number.isInteger(def.cost) || def.cost < 0) {
      throw new RegistryError(
        `Tool "${def.name}" needs a cost: a non-negative integer of Agility requests (L-114).`,
      );
    }
    const secretLike = [...collectPropertyNames(inputJsonSchema(def))].filter((n) => SECRET_FIELD_RE.test(n));
    if (secretLike.length > 0) {
      throw new RegistryError(
        `Tool "${def.name}" input has secret-like field(s) ${secretLike.join(', ')}: secrets are never tool arguments (T23).`,
      );
    }
    this.#tools.set(def.name, def);
    return this;
  }

  get(name: string): ToolDefinition | undefined {
    return this.#tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.#tools.values()];
  }

  /** Tools for one caller: registered ∩ granted names ∩ enabled groups ∩ permitted kinds. */
  select(options: SelectOptions = {}): ToolDefinition[] {
    const kinds = new Set<ToolKind>(options.kinds ?? ['read']);
    const allowed = options.allowed === undefined ? undefined : new Set(options.allowed);
    const groups = options.groups === undefined ? undefined : new Set(options.groups);
    return this.list().filter(
      (t) =>
        kinds.has(t.kind) &&
        (allowed === undefined || allowed.has(t.name)) &&
        (groups === undefined || groups.has(t.group)) &&
        (options.maxCost === undefined || t.cost <= options.maxCost),
    );
  }

  /**
   * The tools the caller is granted (`allowed`, `groups`, `kinds` as in `select`) that `maxCost` hides: their declared
   * cost is above the per-call budget (P6-36, L-115). Sorted by name.
   */
  hiddenByBudget(options: SelectOptions & { readonly maxCost: number }): ToolDefinition[] {
    const { maxCost, ...rest } = options;
    return this.select(rest)
      .filter((t) => t.cost > maxCost)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}
