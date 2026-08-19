import { test, expect } from '@playwright/test';
import { openScene, runScene } from './support/harness.js';

/**
 * The fill dialect through the public `__eraser` API: substitution, conditionals, loops,
 * composition, icon slots — and the two hardening contracts (pre-escaped content stays inert,
 * lookup never walks the prototype chain).
 */

const ICONS = {
  db: '<svg viewBox="0 0 10 10"><rect width="10" height="10"></rect></svg>',
};

test('run before setup throws', async ({ page }) => {
  await openScene(page);

  await expect(
    page.evaluate(() => window.__eraser.run({ entities: [], connections: [], icons: {} })),
  ).rejects.toThrow('__eraser.run before __eraser.setup');
});

test('dialect: substitution, data-if, data-each, data-use, data-slot', async ({ page }) => {
  const result = await runScene(
    page,
    [
      {
        tag: 'Card',
        id: 'c1',
        x: 0,
        y: 0,
        props: {
          label: 'Hello',
          kind: 'alpha',
          items: [{ text: 'A' }, { text: 'B' }],
          chip: { text: 'hi' },
          icon: 'db',
        },
      },
      { tag: 'Card', id: 'c2', x: 0, y: 60, props: { label: 'Bare', kind: 'beta' } },
    ],
    ICONS,
  );

  expect(result.measures).toHaveLength(2);

  const full = page.locator('[data-mdp-id="c1"]');
  await expect(full.locator('[data-tpl="Card"]')).toHaveAttribute('data-kind', 'alpha');
  await expect(full.locator('[data-part="label"]')).toHaveText('Hello');
  await expect(full.locator('.card-items li')).toHaveText(['A', 'B']);

  // data-use mounts Chip inside the host and stamps the scope-root attribute on it.
  const chipHost = full.locator('[data-mdp-tag="Chip"]');
  await expect(chipHost).toHaveCount(1);
  await expect(chipHost.locator('[data-tpl="Chip"]')).toHaveText('hi');

  // data-slot mounts the icon sidecar SVG.
  await expect(full.locator('[data-slot] svg')).toHaveCount(1);

  // Falsy props remove the conditional subtrees entirely.
  const bare = page.locator('[data-mdp-id="c2"]');
  await expect(bare.locator('.card-items')).toHaveCount(0);
  await expect(bare.locator('[data-mdp-tag="Chip"]')).toHaveCount(0);
  await expect(bare.locator('[data-slot]')).toHaveCount(0);
});

test('pre-escaped content mounts as text and never executes', async ({ page }) => {
  // What resolve's plain policy emits for `<img src=x onerror="window.__pwned=1">`.
  const escaped = '&lt;img src=x onerror=&quot;window.__pwned=1&quot;&gt;';
  await runScene(page, [
    { tag: 'Card', id: 'c1', x: 0, y: 0, props: { label: escaped, kind: 'k' } },
  ]);

  await expect(page.locator('[data-mdp-id="c1"] img')).toHaveCount(0);
  await expect(page.locator('[data-mdp-id="c1"] [data-part="label"]')).toHaveText(
    '<img src=x onerror="window.__pwned=1">',
  );
  expect(await page.evaluate(() => '__pwned' in window)).toBe(false);
});

test('lookup resolves own properties only; missing paths substitute to empty', async ({ page }) => {
  await runScene(page, [{ tag: 'Probe', id: 'p1', x: 0, y: 0, props: {} }]);

  await expect(page.locator('[data-mdp-id="p1"] .probe-proto')).toHaveText('');
  await expect(page.locator('[data-mdp-id="p1"] .probe-missing')).toHaveText('');
});

test('template CSS is confined to its scope root and stops at data-use hosts', async ({ page }) => {
  await runScene(page, [
    {
      tag: 'Card',
      id: 'c1',
      x: 0,
      y: 0,
      props: { label: 'x', kind: 'k', chip: { text: 'hi' } },
    },
  ]);

  // Card's own rule applies inside its scope…
  await expect(page.locator('[data-mdp-id="c1"] .card-label')).toHaveCSS('color', 'rgb(200, 0, 0)');
  // …but its bare `i` rule must not cross the nested mount host: Chip styles itself.
  await expect(page.locator('[data-mdp-id="c1"] .chip')).toHaveCSS('color', 'rgb(0, 100, 0)');
});
