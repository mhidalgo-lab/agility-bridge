// SPDX-License-Identifier: Apache-2.0
// The identifiers people use for one asset (tool conventions, `asset`): a number (`B-01234`, `S-01054`, `TK-00012`)
// or an OID token (`Story:1234`, optionally with a moment `Story:1234:5678`).
import { invalid } from '../query/limits.ts';

export type AssetRef =
  | { readonly kind: 'number'; readonly number: string; readonly prefix: string }
  | {
      readonly kind: 'oid';
      readonly oid: string;
      readonly assetType: string;
      readonly id: number;
      readonly moment?: number;
    };

const NUMBER_RE = /^([A-Za-z]{1,4})-(\d{1,9})$/;
const OID_RE = /^([A-Za-z][A-Za-z0-9_]{0,63}):(\d{1,12})(?::(\d{1,12}))?$/;

export function parseAssetRef(text: string): AssetRef {
  const s = typeof text === 'string' ? text.trim() : '';
  const n = NUMBER_RE.exec(s);
  if (n !== null) {
    const prefix = (n[1] as string).toUpperCase();
    return { kind: 'number', number: `${prefix}-${n[2]}`, prefix };
  }
  const o = OID_RE.exec(s);
  if (o !== null) {
    const [, assetType = '', id = '', moment] = o;
    return {
      kind: 'oid',
      oid: `${assetType}:${id}`,
      assetType,
      id: Number(id),
      ...(moment === undefined ? {} : { moment: Number(moment) }),
    };
  }
  throw invalid(
    `"${s.slice(0, 40)}" is not an asset number or OID token.`,
    'Use the number shown in Agility (B-01234, D-00012, TK-00007) or an OID token such as Story:1234.',
  );
}
