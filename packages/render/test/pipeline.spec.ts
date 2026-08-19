import { test, expect } from '@playwright/test';
import { measureOf, runScene, setupScene, type SceneElement } from './support/harness.js';

/**
 * The measure → layout → apply protocol: two-pass sizing, wrapper-relative boxes, ink extents,
 * containment paint order, connection overlays, and scene serialization. All expected numbers
 * derive from fixed px CSS in the harness templates plus layout's 16px scene padding.
 */

test('two-pass sizing: authored dimensions are minimums and intrinsic content may grow them', async ({
  page,
}) => {
  const result = await runScene(page, [
    { tag: 'Card', id: 'auto', x: 0, y: 0, props: { label: 'x', kind: 'k' } },
    {
      tag: 'Card',
      id: 'fixed',
      x: 200,
      y: 0,
      width: 200,
      height: 80,
      props: { label: 'x', kind: 'k' },
    },
    {
      tag: 'Card',
      id: 'undersized',
      x: 500,
      y: 0,
      width: 80,
      height: 10,
      props: { label: 'x', kind: 'k' },
    },
  ]);

  // Intrinsic = the max-content pass-1 box: 100×20 label + 5px padding all round.
  expect(measureOf(result, 'auto').intrinsic).toEqual({ x: 0, y: 0, width: 110, height: 30 });
  expect(measureOf(result, 'fixed').intrinsic).toEqual({ x: 0, y: 0, width: 110, height: 30 });
  expect(measureOf(result, 'undersized').intrinsic).toEqual({
    x: 0,
    y: 0,
    width: 110,
    height: 30,
  });

  expect(result.layout.boxes['auto']).toEqual({ x: 0, y: 0, width: 110, height: 30 });
  expect(result.layout.boxes['fixed']).toEqual({ x: 200, y: 0, width: 200, height: 80 });
  expect(result.layout.boxes['undersized']).toEqual({ x: 500, y: 0, width: 110, height: 30 });

  // Apply positions wrappers absolutely, translated by the scene origin (16px padding).
  const sceneX = result.layout.scene.x;
  await expect(page.locator('[data-mdp-id="auto"]')).toHaveCSS('position', 'absolute');
  await expect(page.locator('[data-mdp-id="fixed"]')).toHaveCSS('left', `${200 - sceneX}px`);
});

test('text policies choose width growth, height growth, or a balanced compromise', async ({
  page,
}) => {
  const label = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const result = await runScene(page, [
    {
      tag: 'TextPolicy',
      id: 'width',
      x: 0,
      y: 0,
      width: 80,
      height: 16,
      props: { label, policy: 'width-only' },
    },
    {
      tag: 'TextPolicy',
      id: 'height',
      x: 0,
      y: 100,
      width: 80,
      height: 16,
      props: { label, policy: 'height-only' },
    },
    {
      tag: 'TextPolicy',
      id: 'balanced',
      x: 0,
      y: 200,
      width: 80,
      height: 16,
      props: { label, policy: 'balanced' },
    },
    {
      tag: 'TextPolicy',
      id: 'balanced-short',
      x: 200,
      y: 200,
      width: 120,
      height: 20,
      props: { label: 'A', policy: 'balanced' },
    },
    {
      tag: 'TextPolicy',
      id: 'height-default',
      x: 400,
      y: 0,
      height: 16,
      props: { label, policy: 'height-only' },
    },
    {
      tag: 'TextPolicy',
      id: 'width-default',
      x: 400,
      y: 200,
      height: 16,
      props: { label, policy: 'width-only' },
    },
    {
      tag: 'TextPolicy',
      id: 'balanced-default',
      x: 600,
      y: 0,
      height: 16,
      props: { label, policy: 'balanced' },
    },
  ]);

  const widthOnly = result.layout.boxes['width']!;
  const heightOnly = result.layout.boxes['height']!;
  const balanced = result.layout.boxes['balanced']!;
  const balancedShort = result.layout.boxes['balanced-short']!;
  const heightDefault = result.layout.boxes['height-default']!;
  const widthDefault = result.layout.boxes['width-default']!;
  const balancedDefault = result.layout.boxes['balanced-default']!;

  expect(widthOnly.width).toBeGreaterThan(300);
  expect(widthOnly.height).toBe(16);
  expect(heightOnly.width).toBe(80);
  expect(heightOnly.height).toBeGreaterThan(16);
  expect(balanced.width).toBeGreaterThan(80);
  expect(balanced.width).toBeLessThan(widthOnly.width);
  expect(balanced.height).toBeGreaterThan(16);
  expect(balanced.height).toBeLessThan(heightOnly.height);
  expect(balancedShort.width).toBe(120);
  expect(balancedShort.height).toBeGreaterThanOrEqual(20);
  expect(heightDefault.width).toBe(100);
  expect(heightDefault.height).toBeGreaterThan(16);
  expect(widthDefault.width).toBeGreaterThan(300);
  expect(widthDefault.height).toBe(16);
  expect(balancedDefault.width).toBeGreaterThan(100);
  expect(balancedDefault.width).toBeLessThan(widthDefault.width);
  expect(balancedDefault.height).toBeGreaterThan(16);
});

test('balanced connection text wraps to the routed horizontal run and is rerouted at that size', async ({
  page,
}) => {
  const result = await runScene(page, [
    { tag: 'Box', id: 'a', x: 0, y: 0, width: 40, height: 40, props: {} },
    { tag: 'Box', id: 'b', x: 260, y: 0, width: 40, height: 40, props: {} },
    {
      tag: 'PolicyWire',
      id: 'w',
      x: 0,
      y: 0,
      props: {
        from: 'a',
        to: 'b',
        label: 'A very long connection label that should wrap on the available line segment',
      },
    },
  ]);

  const label = measureOf(result, 'w').roles['external-text']![0]!;
  const longestHorizontal = Math.max(
    ...result.layout.connections['w']!.points.slice(1).map((point, index) => {
      const previous = result.layout.connections['w']!.points[index]!;
      return point[1] === previous[1] ? Math.abs(point[0] - previous[0]) : 0;
    }),
  );

  expect(label.width).toBeLessThanOrEqual(longestHorizontal - 24 + 0.5);
  expect(label.height).toBeGreaterThan(16);
  expect(result.layout.connections['w']!.labelBox).toMatchObject({
    width: label.width,
    height: label.height,
  });
});

test('measures: body, parts and ink are wrapper-relative; ink adds shadow extents', async ({
  page,
}) => {
  const result = await runScene(page, [
    { tag: 'Box', id: 'k1', x: 0, y: 0, width: 60, height: 40, props: { badge: '!' } },
  ]);
  const measure = measureOf(result, 'k1');

  expect(measure.body).toEqual({ x: 0, y: 0, width: 60, height: 40 });
  expect(measure.roles['body']).toHaveLength(1);
  expect(measure.parts['badge']).toEqual([{ x: -30, y: -30, width: 20, height: 20 }]);

  // Badge at (-30,-30,20,20) plus its 5px box-shadow halo (blur 2 + spread 3). The box's inset
  // shadow (halo 40) paints inside the border box and must not extend ink.
  expect(measure.ink).toEqual({ x: -35, y: -35, width: 95, height: 75 });
});

test('scene grows to contain ink that overflows the layout padding', async ({ page }) => {
  const result = await runScene(page, [
    { tag: 'Box', id: 'n1', x: 0, y: 0, width: 60, height: 40, props: { badge: '!' } },
  ]);

  // Layout knows only the node box: (0,0,60,40) + 16px padding. Ink reaches (-35,-35).
  expect(result.layout.scene).toEqual({ x: -16, y: -16, width: 92, height: 72 });

  const scene = page.locator('#eraser-scene');
  await expect(scene).toHaveCSS('width', '111px');
  await expect(scene).toHaveCSS('height', '91px');

  // Wrapper offsets shift to the grown origin: 0 − (−35).
  await expect(page.locator('[data-mdp-id="n1"]')).toHaveCSS('left', '35px');
  await expect(page.locator('[data-mdp-id="n1"]')).toHaveCSS('top', '35px');
});

test('scene grows for a connection label protruding past the layout box', async ({ page }) => {
  const result = await runScene(page, [
    { tag: 'Box', id: 'a', x: 0, y: 0, width: 10, height: 10, props: {} },
    { tag: 'Box', id: 'b', x: 0, y: 100, width: 10, height: 10, props: {} },
    { tag: 'Wire', id: 'w', x: 0, y: 0, props: { from: 'a', to: 'b', label: 'edge' } },
  ]);

  // The router places the 80×10 label itself, centered on the route at (−35,50)–(45,60); the scene
  // unions node boxes, the polyline, and that placed box, then adds 16px padding.
  expect(result.layout.connections['w']!.labelBox).toEqual({
    x: -35,
    y: 50,
    width: 80,
    height: 10,
  });
  expect(result.layout.scene).toEqual({ x: -51, y: -16, width: 112, height: 142 });

  const scene = page.locator('#eraser-scene');
  await expect(scene).toHaveCSS('width', '112px');
  await expect(scene).toHaveCSS('height', '142px');

  // A placed box is positioned directly — no midpoint transform.
  const label = page.locator('[data-mdp-id="w"] [data-role="external-text"]');
  await expect(label).toHaveCSS('left', '16px');
  await expect(label).toHaveCSS('top', '66px');
});

test('containment: containers paint behind members, content unions member boxes', async ({
  page,
}) => {
  const box = (
    id: string,
    x: number,
    y: number,
    size: number,
    containerId?: string,
  ): SceneElement => ({
    tag: 'Box',
    id,
    x,
    y,
    width: size,
    height: size,
    ...(containerId === undefined ? {} : { containerId }),
    props: {},
  });
  const result = await runScene(page, [
    box('g1', 0, 0, 200),
    box('g2', 10, 10, 100, 'g1'),
    box('s1', 20, 20, 30, 'g2'),
    box('s2', 150, 150, 30, 'g1'),
  ]);

  // depth×2 for containers, +1 for leaves: each level slots between its parent and its members.
  await expect(page.locator('[data-mdp-id="g1"]')).toHaveCSS('z-index', '0');
  await expect(page.locator('[data-mdp-id="g2"]')).toHaveCSS('z-index', '2');
  await expect(page.locator('[data-mdp-id="s1"]')).toHaveCSS('z-index', '5');
  await expect(page.locator('[data-mdp-id="s2"]')).toHaveCSS('z-index', '3');

  expect(measureOf(result, 'g1').content).toEqual({ x: 10, y: 10, width: 170, height: 170 });
  expect(measureOf(result, 'g2').content).toEqual({ x: 20, y: 20, width: 30, height: 30 });
  expect(measureOf(result, 's1').content).toBeUndefined();
});

test('connections: full-scene overlay, routed d, midpoint label; dangling refs stay unrouted', async ({
  page,
}) => {
  const result = await runScene(page, [
    { tag: 'Box', id: 'a', x: 0, y: 0, width: 40, height: 40, props: {} },
    { tag: 'Box', id: 'b', x: 120, y: 80, width: 40, height: 40, props: {} },
    { tag: 'Wire', id: 'w1', x: 0, y: 0, props: { from: 'a', to: 'b', label: 'link' } },
    {
      tag: 'Wire',
      id: 'w3',
      x: 100,
      y: 50,
      props: {
        from: 'a',
        to: 'b',
        label: 'wp',
        points: [
          { x: 0, y: 0 },
          { x: 60, y: 0 },
        ],
      },
    },
    { tag: 'Wire', id: 'w2', x: 0, y: 0, props: { from: 'a', to: 'ghost', label: 'nope' } },
  ]);

  // Node union (0,0)–(160,120) plus 16px padding.
  expect(result.layout.scene).toEqual({ x: -16, y: -16, width: 192, height: 152 });

  // w1: no author points → a corridor route, orthogonal and face-to-face.
  expect(result.layout.connections['w1']!.d).toBe('M40 20L80 20L80 100L120 100');
  await expect(page.locator('[data-mdp-id="w1"] [data-role="anchor"]')).toHaveAttribute(
    'd',
    'M40 20L80 20L80 100L120 100',
  );

  // The overlay spans the scene and its viewBox pins path data to scene coordinates.
  await expect(page.locator('[data-mdp-id="w1"] svg')).toHaveAttribute(
    'viewBox',
    '-16 -16 192 152',
  );
  await expect(page.locator('[data-mdp-id="w1"]')).toHaveCSS('pointer-events', 'none');

  // w3: element-origin-relative author points are offset into scene coordinates and adopted
  // verbatim — the router routes around them rather than replacing them.
  expect(result.layout.connections['w3']!.d).toBe('M100 50L160 50');
  expect(result.layout.connections['w3']!.label).toEqual({ x: 130, y: 50 });

  const label = page.locator('[data-mdp-id="w3"] [data-role="external-text"]');
  await expect(label).toHaveCSS('left', `${130 - result.layout.scene.x}px`);
  await expect(label).toHaveCSS('top', `${50 - result.layout.scene.y}px`);

  // w2's `to` resolves nowhere: layout drops it and apply leaves the wrapper unpositioned.
  expect(result.layout.connections['w2']).toBeUndefined();
  await expect(page.locator('[data-mdp-id="w2"]')).not.toHaveCSS('position', 'absolute');
});

test('serialize returns the positioned scene and the injected stylesheet', async ({ page }) => {
  await runScene(page, [{ tag: 'Card', id: 'c1', x: 0, y: 0, props: { label: 'x', kind: 'k' } }]);
  const serialized = await page.evaluate(() => window.__eraser.serialize());

  expect(serialized.scene).toContain('id="eraser-scene"');
  expect(serialized.scene).toContain('data-mdp-id="c1"');
  expect(serialized.css).toContain('#eraser-scene{background:rgb(250,250,250)}');
  expect(serialized.css).toContain('@scope([data-mdp-tag="Card"]) to ([data-mdp-tag])');
});

test('registerFonts: css lands in #eraser-fonts, hostile bytes degrade, serialize carries both sheets', async ({
  page,
}) => {
  await setupScene(page);
  await page.evaluate((request) => window.__eraser.registerFonts(request), {
    css: ":root{--font-main:'Ghost',sans-serif}",
    faces: [{ family: 'Ghost', bytes64: Buffer.from('not a font at all').toString('base64') }],
  });

  // A face that fails to parse degrades to status 'error' without crashing the page.
  const statuses = await page.evaluate(() =>
    [...document.fonts].map((face) => [face.family, face.status]),
  );
  expect(statuses).toEqual([['Ghost', 'error']]);

  await page.evaluate((request) => window.__eraser.run(request), {
    entities: [{ tag: 'Card', id: 'c1', x: 0, y: 0, props: { label: 'x', kind: 'k' } }],
    connections: [],
    icons: {},
  });
  const serialized = await page.evaluate(() => window.__eraser.serialize());

  expect(serialized.css).toContain("--font-main:'Ghost',sans-serif");
  expect(serialized.css).toContain('@scope([data-mdp-tag="Card"]) to ([data-mdp-tag])');
});
