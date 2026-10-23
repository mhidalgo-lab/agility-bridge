// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource hono/jsx */
// Components and pages (P4-03, THREAT_MODEL T13): hostile strings render inert everywhere, links cannot leave the origin,
// and a page carries nothing inline. DOM-free: the assertions look at the rendered markup's structure, not at a parser.
import { describe, expect, it } from 'vitest';
import {
  Badge,
  Button,
  Checkbox,
  ConfirmAction,
  CSRF_FIELD,
  DataTable,
  Facts,
  Flash,
  Form,
  Layout,
  LinkButton,
  localHref,
  NAV_ITEMS,
  QueryForm,
  SelectField,
  SignOut,
  TextField,
  Time,
  type UiViewer,
} from '../src/components.tsx';
import { errorPage, LoginPage, MessagePage, reauthPage, renderDocument, SetupPage } from '../src/pages.tsx';

/** Strings that break out of text, attributes, scripts and URLs if anything renders them raw. */
const HOSTILE = [
  '<script>alert(1)</script>',
  '"><img src=x onerror=alert(1)>',
  "' onmouseover='alert(1)",
  '</title><script>alert(1)</script>',
  '<svg/onload=alert(1)>',
  '&lt;script&gt;',
  'javascript:alert(1)',
  '${7*7}{{7*7}}',
  ' <b>',
];

const viewer = (over: Partial<UiViewer> = {}): UiViewer => ({
  email: 'user@example.test',
  displayName: null,
  role: 'owner',
  csrf: 'csrf-token-value',
  recentAuth: true,
  ...over,
});

/** Every tag the markup opens, as `<name attrs>`, so tests can reason about attributes without a parser. */
const tags = (html: string): string[] => html.match(/<[a-zA-Z][^>]*>/g) ?? [];

/** What no page may ever contain, however its data looks. */
function expectInert(html: string): void {
  // No inline script body, no inline style, no event handler attribute, no javascript: URL in an attribute.
  expect(html).not.toMatch(/<script[^>]*>[^<]/i);
  expect(html).not.toMatch(/<style/i);
  for (const tag of tags(html)) {
    // Attribute values are double-quoted with quotes escaped, so blanking them leaves only the attribute names.
    const names = tag.replace(/"[^"]*"/g, '""');
    expect(names, tag).not.toMatch(/\sstyle\s*=/i);
    expect(names, tag).not.toMatch(/\son[a-z]+\s*=/i);
    for (const m of tag.matchAll(/\s(?:href|src|action)="([^"]*)"/g)) {
      expect(m[1], tag).not.toMatch(/^\s*javascript:/i);
    }
  }
  // Only the panel's own two assets are ever loaded.
  const loaded = tags(html).filter((t) => /^<(script|link|img|iframe|object|embed)\b/i.test(t));
  for (const tag of loaded)
    expect(tag, tag).toMatch(/(?:src|href)="\/admin\/assets\/admin\.[0-9a-f]{16}\.(?:css|js)"/);
}

describe('hostile strings', () => {
  it.each(HOSTILE)('are escaped by every component: %s', (evil) => {
    const html = renderDocument(
      <Layout
        title={evil}
        viewer={viewer({ email: evil, displayName: evil, csrf: evil })}
        current="/admin"
        flash={{ kind: 'error', text: evil }}
      >
        <TextField name="a" label={evil} hint={evil} error={evil} value={evil} />
        <SelectField name="s" label={evil} options={[{ value: evil, label: evil }]} value={evil} />
        <Checkbox name="c" label={evil} value={evil} hint={evil} />
        <Facts items={[[evil, evil]]} />
        <DataTable
          caption={evil}
          empty={evil}
          columns={[{ header: evil, cell: (r: string) => r }]}
          rows={[evil]}
        />
        <Badge tone="ok">{evil}</Badge>
        <Button>{evil}</Button>
        <ConfirmAction action="/admin/x" csrf={evil} summary={evil} confirm={evil} />
        <QueryForm action="/admin/x" label={evil}>
          <TextField name="q" label={evil} />
        </QueryForm>
        <MessagePage
          title={evil}
          paragraphs={[evil]}
          requestId={evil}
          link={{ href: '/admin', label: evil }}
        />
      </Layout>,
    );
    expectInert(html);
    // The raw string never appears where markup is parsed: either escaped, or inside an attribute value that cannot
    // be closed (quotes escaped).
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<svg/onload');
    expect(html).not.toContain('"><img');
    expect(html).not.toContain("' onmouseover=");
  });

  it('are escaped on the sign-in, setup and message pages (provider labels are operator configuration)', () => {
    for (const evil of HOSTILE) {
      const login = renderDocument(<LoginPage providers={[{ href: '/auth/login/x', label: evil }]} />);
      const setup = renderDocument(<SetupPage providers={[{ id: evil, label: evil }]} />);
      for (const html of [login, setup]) {
        expectInert(html);
        expect(html).not.toContain('<script>alert');
        expect(html).not.toContain('<img src=x');
      }
    }
  });

  it('keeps ampersands and quotes as entities', () => {
    const html = renderDocument(
      <Layout title="a & b" viewer={viewer({ email: 'x"y@example.test' })}>
        <p>{`<b>"'&`}</p>
      </Layout>,
    );
    expect(html).toContain('<h1>a &amp; b</h1>');
    expect(html).toContain('&lt;b&gt;&quot;&#39;&amp;');
    expect(html).toContain('x&quot;y@example.test');
  });
});

describe('links', () => {
  it.each([
    'javascript:alert(1)',
    'https://evil.example/x',
    '//evil.example',
    '/\\evil.example',
    'admin',
    '/admin x',
    '/admin\n',
    '',
    '/ünï',
  ])('localHref refuses %j', (path) => {
    expect(() => localHref(path)).toThrow(TypeError);
  });

  it('localHref passes same-origin paths with a query', () => {
    expect(localHref('/admin/account?x=1&y=2')).toBe('/admin/account?x=1&y=2');
  });

  it('components throw instead of rendering an off-site link or form action', () => {
    expect(() => renderDocument(<LinkButton href="https://evil.example">x</LinkButton>)).toThrow();
    expect(() => renderDocument(<Form action="//evil.example" csrf="t" />)).toThrow();
    expect(() => renderDocument(<QueryForm action="javascript:1" label="x" />)).toThrow();
    expect(() =>
      renderDocument(<MessagePage title="t" paragraphs={[]} link={{ href: 'http://x', label: 'l' }} />),
    ).toThrow();
    expect(() => reauthPage(viewer(), 'https://evil.example', undefined)).toThrow();
  });
});

describe('the page frame', () => {
  const html = renderDocument(
    <Layout title="Overview" viewer={viewer()} current="/admin/account">
      <p>content</p>
    </Layout>,
  );

  it('has the landmarks and the skip link', () => {
    expect(html.startsWith('<!doctype html><html lang="en">')).toBe(true);
    expect(html).toContain('<a class="skip-link" href="#main">');
    expect(html).toMatch(/<header class="site-header">/);
    expect(html).toMatch(/<nav class="nav" aria-label="Main">/);
    expect(html).toMatch(/<main id="main" tabindex="-1">/);
    expect(html).toMatch(/<footer class="site-footer">/);
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1"/>');
    expect(html).toContain('<meta name="robots" content="noindex, nofollow"/>');
    expect((html.match(/<h1>/g) ?? []).length).toBe(1);
  });

  it('marks the current page and only that one', () => {
    const current = tags(html).filter((t) => t.includes('aria-current="page"'));
    expect(current).toHaveLength(1);
    expect(current[0]).toContain('href="/admin/account"');
  });

  it('loads one stylesheet and one script, same origin, with SRI', () => {
    expectInert(html);
    const link = tags(html).filter((t) => t.startsWith('<link'));
    const script = tags(html).filter((t) => t.startsWith('<script'));
    expect(link).toHaveLength(1);
    expect(script).toHaveLength(1);
    for (const t of [...link, ...script]) expect(t).toMatch(/integrity="sha384-[A-Za-z0-9+/]+=*"/);
  });

  it('shows navigation entries by role', () => {
    const memberNav = renderDocument(<Layout title="t" viewer={viewer({ role: 'member' })} />);
    const ownerNav = renderDocument(<Layout title="t" viewer={viewer({ role: 'owner' })} />);
    for (const item of NAV_ITEMS) {
      expect(ownerNav).toContain(`href="${item.href}"`);
      expect(memberNav.includes(`href="${item.href}"`)).toBe(item.minRole === 'member');
    }
  });

  it('shows no navigation or sign-out to a stranger', () => {
    const anon = renderDocument(<Layout title="Sign in" />);
    expect(anon).not.toContain('<nav');
    expect(anon).not.toContain('/auth/logout');
    expect(anon).toContain('href="/auth/login"');
  });
});

describe('forms', () => {
  it('Form always carries the CSRF field, posts urlencoded and has a same-origin action', () => {
    const html = renderDocument(
      <Form action="/admin/x" csrf="tok-1" label="Thing">
        <Button>Go</Button>
      </Form>,
    );
    expect(html).toContain('<form method="post" action="/admin/x" aria-label="Thing">');
    expect(html).toContain(`<input type="hidden" name="${CSRF_FIELD}" value="tok-1"/>`);
    expect(html).not.toContain('enctype');
  });

  it('every POST form of the layout and the confirm disclosure has the token; GET forms have none', () => {
    const html = renderDocument(
      <Layout title="t" viewer={viewer({ csrf: 'tok-2' })}>
        <ConfirmAction action="/admin/y" csrf="tok-2" summary="s" confirm="c" />
        <QueryForm action="/admin/z" label="Filter" />
        <SignOut viewer={viewer({ csrf: 'tok-2' })} everywhere />
      </Layout>,
    );
    const forms = html.match(/<form [^>]*>[\s\S]*?<\/form>/g) ?? [];
    expect(forms.length).toBeGreaterThanOrEqual(4);
    for (const f of forms) {
      if (f.includes('method="post"')) expect(f, f).toContain(`name="${CSRF_FIELD}" value="tok-2"`);
      else expect(f, f).not.toContain(CSRF_FIELD);
    }
  });

  it('ties hints and errors to the control and marks it invalid', () => {
    const html = renderDocument(<TextField name="n" label="Name" hint="h" error="e" required />);
    expect(html).toContain('<label for="n">Name</label>');
    expect(html).toContain('aria-describedby="n-hint n-error"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('id="n-error"');
  });

  it('ConfirmAction shows nothing destructive before the disclosure is opened', () => {
    const html = renderDocument(
      <ConfirmAction action="/admin/y" csrf="t" summary="Delete" confirm="Delete it" />,
    );
    expect(html).toMatch(/^<!doctype html><details class="confirm"><summary>Delete<\/summary>/);
    expect(html).toContain('name="confirm" value="yes"');
  });
});

describe('flash, time and tables', () => {
  it('uses alert for errors and status for the rest', () => {
    expect(renderDocument(<Flash message={{ kind: 'error', text: 'x' }} />)).toContain('role="alert"');
    expect(renderDocument(<Flash message={{ kind: 'success', text: 'x' }} />)).toContain('role="status"');
  });

  it('prints UTC times with a machine-readable datetime', () => {
    expect(renderDocument(<Time at={Date.UTC(2026, 9, 21, 12, 5, 59)} />)).toBe(
      '<!doctype html><time datetime="2026-10-21T12:05:59.000Z">2026-10-21 12:05 UTC</time>',
    );
  });

  it('tables have a caption, scoped headers, and an empty row that spans the columns', () => {
    const html = renderDocument(
      <DataTable
        caption="People"
        empty="Nobody."
        rows={[] as string[]}
        columns={[
          { header: 'A', cell: (r) => r },
          { header: 'B', cell: (r) => r },
        ]}
      />,
    );
    expect(html).toContain('<caption>People</caption>');
    expect((html.match(/<th scope="col">/g) ?? []).length).toBe(2);
    expect(html).toContain('<td class="empty" colspan="2">Nobody.</td>');
  });
});

describe('error and re-authentication pages', () => {
  it('error pages show fixed text and the request id, never a message', async () => {
    for (const status of [403, 404, 413, 415, 429, 500, 503, 418]) {
      const res = errorPage(status, 'req-123');
      const html = await res.text();
      expect(res.status).toBe(status);
      expect(html).toContain('req-123');
      expect(html).not.toMatch(/stack|Error:|at \w+ \(/);
      expectInert(html);
    }
  });

  it('the re-authentication page links to /auth/reauth with the page to return to, encoded', async () => {
    const res = reauthPage(viewer(), '/admin/account?a=1&b=2', 'req-9');
    const html = await res.text();
    expect(res.status).toBe(403);
    expect(html).toContain('href="/auth/reauth?next=%2Fadmin%2Faccount%3Fa%3D1%26b%3D2"');
    expect(html).toContain('Nothing was changed');
  });
});
