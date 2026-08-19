import { expect, test } from '@playwright/test';
import { runScene, type SceneElement } from './support/harness.js';

const box = (
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  containerId?: string,
): SceneElement => ({
  tag: 'Box',
  id,
  x,
  y,
  width,
  height,
  ...(containerId === undefined ? {} : { containerId }),
  props: {},
});

test('connection labels cut a unique user-space mask without changing path paint', async ({
  page,
}) => {
  const result = await runScene(page, [
    box('outer', 0, 0, 300, 220),
    box('inner', 10, 10, 270, 190, 'outer'),
    box('a', 30, 30, 40, 40, 'inner'),
    box('b', 220, 130, 40, 40, 'inner'),
    box('c', 10, 180, 20, 20),
    box('d', 270, 180, 20, 20),
    {
      tag: 'MaskedWire',
      id: 'placed',
      x: 0,
      y: 0,
      containerId: 'inner',
      props: {
        from: 'a',
        to: 'b',
        label: 'placed',
        // Runs under the label's own box: a cutout that misses its route cuts no gap, so apply
        // installs no mask at all and there would be nothing here to assert.
        points: [
          { x: 90, y: 45 },
          { x: 170, y: 45 },
        ],
        // Deliberately overlaps node a so the browser's actual hit-test order can verify that the
        // foreground label escapes this connection's former sibling stacking context.
        labelPlacement: { x: 69, y: 44, width: 21, height: 1 },
      },
    },
    {
      tag: 'MaskedWire',
      id: 'fallback',
      x: 90,
      y: 90,
      props: {
        from: 'a',
        to: 'b',
        label: 'fallback',
        points: [
          { x: 0, y: 0 },
          { x: 80, y: 0 },
        ],
      },
    },
    {
      tag: 'AuthoredMaskedWire',
      id: 'composed',
      x: 0,
      y: 0,
      props: {
        from: 'c',
        to: 'd',
        label: 'composed',
      },
    },
    {
      tag: 'AuthoredMaskAndClipWire',
      id: 'both-authored',
      x: 0,
      y: 0,
      props: {
        from: 'c',
        to: 'd',
        label: 'both authored',
      },
    },
  ]);

  const placed = result.layout.connections['placed']!;
  const fallback = result.layout.connections['fallback']!;
  expect(placed.labelBox).toBeDefined();
  expect(fallback.labelBox).toBeUndefined();

  const state = await page.evaluate(() =>
    ['placed', 'fallback'].map((id) => {
      const wrapper = document.querySelector(`[data-mdp-id="${id}"]`);

      if (!wrapper) {
        throw new Error(`missing MDP mount host for ${id}`);
      }

      const svg = wrapper.querySelector('svg')!;
      const anchor = wrapper.querySelector('[data-role="anchor"]')!;
      const label = wrapper.querySelector<HTMLElement>('[data-role="external-text"]')!;
      const mask = wrapper.querySelector<SVGMaskElement>('[data-mdp-connection-mask]');

      if (!mask) {
        throw new Error(`missing generated label mask for ${id}: ${wrapper.innerHTML}`);
      }

      const field = mask.querySelector<SVGRectElement>('rect:not([data-mdp-label-cutout])')!;
      const cutout = mask.querySelector<SVGRectElement>('[data-mdp-label-cutout]')!;
      const numbers = (element: Element) => ({
        x: Number(element.getAttribute('x')),
        y: Number(element.getAttribute('y')),
        width: Number(element.getAttribute('width')),
        height: Number(element.getAttribute('height')),
      });

      return {
        id,
        maskId: mask.id,
        maskFor: mask.getAttribute('data-mdp-connection-mask'),
        maskUnits: mask.getAttribute('maskUnits'),
        maskContentUnits: mask.getAttribute('maskContentUnits'),
        region: numbers(mask),
        field: numbers(field),
        cutout: numbers(cutout),
        d: anchor.getAttribute('d'),
        maskReference: anchor.getAttribute('mask'),
        markerStart: anchor.getAttribute('marker-start'),
        markerEnd: anchor.getAttribute('marker-end'),
        dashArray: anchor.getAttribute('stroke-dasharray'),
        dashOffset: anchor.getAttribute('stroke-dashoffset'),
        anchorCount: wrapper.querySelectorAll('[data-role="anchor"]').length,
        wrapperZ: getComputedStyle(wrapper).zIndex,
        svgZ: getComputedStyle(svg).zIndex,
        labelZ: getComputedStyle(label).zIndex,
        labelColor: getComputedStyle(label).color,
        ownerId: label.closest('[data-mdp-id]')?.getAttribute('data-mdp-id'),
        viewBox: svg.getAttribute('viewBox'),
      };
    }),
  );

  expect(new Set(state.map(({ maskId }) => maskId)).size).toBe(2);
  expect(state.map(({ maskId }) => maskId)).not.toContain('eraser-connection-label-mask-0');
  const fallbackLabelMeasure = result.measures.find(({ id }) => id === 'fallback')!.roles[
    'external-text'
  ]![0]!;

  const expectedCutouts = {
    placed: {
      x: placed.labelBox!.x - 2,
      y: placed.labelBox!.y - 2,
      width: placed.labelBox!.width + 4,
      height: placed.labelBox!.height + 4,
    },
    fallback: {
      x: fallback.label.x - fallbackLabelMeasure.width / 2 - 2,
      y: fallback.label.y - fallbackLabelMeasure.height - 2,
      width: fallbackLabelMeasure.width + 4,
      height: fallbackLabelMeasure.height + 4,
    },
  };

  for (const connection of state) {
    expect(connection.maskFor).toBe(connection.id);
    expect(connection.maskUnits).toBe('userSpaceOnUse');
    expect(connection.maskContentUnits).toBe('userSpaceOnUse');
    expect(connection.region).toEqual(connection.field);
    expect(connection.cutout).toEqual(
      expectedCutouts[connection.id as keyof typeof expectedCutouts],
    );
    expect(connection.d).toBe(result.layout.connections[connection.id]!.d);
    expect(connection.maskReference).toBe(`url(#${connection.maskId})`);
    expect(connection.markerStart).toBe('url(#test-arrow)');
    expect(connection.markerEnd).toBe('url(#test-arrow)');
    expect(connection.dashArray).toBe('8 4');
    expect(connection.dashOffset).toBe('3');
    expect(connection.anchorCount).toBe(1);
    expect(connection.wrapperZ).toBe('auto');
    expect(connection.labelZ).toBe('7');
    expect(connection.labelColor).toBe('rgb(10, 20, 30)');
    expect(connection.ownerId).toBe(connection.id);

    const [viewX, viewY, viewWidth, viewHeight] = connection.viewBox!.split(' ').map(Number);
    expect(connection.region).toEqual({
      x: viewX,
      y: viewY,
      width: viewWidth,
      height: viewHeight,
    });
  }

  // Every line shares one layer above the deepest node layer (here `a`/`b` at depth 2 → z=5), and
  // every label one layer above that. A connection's own containerId does not lower it back into
  // the containment layers, where a node's spilled ink would paint over the start of its route.
  expect(state.find(({ id }) => id === 'placed')!.svgZ).toBe('6');
  expect(state.find(({ id }) => id === 'fallback')!.svgZ).toBe('6');
  await expect(page.locator('[data-mdp-id="a"]')).toHaveCSS('z-index', '5');

  const topPaintAtPlacedLabel = await page.evaluate(() => {
    const wrapper = document.querySelector<HTMLElement>('[data-mdp-id="placed"]')!;
    const label = wrapper.querySelector<HTMLElement>('[data-role="external-text"]')!;
    wrapper.style.pointerEvents = 'auto';
    const rect = label.getBoundingClientRect();
    const top = document.elementsFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)[0];
    wrapper.style.pointerEvents = 'none';

    return {
      role: top?.getAttribute('data-role'),
      ownerId: top?.closest('[data-mdp-id]')?.getAttribute('data-mdp-id'),
    };
  });
  expect(topPaintAtPlacedLabel).toEqual({ role: 'external-text', ownerId: 'placed' });

  const serialized = await page.evaluate(() => window.__eraser.serialize());
  expect(serialized.scene).toContain('data-mdp-connection-mask="placed"');
  expect(serialized.scene).toContain('data-mdp-label-cutout=""');
  expect(serialized.scene).toContain(`mask="url(#${state[0]!.maskId})"`);

  const composed = await page.evaluate(() => {
    const wrapper = document.querySelector('[data-mdp-id="composed"]')!;
    const anchor = wrapper.querySelector('[data-role="anchor"]')!;
    const clip = wrapper.querySelector<SVGClipPathElement>('[data-mdp-connection-clip]')!;

    return {
      authoredMaskReference: anchor.getAttribute('mask'),
      labelClipReference: anchor.getAttribute('clip-path'),
      clipId: clip.id,
      clipFor: clip.getAttribute('data-mdp-connection-clip'),
      clipUnits: clip.getAttribute('clipPathUnits'),
      cutoutRule: clip.querySelector('[data-mdp-label-cutout]')?.getAttribute('clip-rule'),
    };
  });
  expect(composed).toEqual({
    authoredMaskReference: 'url(#eraser-connection-label-clip-0)',
    labelClipReference: `url(#${composed.clipId})`,
    clipId: expect.not.stringMatching(/^eraser-connection-label-clip-0$/),
    clipFor: 'composed',
    clipUnits: 'userSpaceOnUse',
    cutoutRule: 'evenodd',
  });
  expect(serialized.scene).toContain('mask="url(#eraser-connection-label-clip-0)"');
  expect(serialized.scene).toContain(`clip-path="url(#${composed.clipId})"`);

  const bothAuthored = await page.evaluate(() => {
    const wrapper = document.querySelector('[data-mdp-id="both-authored"]')!;
    const anchor = wrapper.querySelector('[data-role="anchor"]')!;
    const host = anchor.parentElement!;
    const generatedMask = wrapper.querySelector<SVGMaskElement>(
      '[data-mdp-connection-mask="both-authored"]',
    )!;

    return {
      authoredMaskReference: anchor.getAttribute('mask'),
      authoredClipReference: anchor.getAttribute('clip-path'),
      hostTag: host.tagName,
      hostFor: host.getAttribute('data-mdp-label-gap-host'),
      hostMaskReference: host.getAttribute('mask'),
      generatedMaskId: generatedMask.id,
      generatedIdCount: document.querySelectorAll(`[id="${generatedMask.id}"]`).length,
    };
  });
  expect(bothAuthored).toEqual({
    authoredMaskReference: 'url(#authored-wire-mask)',
    authoredClipReference: 'url(#authored-wire-clip)',
    hostTag: 'g',
    hostFor: 'both-authored',
    hostMaskReference: `url(#${bothAuthored.generatedMaskId})`,
    generatedMaskId: expect.stringMatching(/^eraser-connection-label-mask-/),
    generatedIdCount: 1,
  });
  expect(serialized.scene).toContain('mask="url(#authored-wire-mask)"');
  expect(serialized.scene).toContain('clip-path="url(#authored-wire-clip)"');
  expect(serialized.scene).toContain(
    `data-mdp-label-gap-host="both-authored" mask="url(#${bothAuthored.generatedMaskId})"`,
  );

  // Chromium must paint both effects, not merely retain their markup. With every other scene
  // wrapper hidden, removing either the authored mask or generated inverse clip reveals a
  // different part of this long horizontal line.
  await page.evaluate(() => {
    for (const wrapper of document.querySelectorAll<HTMLElement>('[data-mdp-id]')) {
      if (wrapper.dataset.mdpId !== 'composed') {
        wrapper.style.visibility = 'hidden';
      }
    }
    document.querySelector<HTMLElement>(
      '[data-mdp-id="composed"] [data-role="external-text"]',
    )!.style.visibility = 'hidden';
  });

  const composedSvg = page.locator('[data-mdp-id="composed"] svg');
  const composedAnchor = composedSvg.locator('[data-role="anchor"]');
  const bothMasks = await composedSvg.screenshot();
  await composedAnchor.evaluate((element) => element.removeAttribute('mask'));
  const withoutAuthoredMask = await composedSvg.screenshot();
  await composedAnchor.evaluate((element) =>
    element.setAttribute('mask', 'url(#eraser-connection-label-clip-0)'),
  );
  await composedAnchor.evaluate((element) => element.removeAttribute('clip-path'));
  const withoutLabelMask = await composedSvg.screenshot();

  expect(withoutAuthoredMask.equals(bothMasks)).toBe(false);
  expect(withoutLabelMask.equals(bothMasks)).toBe(false);
});

test('a line paints above every node, so spilled node ink cannot cut its route', async ({
  page,
}) => {
  // The defect this pins: a connection has no `containerId`, so the containment formula scored it
  // depth 0 and dropped it to the top-level member layer — below every grouped node. A node's ink
  // deliberately spills past its layout box, and a route attaches exactly at that box edge, so the
  // spill painted over the start of the line.
  await runScene(page, [
    box('group', 0, 0, 300, 120),
    box('a', 20, 40, 60, 40, 'group'),
    box('b', 200, 40, 60, 40, 'group'),
    {
      tag: 'Wire',
      id: 'w',
      x: 0,
      y: 0,
      props: {
        from: 'a',
        to: 'b',
        points: [
          { x: 80, y: 60 },
          { x: 200, y: 60 },
        ],
      },
    },
  ]);

  const layers = await page.evaluate(() => {
    const wrappers = [...document.querySelectorAll<HTMLElement>('[data-mdp-id]')];
    const nodeZ = wrappers
      .map((wrapper) => Number(getComputedStyle(wrapper).zIndex))
      .filter((z) => Number.isFinite(z));
    const svg = document.querySelector<SVGElement>('[data-mdp-id="w"] svg')!;

    return { topNode: Math.max(...nodeZ), line: Number(getComputedStyle(svg).zIndex) };
  });

  // `a` and `b` sit one level deep, so the deepest node layer is 3 and the line must clear it.
  expect(layers.topNode).toBe(3);
  expect(layers.line).toBeGreaterThan(layers.topNode);
});
