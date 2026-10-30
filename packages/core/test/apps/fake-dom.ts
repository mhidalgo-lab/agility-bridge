// SPDX-License-Identifier: Apache-2.0
// A minimal DOM for running the MCP Apps view script in a test (no browser, no jsdom). It implements only what the
// script may use, and records every place text or an attribute value can end up, so a test can prove that a hostile
// label only ever became `textContent`. Anything else the script touches throws: that is the allowlist of its API.
export class FakeNode {
  readonly children: FakeNode[] = [];
  readonly attrs: Map<string, string> = new Map<string, string>();
  parent: FakeNode | null = null;
  #text = '';
  readonly tag: string;
  readonly ns: string | null;
  constructor(tag: string, ns: string | null = null) {
    this.tag = tag;
    this.ns = ns;
  }
  get firstChild(): FakeNode | null {
    return this.children[0] ?? null;
  }
  set textContent(value: string) {
    this.children.length = 0;
    this.#text = String(value);
  }
  get own(): string {
    return this.#text;
  }
  get textContent(): string {
    return this.#text + this.children.map((c) => c.textContent).join('');
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  appendChild(child: FakeNode): FakeNode {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  removeChild(child: FakeNode): FakeNode {
    this.children.splice(this.children.indexOf(child), 1);
    return child;
  }
  *walk(): Generator<FakeNode> {
    yield this;
    for (const c of this.children) yield* c.walk();
  }
}

class TextNode extends FakeNode {
  constructor(text: string) {
    super('#text');
    this.textContent = text;
  }
}

export interface Sent {
  readonly message: Record<string, unknown>;
  readonly target: string;
}

export interface ViewRun {
  readonly root: FakeNode;
  readonly sent: Sent[];
  /** Deliver a message to the page as the host would (from `window.parent`). */
  hostSends(message: unknown): void;
  /** Deliver a message from another source (it must be ignored). */
  strangerSends(message: unknown): void;
}

/** Runs `script` against a page whose `<html data-view>` is `view`. */
export function runView(script: string, view: string): ViewRun {
  const root = new FakeNode('div');
  const html = new FakeNode('html');
  html.setAttribute('data-view', view);
  Object.defineProperty(html, 'scrollWidth', { value: 520 });
  Object.defineProperty(html, 'scrollHeight', { value: 300 });
  const sent: Sent[] = [];
  const handlers: Array<(e: { source: unknown; data: unknown }) => void> = [];
  const parent = {};
  const document = {
    documentElement: html,
    getElementById: (id: string) => (id === 'root' ? root : null),
    createElement: (tag: string) => new FakeNode(tag),
    createElementNS: (ns: string, tag: string) => new FakeNode(tag, ns),
    createTextNode: (text: string) => new TextNode(text),
  };
  const window = {
    parent: {
      postMessage: (message: Record<string, unknown>, target: string) => sent.push({ message, target }),
    },
    addEventListener: (type: string, fn: (e: { source: unknown; data: unknown }) => void) => {
      if (type !== 'message') throw new Error(`unexpected listener ${type}`);
      handlers.push(fn);
    },
  };
  // The page's `window.parent` is the host: `e.source` is compared to it.
  // The script sees `document` and `window` and the language's built-ins; anything else it reaches for does not exist.
  new Function('document', 'window', script)(document, window);
  return {
    root,
    sent,
    hostSends: (data) => {
      for (const h of handlers) h({ source: window.parent, data });
    },
    strangerSends: (data) => {
      for (const h of handlers) h({ source: parent, data });
    },
  };
}

/** Every text and attribute value in the tree, for "this string appears only as text" assertions. */
export function inventory(root: FakeNode): { texts: string[]; attributes: string[]; tags: string[] } {
  const texts: string[] = [];
  const attributes: string[] = [];
  const tags: string[] = [];
  for (const n of root.walk()) {
    tags.push(n.tag);
    if (n.own !== '') texts.push(n.own);
    for (const v of n.attrs.values()) attributes.push(v);
  }
  return { texts, attributes, tags };
}
