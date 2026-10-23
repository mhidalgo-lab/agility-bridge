// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource hono/jsx */
// Shared pieces of the P4-04 screens: paging, reading forms, the answers to admin API refusals, confirmation pages, and the
// pickers that more than one screen uses (tools, limits, asset types, projects).
import type { Context } from 'hono';
import type { Child } from 'hono/jsx';
import type { JSX } from 'hono/jsx/jsx-runtime';
import {
  Badge,
  type BadgeTone,
  Button,
  Checkbox,
  CONFIRM_FIELD,
  Form,
  Layout,
  LinkButton,
  SelectField,
  TextField,
  Time,
} from '../components.tsx';
import {
  type AdminCallResult,
  type PageContext,
  requestIdOf,
  type UiKit,
  type UiPrincipal,
  type VerifiedForm,
} from '../kit.ts';
import { errorPage, htmlResponse } from '../pages.tsx';
import type { AssetTypes, Limits, Tool } from './data.ts';

/** Rows per list page (the admin API returns whole lists; the panel pages through them). */
export const PAGE_SIZE = 25;

export const isOk = (res: AdminCallResult): boolean => res.status >= 200 && res.status < 300;

/** An admin API refusal: `{ error: { code, message, field?, detail? } }`. */
export interface ApiProblem {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly field: string | undefined;
  readonly detail: string | undefined;
}

export function problemOf(res: AdminCallResult): ApiProblem {
  const e = (res.body as { error?: Record<string, unknown> } | null)?.error ?? {};
  const s = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
  return {
    status: res.status,
    code: s(e['code']) ?? 'internal',
    message: s(e['message']) ?? 'The request failed.',
    field: s(e['field']),
    detail: s(e['detail']),
  };
}

/** The page for a load that failed: 403, 404, 429 and 503 as such, anything else 500. */
export function loadFailed(c: Context, res: AdminCallResult, viewer: UiPrincipal): Response {
  const status = [403, 404, 429, 503].includes(res.status) ? res.status : 500;
  return errorPage(status, requestIdOf(c), viewer);
}

/**
 * What a form shows above itself when the admin API refused it as invalid input (422): the API's own sentence (names
 * the field and the rule; auto-escaped, cut to 300 characters). Every other refusal is a fixed sentence: nothing else from
 * an API error body is ever shown (it can carry names or upstream text).
 */
export function formMessage(problem: ApiProblem): string {
  if (problem.status === 422 && problem.code === 'invalid_input') return problem.message.slice(0, 300);
  if (problem.status === 403) return 'Your role does not allow that. Nothing was changed.';
  if (problem.status === 404) return 'Something this form refers to no longer exists. Nothing was changed.';
  if (problem.status === 409) return 'That conflicts with the current state. Nothing was changed.';
  if (problem.status === 502 || problem.status === 503)
    return 'Agility or the storage could not be reached, so nothing was saved. Try again in a moment.';
  if (problem.status === 429) return 'Too many requests. Wait a minute and try again.';
  return 'That did not work. Try again in a moment.';
}

/** `path?k=v…` with empty values left out. */
export function withQuery(path: string, params: Readonly<Record<string, string | null | undefined>>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (typeof v === 'string' && v !== '') q.set(k, v);
  const s = q.toString();
  return s === '' ? path : `${path}?${s}`;
}

export interface Paged<T> {
  readonly rows: T[];
  readonly prev: string | null;
  readonly next: string | null;
}

/** One page of a list: `raw` is the `page` query value (anything but a positive whole number is page 1). */
export function paged<T>(
  all: readonly T[],
  raw: string | undefined,
  base: string,
  params: Readonly<Record<string, string | null | undefined>> = {},
): Paged<T> {
  const wanted = raw !== undefined && /^\d{1,6}$/.test(raw) ? Number(raw) : 1;
  const last = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const page = Math.min(Math.max(1, wanted), last);
  const at = (p: number) => withQuery(base, { ...params, page: p === 1 ? undefined : String(p) });
  return {
    rows: all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    prev: page > 1 ? at(page - 1) : null,
    next: page < last ? at(page + 1) : null,
  };
}

/** Did the person confirm (`confirm=yes`, sent only by a confirmation form)? */
export const confirmed = (form: VerifiedForm): boolean => form.fields.get(CONFIRM_FIELD) === 'yes';

/** One trimmed text field (null when absent or blank). */
export function field(form: { readonly fields: URLSearchParams }, name: string): string | null {
  const v = form.fields.get(name);
  if (v === null) return null;
  const t = v.trim();
  return t === '' ? null : t;
}

/** A whole number in `[min, max]`: undefined when blank, null when it is not one. */
export function wholeNumber(
  form: { readonly fields: URLSearchParams },
  name: string,
  min: number,
  max: number,
): number | null | undefined {
  const v = field(form, name);
  if (v === null) return undefined;
  if (!/^\d{1,13}$/.test(v)) return null;
  const n = Number(v);
  return n >= min && n <= max ? n : null;
}

/** Comma or whitespace separated words, unique, in order. */
export function words(v: string | null): string[] {
  if (v === null) return [];
  return [...new Set(v.split(/[\s,]+/).filter((w) => w !== ''))];
}

export interface ConfirmPageProps {
  readonly viewer: UiPrincipal;
  readonly current: string;
  readonly title: string;
  readonly paragraphs: readonly string[];
  readonly action: string;
  readonly confirm: string;
  readonly cancel: string;
  /** Fields to post again with the confirmation (never a secret). */
  readonly hidden?: readonly (readonly [string, string])[];
  /** Extra controls inside the form (a typed confirmation, for example). */
  readonly children?: Child;
}

/**
 * The answer to a destructive POST that came without `confirm=yes` (the row buttons of a list): what will happen, the real
 * button, a way back. Nothing has changed yet.
 */
export function confirmPage(props: ConfirmPageProps): Response {
  return htmlResponse(
    <Layout title={props.title} viewer={props.viewer} current={props.current}>
      {props.paragraphs.map((p) => (
        <p>{p}</p>
      ))}
      <Form action={props.action} csrf={props.viewer.csrf} label={props.title}>
        <input type="hidden" name={CONFIRM_FIELD} value="yes" />
        {(props.hidden ?? []).map(([name, value]) => (
          <input type="hidden" name={name} value={value} />
        ))}
        {props.children}
        <div class="actions">
          <Button variant="danger">{props.confirm}</Button>
          <LinkButton href={props.cancel} variant="secondary">
            Cancel
          </LinkButton>
        </div>
      </Form>
    </Layout>,
  );
}

/** A small button form for a row action; the next page asks for confirmation when the action is destructive. */
export function RowAction(props: {
  readonly action: string;
  readonly csrf: string;
  readonly label: string;
  /** Accessible name: says which row (`Revoke laptop`). */
  readonly name: string;
  readonly confirm?: boolean;
}): JSX.Element {
  return (
    <Form action={props.action} csrf={props.csrf}>
      {props.confirm === true ? <input type="hidden" name={CONFIRM_FIELD} value="yes" /> : null}
      <button type="submit" class="button button-secondary button-small" aria-label={props.name}>
        {props.label}
      </button>
    </Form>
  );
}

export function FormError(props: { readonly message: string | undefined }): JSX.Element | null {
  if (props.message === undefined) return null;
  return (
    <div class="flash flash-error" role="alert">
      {props.message}
    </div>
  );
}

export function Notes(props: {
  readonly title: string;
  readonly items: readonly string[];
}): JSX.Element | null {
  if (props.items.length === 0) return null;
  return (
    <section class="card notes" aria-label={props.title}>
      <h2>{props.title}</h2>
      <ul>
        {props.items.map((i) => (
          <li>{i}</li>
        ))}
      </ul>
    </section>
  );
}

/** A point in time, or a dash. */
export function When(props: { readonly at: number | null; readonly none?: string }): JSX.Element {
  return props.at === null ? <span>{props.none ?? '—'}</span> : <Time at={props.at} />;
}

export function StatusBadge(props: { readonly tone: BadgeTone; readonly text: string }): JSX.Element {
  return <Badge tone={props.tone}>{props.text}</Badge>;
}

/** Revoked, expired or active, for grants and tokens. */
export function lifecycle(
  row: { readonly revokedAt: number | null; readonly expiresAt: number | null },
  now: number,
): { tone: BadgeTone; text: string } {
  if (row.revokedAt !== null) return { tone: 'error', text: 'revoked' };
  if (row.expiresAt !== null && row.expiresAt <= now) return { tone: 'muted', text: 'expired' };
  return { tone: 'ok', text: 'active' };
}

/** Disabled or active, for instances, workspaces and users. */
export const enabledState = (disabledAt: number | null): { tone: BadgeTone; text: string } =>
  disabledAt === null ? { tone: 'ok', text: 'active' } : { tone: 'muted', text: 'disabled' };

/** Children joined with a separator (inline lists). */
export function joined(items: readonly Child[], sep = ', '): Child[] {
  return items.flatMap((item, i) => (i === 0 ? [item] : [sep, item]));
}

/** Answer a `kit.page` handler whose data could not be loaded (a null parse or a failed call). */
export const unavailable = (c: Context, page: PageContext): Response =>
  errorPage(503, requestIdOf(c), page.principal);

/** Load a list or a row through the admin API: `GET path` and the parsed body, or the failed result. */
export async function load<T>(
  kit: UiKit,
  c: Context,
  principal: UiPrincipal,
  path: string,
  parse: (body: unknown) => T | null,
  query?: Readonly<Record<string, string>>,
): Promise<
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly result: AdminCallResult }
> {
  const result = await kit.callAdmin(c, principal, {
    method: 'GET',
    path,
    ...(query === undefined ? {} : { query }),
  });
  const value = isOk(result) ? parse(result.body) : null;
  return value === null ? { ok: false, result } : { ok: true, value };
}

// ---------------------------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------------------------

const KIND_TONE: Readonly<Record<Tool['kind'], BadgeTone>> = {
  read: 'ok',
  write: 'error',
  destructive: 'error',
};

/** Tools grouped by catalogue group, groups and tools in name order. */
export function toolGroups(tools: readonly Tool[]): [string, Tool[]][] {
  const groups = new Map<string, Tool[]>();
  for (const t of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
    const list = groups.get(t.group) ?? [];
    list.push(t);
    groups.set(t.group, list);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export interface ToolChecklistProps {
  readonly tools: readonly Tool[];
  /** The form's values (`tools_all`, `tools`). */
  readonly values: URLSearchParams;
  readonly legend: string;
  readonly allLabel: string;
  readonly allHint: string;
  /** May the viewer tick write tools? (Owners only; the API checks again.) */
  readonly writesAllowed: boolean;
  readonly error?: string | undefined;
}

/**
 * The tools checklist: one "all" box, then the tools by group with a kind badge. Write and destructive tools are never
 * part of "all" and are offered to owners only. Field names: `tools_all` and `tools` (repeated); read them back with
 * {@link toolsFrom}.
 */
export function ToolChecklist(props: ToolChecklistProps): JSX.Element {
  const selected = new Set(props.values.getAll('tools'));
  const offered = props.tools.filter((t) => props.writesAllowed || t.kind === 'read');
  const hiddenWrites = props.tools.length - offered.length;
  return (
    <fieldset class="field" aria-describedby={props.error ? 'tools-error' : undefined}>
      <legend>{props.legend}</legend>
      {props.error ? (
        <p class="error" id="tools-error">
          {props.error}
        </p>
      ) : null}
      <Checkbox
        name="tools_all"
        id="tools-all"
        label={props.allLabel}
        hint={props.allHint}
        checked={props.values.has('tools_all')}
      />
      {hiddenWrites > 0 ? (
        <p class="hint">Write tools are not offered to you: only an owner can enable them.</p>
      ) : props.tools.some((t) => t.kind !== 'read') ? (
        <p class="hint">
          Write tools change Agility. They are never part of "all": tick each one you want. Enabling one needs
          a recent sign-in.
        </p>
      ) : null}
      {offered.length === 0 ? (
        <p class="hint">No tool list is available here: choose all tools.</p>
      ) : (
        toolGroups(offered).map(([group, tools]) => (
          <fieldset class="tool-group">
            <legend>{group}</legend>
            {tools.map((t) => (
              <Checkbox
                name="tools"
                id={`tool-${t.name}`}
                value={t.name}
                checked={selected.has(t.name)}
                label={
                  <>
                    <code>{t.name}</code> <Badge tone={KIND_TONE[t.kind]}>{t.kind}</Badge>
                  </>
                }
              />
            ))}
          </fieldset>
        ))
      )}
    </fieldset>
  );
}

/** The `tools` form values that describe a stored list: "all" for null, else each name ticked. */
export function toolValues(list: readonly string[] | null, into: URLSearchParams): void {
  if (list === null) into.set('tools_all', '1');
  else for (const name of list) into.append('tools', name);
}

/**
 * The tools a checklist posted: null for "all", a list, or an error message. "All" plus ticked write tools becomes the
 * explicit list of every read tool and those write tools (write tools are never implied by "all").
 */
export function toolsFrom(
  form: { readonly fields: URLSearchParams },
  tools: readonly Tool[],
): { value: string[] | null } | { error: string } {
  const ticked = [...new Set(form.fields.getAll('tools'))].filter((n) => /^[a-z0-9_]{1,64}$/.test(n));
  if (form.fields.has('tools_all')) {
    const writes = ticked.filter((n) => tools.some((t) => t.name === n && t.kind !== 'read'));
    if (writes.length === 0) return { value: null };
    return { value: [...tools.filter((t) => t.kind === 'read').map((t) => t.name), ...writes] };
  }
  if (ticked.length === 0) return { error: 'Choose at least one tool, or all tools.' };
  return { value: ticked };
}

/** Does this stored list contain a write or destructive tool (one the viewer may not be able to keep)? */
export const hasWriteTools = (list: readonly string[] | null, tools: readonly Tool[]): boolean =>
  (list ?? []).some((n) => tools.some((t) => t.name === n && t.kind !== 'read'));

// ---------------------------------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------------------------------

/** The numeric limits of a policy with their hard bounds (`limitsPolicySchema`); the API validates again. */
export const LIMIT_NUMBERS = [
  ['defaultRows', 'Rows per query by default', 1, 1_000],
  ['maxRows', 'Most rows per query', 1, 1_000],
  ['maxFields', 'Most fields per row', 1, 200],
  ['maxNestingDepth', 'Deepest attribute path', 0, 5],
  ['maxAggregations', 'Most aggregations per query', 0, 50],
  ['maxAnyOfGroups', 'Most "any of" groups per query', 0, 20],
  ['maxResponseBytes', 'Largest response (bytes)', 65_536, 67_108_864],
  ['maxAsOfAgeDays', 'Furthest AsOf into the past (days)', 0, 3_650],
  ['maxTimeRangeDays', 'Longest time range (days)', 1, 3_660],
  ['callBudget', 'Agility requests per tool call', 1, 10_000],
] as const;

export const LIMIT_SWITCHES = [
  ['memberEmails', 'Member emails in output'],
  ['genericQuery', 'The generic query tools (query_assets, get_assets)'],
] as const;

/** Form values for stored limits (`limit_<name>`). */
export function limitValues(limits: Limits, into: URLSearchParams): void {
  for (const [name] of LIMIT_NUMBERS) {
    const v = limits[name];
    if (typeof v === 'number') into.set(`limit_${name}`, String(v));
  }
  for (const [name] of LIMIT_SWITCHES) {
    const v = limits[name];
    if (typeof v === 'boolean') into.set(`limit_${name}`, v ? 'on' : 'off');
  }
}

/** The limit fields (blank = inherit: the deployment default, or for a grant the workspace's). */
export function LimitsFields(props: {
  readonly values: URLSearchParams;
  readonly errors: Readonly<Record<string, string>>;
  readonly hint: string;
}): JSX.Element {
  return (
    <fieldset class="field">
      <legend>Limits</legend>
      <p class="hint">{props.hint}</p>
      {LIMIT_NUMBERS.map(([name, label, min, max]) => (
        <TextField
          name={`limit_${name}`}
          label={label}
          hint={`${min} to ${max}.`}
          type="number"
          inputmode="numeric"
          min={min}
          max={max}
          value={props.values.get(`limit_${name}`) ?? ''}
          error={props.errors[`limit_${name}`]}
        />
      ))}
      {LIMIT_SWITCHES.map(([name, label]) => (
        <SelectField
          name={`limit_${name}`}
          label={label}
          value={props.values.get(`limit_${name}`) ?? ''}
          error={props.errors[`limit_${name}`]}
          options={[
            { value: '', label: 'Inherit' },
            { value: 'on', label: 'On' },
            { value: 'off', label: 'Off' },
          ]}
        />
      ))}
    </fieldset>
  );
}

/** Limits from {@link LimitsFields}, or field errors. */
export function limitsFrom(form: {
  readonly fields: URLSearchParams;
}): { limits: Record<string, number | boolean> } | { errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const out: Record<string, number | boolean> = {};
  for (const [name, , min, max] of LIMIT_NUMBERS) {
    const n = wholeNumber(form, `limit_${name}`, min, max);
    if (n === null)
      errors[`limit_${name}`] = `Enter a whole number from ${min} to ${max}, or leave it blank.`;
    else if (n !== undefined) out[name] = n;
  }
  for (const [name] of LIMIT_SWITCHES) {
    const v = form.fields.get(`limit_${name}`) ?? '';
    if (v === 'on') out[name] = true;
    else if (v === 'off') out[name] = false;
    else if (v !== '') errors[`limit_${name}`] = 'Choose one of the options.';
  }
  return Object.keys(errors).length > 0 ? { errors } : { limits: out };
}

/** The form field an admin API `field` path (`limits.maxRows`) belongs to, when it names a limit. */
export function limitFieldOf(apiField: string | undefined): string | undefined {
  if (apiField === undefined) return undefined;
  const m = /^(?:workspace\.)?limits\.([A-Za-z]+)/.exec(apiField);
  return m?.[1] === undefined ? undefined : `limit_${m[1]}`;
}

/** One line per limit that is set, for detail pages. */
export function limitsSummary(l: Limits): string[] {
  const out: string[] = [];
  for (const [name, label] of LIMIT_NUMBERS) {
    const v = l[name];
    if (typeof v === 'number') out.push(`${label}: ${v}`);
  }
  for (const [name, label] of LIMIT_SWITCHES) {
    const v = l[name];
    if (typeof v === 'boolean') out.push(`${label}: ${v ? 'on' : 'off'}`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Asset types
// ---------------------------------------------------------------------------------------------------------------

export function assetTypeValues(types: AssetTypes | null, into: URLSearchParams): void {
  if (types?.allow) into.set('types_allow', types.allow.join(', '));
  if (types?.deny) into.set('types_deny', types.deny.join(', '));
}

export function AssetTypeFields(props: {
  readonly values: URLSearchParams;
  readonly errors: Readonly<Record<string, string>>;
}): JSX.Element {
  return (
    <fieldset class="field">
      <legend>Asset types</legend>
      <TextField
        name="types_allow"
        label="Only these asset types"
        hint="Comma-separated Agility type names (Story, Defect). Blank: every type."
        value={props.values.get('types_allow') ?? ''}
        maxlength={4000}
        spellcheck={false}
        error={props.errors['types_allow']}
      />
      <TextField
        name="types_deny"
        label="Never these asset types"
        hint="Comma-separated. Blank: none."
        value={props.values.get('types_deny') ?? ''}
        maxlength={4000}
        spellcheck={false}
        error={props.errors['types_deny']}
      />
    </fieldset>
  );
}

const TYPE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** `null` when neither list is set (no policy), the policy object, or field errors. */
export function assetTypesFrom(form: {
  readonly fields: URLSearchParams;
}): { value: { allow?: string[]; deny?: string[] } | null } | { errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  for (const [key, name] of [
    ['allow', 'types_allow'],
    ['deny', 'types_deny'],
  ] as const) {
    const list = words(field(form, name));
    if (list.length > 500 || list.some((t) => !TYPE_NAME.test(t)))
      errors[name] = 'Use up to 500 Agility type names (letters, digits and _), separated by commas.';
    else if (list.length > 0) lists[key] = list;
  }
  if (Object.keys(errors).length > 0) return { errors };
  return { value: Object.keys(lists).length === 0 ? null : lists };
}

/** Where an admin API `field` path (`assetTypes.allow.0`) is shown. */
export function typesFieldOf(apiField: string | undefined): string | undefined {
  if (apiField === undefined || !apiField.startsWith('assetTypes')) return undefined;
  return apiField.includes('deny') ? 'types_deny' : 'types_allow';
}

// ---------------------------------------------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------------------------------------------

/** Text for a person in a list: the name when there is one, else the email. Only ever rendered as text. */
export const personText = (u: { readonly email: string; readonly displayName: string | null }): string =>
  u.displayName === null || u.displayName === '' ? u.email : `${u.displayName} (${u.email})`;

/** Is the viewer an owner? */
export const isOwner = (viewer: UiPrincipal): boolean => viewer.role === 'owner';

/** The `Layout` of a screen with a flash, a title and the current menu entry. */
export function Screen(props: {
  readonly page: PageContext;
  readonly title: string;
  readonly current: string;
  readonly children?: Child;
}): JSX.Element {
  return (
    <Layout
      title={props.title}
      viewer={props.page.principal}
      current={props.current}
      flash={props.page.flash}
    >
      {props.children}
    </Layout>
  );
}

/**
 * Where a refusal is shown: next to its field when the API named one the form has (`fieldOf` maps the API's field path
 * to a form field), else above the form as a fixed or validation sentence.
 */
export function formErrors(
  problem: ApiProblem,
  fieldOf: (apiField: string | undefined) => string | undefined,
): { readonly errors: Record<string, string>; readonly message: string | undefined } {
  const target = problem.status === 422 ? fieldOf(problem.field) : undefined;
  return target === undefined
    ? { errors: {}, message: formMessage(problem) }
    : { errors: { [target]: formMessage(problem) }, message: undefined };
}
