import { expect, test } from '@playwright/test';
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';

declare global {
  interface Window {
    labelGapTest: typeof import('../src/browser/fillApi.js');
  }
}

const script = buildSync({
  entryPoints: [fileURLToPath(new URL('../src/browser/fillApi.ts', import.meta.url))],
  bundle: true,
  format: 'iife',
  globalName: 'labelGapTest',
  write: false,
}).outputFiles[0]!.text;

test.beforeEach(async ({ page }) => {
  await page.setContent(`<!doctype html><style>body { margin: 0; background: white }</style>
    <svg width="200" height="100">
      <defs>
        <mask id="authored-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="100"><rect width="200" height="100" fill="white"/></mask>
        <clipPath id="authored-clip"><rect width="200" height="100"/></clipPath>
      </defs>
      <path d="M10 50L190 50" stroke="black" stroke-width="4"/>
    </svg>`);
  await page.addScriptTag({ content: script });
});

for (const effect of ['none', 'mask', 'clip', 'both', 'none-attributes'] as const) {
  test(`dragging and cleanup preserve authored effects: ${effect}`, async ({ page }) => {
    const original = await page.evaluate((effect) => {
      const anchor = document.querySelector('svg > path')!;
      if (effect === 'mask' || effect === 'both') {
        anchor.setAttribute('mask', 'url(#authored-mask)');
      }
      if (effect === 'clip' || effect === 'both') {
        anchor.setAttribute('clip-path', 'url(#authored-clip)');
      }
      if (effect === 'none-attributes') {
        anchor.setAttribute('mask', 'none');
        anchor.setAttribute('clip-path', 'none');
      }
      return { mask: anchor.getAttribute('mask'), clip: anchor.getAttribute('clip-path') };
    }, effect);
    const uncut = await page.locator('svg').screenshot();

    const initial = await page.evaluate(() => {
      const svg = document.querySelector('svg')!;
      const anchor = svg.querySelector('path')!;
      // Spaces and parentheses break raw url(#...) references; line breaks break CSS strings.
      const connectionId = 'edge (1) "quoted" \\ slash\n\r\f雪';
      const cut = window.labelGapTest.cutLabelGap(
        svg,
        anchor,
        {
          x: 80,
          y: 40,
          width: 40,
          height: 20,
        },
        { connectionId, field: { x: 0, y: 0, width: 200, height: 100 } },
      );
      const resource = svg.querySelector('[data-mdp-connection-mask], [data-mdp-connection-clip]')!;
      return {
        cut,
        id: resource.id,
        connectionId:
          resource.getAttribute('data-mdp-connection-mask') ??
          resource.getAttribute('data-mdp-connection-clip'),
      };
    });
    expect(initial.cut).toBe(true);
    expect(initial.id).toMatch(/^eraser-connection-label-(mask|clip)-\d+$/);
    expect(initial.connectionId).toBe('edge (1) "quoted" \\ slash\n\r\f雪');
    // Check actual browser paint, not just that a resource and attribute were created.
    expect((await page.locator('svg').screenshot()).equals(uncut)).toBe(false);

    const moved = await page.evaluate(() => {
      const svg = document.querySelector('svg')!;
      const anchor = svg.querySelector('path:not(defs path)')!;
      const previous = svg.querySelector('[data-mdp-connection-mask], [data-mdp-connection-clip]')!;
      anchor.setAttribute('d', 'M10 60L190 60');
      for (let x = 50; x <= 70; x += 10) {
        window.labelGapTest.cutLabelGap(
          svg,
          anchor,
          { x, y: 50, width: 40, height: 20 },
          {
            connectionId: 'renamed edge',
            field: { x: 0, y: 0, width: 200, height: 100 },
          },
        );
      }
      const resource = svg.querySelector('[data-mdp-connection-mask], [data-mdp-connection-clip]')!;
      const cutout = resource.querySelector('[data-mdp-label-cutout]')!;
      return {
        previousRemoved: !previous.isConnected,
        count: svg.querySelectorAll('[data-mdp-connection-mask], [data-mdp-connection-clip]')
          .length,
        hosts: svg.querySelectorAll('[data-mdp-label-gap-host]').length,
        cutoutX: cutout.getAttribute('x'),
        cutoutPath: cutout.getAttribute('d'),
      };
    });
    expect(moved.previousRemoved).toBe(true);
    expect(moved.count).toBe(1);
    expect(moved.hosts).toBe(effect === 'both' ? 1 : 0);
    if (effect === 'mask') {
      expect(moved.cutoutPath).toContain('M68 48');
    } else {
      expect(moved.cutoutX).toBe('68');
    }

    const cleared = await page.evaluate(() => {
      const svg = document.querySelector('svg')!;
      const anchor = svg.querySelector('path:not(defs path)')!;
      const cut = window.labelGapTest.cutLabelGap(
        svg,
        anchor,
        {
          x: 70,
          y: 80,
          width: 40,
          height: 10,
        },
        { connectionId: 'renamed edge', field: { x: 0, y: 0, width: 200, height: 100 } },
      );
      const remainingAfterMovingOff = svg.querySelectorAll('[data-mdp-label-cutout]').length;
      window.labelGapTest.cutLabelGap(
        svg,
        anchor,
        { x: 70, y: 50, width: 40, height: 20 },
        {
          connectionId: 'last\nedge',
          field: { x: 0, y: 0, width: 200, height: 100 },
        },
      );
      window.labelGapTest.clearLabelGap(svg, anchor, 'last\nedge');
      window.labelGapTest.clearLabelGap(svg, anchor, 'last\nedge');
      anchor.setAttribute('d', 'M10 50L190 50');
      return {
        cut,
        remainingAfterMovingOff,
        remaining: svg.querySelectorAll('[data-mdp-label-cutout], [data-mdp-label-gap-host]')
          .length,
        mask: anchor.getAttribute('mask'),
        clip: anchor.getAttribute('clip-path'),
        directChild: anchor.parentNode === svg,
        authoredCount: svg.querySelectorAll('#authored-mask, #authored-clip').length,
      };
    });
    expect(cleared).toEqual({
      ...original,
      cut: false,
      remainingAfterMovingOff: 0,
      remaining: 0,
      directChild: true,
      authoredCount: 2,
    });
    expect((await page.locator('svg').screenshot()).equals(uncut)).toBe(true);
  });
}

test('IDs and cleanup are isolated across anchors, including detached SVGs', async ({ page }) => {
  const result = await page.evaluate(() => {
    const first = document.querySelector('svg')!;
    const second = first.cloneNode(true) as SVGSVGElement;
    const collision = first.querySelector('mask')!;
    collision.id = 'eraser-connection-label-mask-0';
    const detachedCollision = second.querySelector('mask')!;
    second.id = 'eraser-connection-label-mask-2';
    detachedCollision.id = 'eraser-connection-label-mask-3';
    const paths = [first.querySelector('path')!, second.querySelector('path')!];
    const options = { connectionId: 'same id', field: { x: 0, y: 0, width: 200, height: 100 } };
    const label = { x: 80, y: 40, width: 40, height: 20 };
    window.labelGapTest.cutLabelGap(first, paths[0]!, label, options);
    window.labelGapTest.cutLabelGap(second, paths[1]!, label, options);
    const resources = [first, second].map((svg) =>
      svg.querySelector('[data-mdp-connection-mask]')!,
    );
    const ids = resources.map((resource) => resource.id);
    document.body.append(second);
    window.labelGapTest.clearLabelGap(first, paths[0]!, 'same id');
    const otherIntact =
      resources[1]!.isConnected && getComputedStyle(paths[1]!).maskImage !== 'none';

    // Two anchors can even share a connection id within one SVG without sharing resource ownership.
    const sibling = paths[1]!.cloneNode(true) as SVGPathElement;
    sibling.removeAttribute('mask');
    second.append(sibling);
    window.labelGapTest.cutLabelGap(second, sibling, label, options);
    window.labelGapTest.clearLabelGap(second, paths[1]!, 'same id');
    return {
      ids,
      otherIntact,
      siblingIntact: getComputedStyle(sibling).maskImage !== 'none',
      remaining: second.querySelectorAll('[data-mdp-connection-mask]').length,
      authoredIntact: collision.isConnected && detachedCollision.isConnected,
    };
  });
  expect(new Set(result.ids).size).toBe(2);
  expect(result.ids).not.toContain('eraser-connection-label-mask-0');
  expect(result.ids).not.toContain('eraser-connection-label-mask-2');
  expect(result.ids).not.toContain('eraser-connection-label-mask-3');
  expect(result.otherIntact).toBe(true);
  expect(result.siblingIntact).toBe(true);
  expect(result.remaining).toBe(1);
  expect(result.authoredIntact).toBe(true);
});
