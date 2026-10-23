// SPDX-License-Identifier: Apache-2.0
import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page } from '@playwright/test';
import type { TestServer } from './server.ts';

/** A page whose layout fits the viewport: nothing wider than the screen (the 320 px promise, WCAG reflow). */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const { overflow, culprits } = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    // Elements that reach past the viewport and are not inside a box that scrolls on its own (those are fine), the
    // innermost ones first, so a failure names what to fix.
    const scrolls = (e: Element): boolean =>
      ['auto', 'scroll', 'hidden'].includes(getComputedStyle(e).overflowX);
    const clipped = (e: Element): boolean => {
      for (let a = e.parentElement; a !== null && a !== document.body; a = a.parentElement)
        if (scrolls(a)) return true;
      return false;
    };
    const wide = [...document.body.querySelectorAll('*')].filter(
      (e) => e.getBoundingClientRect().right > width + 0.5 && !clipped(e),
    );
    const innermost = wide.filter((e) => !wide.some((o) => o !== e && e.contains(o)));
    // Text that runs past its box (a long unbreakable word) is not an element: look at text nodes too.
    const texts: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n !== null && texts.length < 5; n = walker.nextNode()) {
      const parent = n.parentElement;
      if (parent === null || clipped(parent) || scrolls(parent)) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      if (range.getBoundingClientRect().right > width + 0.5) {
        texts.push(`text "${(n.textContent ?? '').trim().slice(0, 40)}" in ${parent.tagName.toLowerCase()}`);
      }
    }
    const name = (e: Element): string =>
      `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}${e.className ? `.${String(e.className).split(' ').join('.')}` : ''}`;
    return {
      overflow: document.documentElement.scrollWidth - width,
      culprits: [
        ...texts,
        ...innermost
          .slice(0, 5)
          .map(
            (e) =>
              `${name(e)} in ${e.parentElement ? name(e.parentElement) : '?'} (right ${Math.round(e.getBoundingClientRect().right)} > ${width})`,
          ),
      ],
    };
  });
  expect(overflow, `horizontal overflow on ${page.url()}: ${culprits.join('; ')}`).toBeLessThanOrEqual(0);
}

/**
 * WCAG 2.1 A and AA rules as a real browser lays the page out (contrast, names, labels, landmarks, targets): no
 * violation, in the current colour scheme. jsdom cannot do this (P4-03 deferred it to this task).
 */
export async function expectAccessible(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const summary = result.violations.map(
    (v) => `${v.id} (${v.impact}): ${v.help}\n${v.nodes.map((n) => `    ${n.target.join(' ')}`).join('\n')}`,
  );
  expect(summary, `accessibility violations on ${page.url()}`).toEqual([]);
}

/** Opens a panel page (a path or a full address); checks it fits the viewport and has no accessibility violation. */
export async function visit(page: Page, server: TestServer, path: string): Promise<void> {
  await page.goto(path.startsWith('/') ? `${server.base}${path}` : path);
  await expectNoHorizontalScroll(page);
  await expectAccessible(page);
}

/** Chooses the option whose text matches (option texts carry suffixes and ids). */
export async function pick(select: Locator, text: RegExp): Promise<void> {
  const options = await select.locator('option').allInnerTexts();
  const hit = options.find((o) => text.test(o));
  if (hit === undefined) throw new Error(`no option matches ${text}: ${options.join(' | ')}`);
  await select.selectOption({ label: hit });
}

/** Signs in from the login page with the identity provider's current user. */
export async function signIn(page: Page, server: TestServer): Promise<void> {
  await page.goto(`${server.base}/auth/login`);
  await page.getByRole('link', { name: 'Continue with Corp SSO' }).click();
  await expect(page).toHaveURL(`${server.base}/admin`);
}
