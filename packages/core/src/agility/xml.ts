// SPDX-License-Identifier: Apache-2.0
// The few Agility answers that are still XML (rest-1.v1 writes) go through saxes, a pure-JavaScript parser that runs on
// Workers (no DOMParser there, P0-09). Document types are refused, so no entity can be declared or expanded.
import { SaxesParser } from 'saxes';
import { AbError, ErrorCode } from '../errors.ts';

export interface XmlElement {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: XmlElement[];
  text: string;
}

const MAX_DEPTH = 64;

function unreadable(reason: string): AbError {
  return new AbError(ErrorCode.AgilityError, `Agility returned XML that could not be read (${reason}).`, {
    localDetails: true,
  });
}

export function parseXml(xml: string): XmlElement {
  const parser = new SaxesParser();
  const stack: XmlElement[] = [];
  let root: XmlElement | undefined;
  let failure: AbError | undefined;
  parser.on('doctype', () => {
    failure ??= unreadable('document types are refused');
  });
  parser.on('error', () => {
    failure ??= unreadable('malformed');
  });
  parser.on('opentag', (tag) => {
    if (stack.length >= MAX_DEPTH) {
      failure ??= unreadable('nested too deeply');
      return;
    }
    const attributes: Record<string, string> = {};
    for (const [k, v] of Object.entries(tag.attributes)) attributes[k] = String(v);
    const el: XmlElement = { name: tag.name, attributes, children: [], text: '' };
    const parent = stack.at(-1);
    if (parent === undefined) root = el;
    else parent.children.push(el);
    stack.push(el);
  });
  parser.on('text', (t) => {
    const el = stack.at(-1);
    if (el !== undefined) el.text += t;
  });
  parser.on('closetag', () => {
    stack.pop();
  });
  try {
    parser.write(xml).close();
  } catch {
    failure ??= unreadable('malformed');
  }
  if (failure !== undefined) throw failure;
  if (root === undefined) throw unreadable('empty');
  return root;
}
