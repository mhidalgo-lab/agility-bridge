// SPDX-License-Identifier: Apache-2.0
// The wave-2 part of the write fake (P7-05): a create of Story, Defect, Task, Test or Epic through `rest-1.v1/Data/<Type>`
// and the documented attribute and relation sets on an existing item. It lives apart from `writes-world.ts` so the
// two waves do not edit the same function. The request shapes are the documented ones and stay *unverified* (P7-07).
import type { XmlElement } from '../../src/index.ts';

type Mutable = Record<string, unknown>;

const NUMBER_PREFIX: Record<string, string> = { Story: 'B', Defect: 'D', Task: 'TK', Test: 'TS', Epic: 'E' };
const ITEM_TYPES = new Set(Object.keys(NUMBER_PREFIX));

export interface Wave2Env {
  readonly assets: Record<string, Mutable[]>;
  readonly find: (oid: string) => Mutable | undefined;
  readonly nextId: () => number;
  /** The fake's "now" for `CreateDateUTC`. */
  readonly now: string;
}

const attr = (root: XmlElement, name: string): string | undefined =>
  root.children.find((c) => c.name === 'Attribute' && c.attributes['name'] === name)?.text;
const rel = (root: XmlElement, name: string): string | undefined =>
  root.children.find((c) => c.name === 'Relation' && c.attributes['name'] === name)?.children[0]?.attributes[
    'idref'
  ] as string | undefined;

/** Applies a create of a work item; returns the moment-form OID, or undefined when the type is not one of wave 2. */
export function createItem(env: Wave2Env, type: string, root: XmlElement): string | undefined {
  if (!ITEM_TYPES.has(type)) return undefined;
  const id = env.nextId();
  const oid = `${type}:${id}`;
  const scopeOid = rel(root, 'Scope');
  const scope = scopeOid === undefined ? undefined : env.find(scopeOid);
  const row: Mutable = {
    _oid: oid,
    AssetType: type,
    Number: `${NUMBER_PREFIX[type]}-0${id}`,
    Name: attr(root, 'Name') ?? '',
    AssetState: 64,
    Scope: scopeOid,
    'Scope.Name': scope?.['Name'],
    CreatedBy: 'Member:20',
    CreateDateUTC: env.now,
    ChangeDateUTC: env.now,
  };
  const description = attr(root, 'Description');
  if (description !== undefined) row['Description'] = description;
  for (const n of ['Estimate', 'DetailEstimate']) {
    const v = attr(root, n);
    if (v !== undefined) row[n] = Number(v);
  }
  for (const n of ['Priority', 'Super', 'Parent']) {
    const ref = rel(root, n);
    if (ref !== undefined) {
      row[n] = ref;
      row[`${n}.Name`] = env.find(ref)?.['Name'];
    }
  }
  const into = (name: string): Mutable[] => {
    const list = env.assets[name] ?? [];
    env.assets[name] = list;
    return list;
  };
  into(type).push(row);
  into('Workitem').push(row);
  if (type === 'Story' || type === 'Defect') into('PrimaryWorkitem').push(row);
  return `${oid}:1`;
}

/** Applies Name, Description, Estimate, DetailEstimate and Priority sets to an existing item; true when it handled them. */
export function updateItem(env: Wave2Env, row: Mutable, root: XmlElement): boolean {
  let handled = false;
  for (const child of root.children) {
    const name = child.attributes['name'] as string;
    if (
      child.name === 'Attribute' &&
      ['Name', 'Description', 'Estimate', 'DetailEstimate', 'ToDo'].includes(name)
    ) {
      row[name] = ['Estimate', 'DetailEstimate', 'ToDo'].includes(name)
        ? Number(child.text)
        : (child.text ?? '');
      handled = true;
    } else if (child.name === 'Attribute' && name.startsWith('Custom_')) {
      // A custom attribute (P7-20): numeric ones are named so in the test metadata, the rest are text.
      row[name] = name === 'Custom_SyntheticHours' ? Number(child.text) : (child.text ?? '');
      handled = true;
    } else if (child.name === 'Relation' && name === 'Priority' && child.attributes['act'] === 'set') {
      const ref = child.children[0]?.attributes['idref'] as string;
      row['Priority'] = ref;
      row['Priority.Name'] = env.find(ref)?.['Name'];
      handled = true;
    }
  }
  return handled;
}
