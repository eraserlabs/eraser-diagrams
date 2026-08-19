import { test, expect } from '@playwright/test';
import type { IconLoader } from '@eraserlabs/resolve';
import { createRenderer, type Renderer } from '../src/index.js';
import { stockLibrary } from '../src/library/index.js';
import { buildPayload, runPayload, stageAhem } from './support/payload.js';
import { allTagsDocument, connectionsDocument } from './support/documents.js';
import { CHROMIUM_PATH } from './support/browser.js';

/**
 * Source scenarios end-to-end: icons from a user-supplied loader (the promise handed to resolve)
 * travel resolver → sidecar → DOM slot; failures fall to the placeholder policy; and the page
 * stays fully airgapped — every asset (IIFE, templates, fonts, icons) arrives injected.
 */

// Distinctive path: only this loader's bytes produce it, so finding it in the DOM proves the
// custom source was used, not the stub pack.
const MARKER_D = 'M1 2L3 4';
const MARKER_SVG = `<svg viewBox="0 0 24 24"><path d="${MARKER_D}"/></svg>`;
const PLACEHOLDER_D = 'M8 8l8 8M16 8l-8 8';

test('custom loader: its SVG travels resolver → sidecar → DOM slot', async ({ page }) => {
  const calls: string[] = [];

  const loader: IconLoader = async (name) => {
    calls.push(name);

    return MARKER_SVG;
  };

  const { payload, result } = await buildPayload(
    { elements: [{ tag: 'Icon', id: 'i', x: 0, y: 0, icon: 'custom-mark' }] },
    { iconLoader: loader },
  );
  expect(result.ok).toBe(true);
  expect(calls).toEqual(['custom-mark']);

  await runPayload(page, payload);
  await expect(page.locator(`[data-slot] svg path[d="${MARKER_D}"]`)).toHaveCount(1);
});

test('failing loader: the placeholder glyph is what the user actually sees', async ({ page }) => {
  const loader: IconLoader = async () => {
    throw new Error('origin down');
  };

  const { payload, result } = await buildPayload(
    { elements: [{ tag: 'Icon', id: 'i', x: 0, y: 0, icon: 'gone-icon' }] },
    { iconLoader: loader },
  );
  expect(result.ok).toBe(true);
  expect(result.warnings.some((w) => w.code === 'W_UNKNOWN_ICON')).toBe(true);

  await runPayload(page, payload);
  await expect(page.locator(`[data-slot] svg path[d="${PLACEHOLDER_D}"]`)).toHaveCount(1);
});

test('airgap: a full render makes zero network requests', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.url().startsWith('http')) {
      requests.push(request.url());
    }
  });

  const { payload, result } = await buildPayload(allTagsDocument);
  expect(result.ok).toBe(true);
  await runPayload(page, payload, await stageAhem());

  expect(requests).toEqual([]);
});

test.describe('orchestrator (createRenderer)', () => {
  // These tests race renders through a one-page pool while sibling spec files keep their own
  // Chromium instances busy — the most contention-sensitive block in the suite, and the one
  // place a load-induced flake has been observed. Retries report "flaky" on a transient miss;
  // a real regression still fails every attempt.
  test.describe.configure({ retries: 2 });

  const calls: string[] = [];
  let diagrams: Renderer;

  const loader: IconLoader = async (name) => {
    calls.push(name);

    if (name.startsWith('missing-')) {
      throw new Error('404');
    }

    return MARKER_SVG;
  };

  test.beforeAll(async () => {
    diagrams = await createRenderer({
      library: stockLibrary,
      chromiumPath: CHROMIUM_PATH,
      iconLoader: loader,
      pages: 1,
    });
  });

  test.afterAll(async () => {
    await diagrams.close();
  });

  test('the loader fires once per icon name across renders (resolver cache)', async () => {
    const input = { elements: [{ tag: 'Icon', id: 'i', x: 0, y: 0, icon: 'cached-mark' }] };
    const first = await diagrams.render(input);
    const second = await diagrams.render(input);

    expect(first.ok && second.ok).toBe(true);
    expect(calls.filter((n) => n === 'cached-mark')).toEqual(['cached-mark']);
  });

  test('a loader failure degrades to a warned render, not a failed one', async () => {
    const outcome = await diagrams.render({
      elements: [{ tag: 'Icon', id: 'i', x: 0, y: 0, icon: 'missing-mark' }],
    });

    expect(outcome.ok).toBe(true);

    if (outcome.ok) {
      expect(outcome.warnings.some((w) => w.code === 'W_UNKNOWN_ICON')).toBe(true);
      expect(outcome.png.length).toBeGreaterThan(0);
    }
  });

  test('no state leaks between renders on the same warm page', async () => {
    // Chromium shifts its text-raster state once, on the first render of an auto-sized text
    // element (~500 antialiasing pixels drift, one time). Reach that steady state first; from
    // there any DOM/CSS leak between renders must show up as a byte difference.
    await diagrams.render(allTagsDocument);

    const first = await diagrams.render(connectionsDocument);
    await diagrams.render(allTagsDocument);
    const again = await diagrams.render(connectionsDocument);

    expect(first.ok && again.ok).toBe(true);

    if (first.ok && again.ok) {
      expect(again.png.equals(first.png)).toBe(true);
    }
  });

  test('concurrent renders queue on the pool and all complete identically', async () => {
    const input = connectionsDocument;
    const outcomes = await Promise.all([
      diagrams.render(input),
      diagrams.render(input),
      diagrams.render(input),
    ]);

    for (const outcome of outcomes) {
      expect(outcome.ok).toBe(true);
    }

    if (outcomes[0]!.ok && outcomes[1]!.ok && outcomes[2]!.ok) {
      expect(outcomes[1]!.png.equals(outcomes[0]!.png)).toBe(true);
      expect(outcomes[2]!.png.equals(outcomes[0]!.png)).toBe(true);
    }
  });
});

test('browser provider: a custom provider supplies the Chromium the pool runs on', async () => {
  const { chromium } = await import('playwright-core');
  let provided = false;

  const diagrams = await createRenderer({
    library: stockLibrary,
    browser: async () => {
      provided = true;

      return chromium.launch({ executablePath: CHROMIUM_PATH });
    },
  });

  try {
    expect(provided).toBe(true);
    const outcome = await diagrams.render(connectionsDocument);
    expect(outcome.ok).toBe(true);
  } finally {
    await diagrams.close();
  }
});

test('onUnknownIcon "error": a loader failure fails the render', async () => {
  const failing: IconLoader = async () => {
    throw new Error('404');
  };

  const strict = await createRenderer({
    library: stockLibrary,
    chromiumPath: CHROMIUM_PATH,
    iconLoader: failing,
    onUnknownIcon: 'error',
  });

  try {
    const outcome = await strict.render({
      elements: [{ tag: 'Icon', id: 'i', x: 0, y: 0, icon: 'nope-mark' }],
    });
    expect(outcome.ok).toBe(false);

    if (!outcome.ok) {
      expect(outcome.errors.some((e) => e.code === 'E_UNKNOWN_ICON')).toBe(true);
    }
  } finally {
    await strict.close();
  }
});
