import { test, expect, type Locator, type Page } from '@playwright/test';
import { stageFonts } from '../src/fonts/staging.js';
import { AHEM_PATH, buildPayload, readFixture, runPayload, stageAhem } from './support/payload.js';
import { allTagsDocument, connectionsDocument } from './support/documents.js';
import type { RunResult } from './support/payload.js';

/**
 * The browser path against resolver data: fill → mount → measure → layout → apply, asserted at the
 * DOM level. The hostile fixture is the proof that decision 5 held (resolve escapes, render uses
 * innerHTML, nothing executes).
 */

const CONNECTION_TAGS = new Set(['Relationship', 'DatabaseRelationship']);

async function textInkBox(locator: Locator) {
  return locator.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();

    while (node?.textContent?.trim() === '') {
      node = walker.nextNode();
    }

    if (!node) {
      throw new Error('expected rendered text');
    }

    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();

    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
}

async function renderFixture(page: Page, fixture: string): Promise<RunResult> {
  return renderDocument(page, readFixture(fixture));
}

async function renderDocument(page: Page, document: unknown): Promise<RunResult> {
  const { payload, result } = await buildPayload(document);
  expect(result.ok, JSON.stringify(result.errors)).toBe(true);

  return runPayload(page, payload);
}

test('all-tags: every element mounts one template root with its roles and sub-templates', async ({
  page,
}) => {
  const result = await renderDocument(page, allTagsDocument);
  expect(result.measures).toHaveLength(11);

  for (const measure of result.measures) {
    await expect(
      page.locator(`[data-mdp-id="${measure.id}"] [data-tpl="${measure.tag}"]`),
    ).toHaveCount(1);
  }

  // Shape s1: attribute substitution, data-each rows, and the Badge sub-template.
  const shape = page.locator('[data-mdp-id="s1"]');
  await expect(shape.locator('.er-shape')).toHaveClass(/er-style--plain/);
  await expect(shape.locator('[data-role="internal-text"] > .er-shape__text')).toHaveText([
    'Service',
  ]);
  await expect(shape.locator('[data-tpl="Badge"]')).toHaveText('3');

  // Icon i1: the slot mounts the sidecar SVG for props.icon.
  await expect(page.locator('[data-mdp-id="i1"] [data-slot] svg')).toHaveCount(1);
  await expect(page.locator('[data-mdp-id="i1"] figcaption')).toHaveText('DB');

  // DatabaseTable t1: one row per field.
  const table = page.locator('[data-mdp-id="t1"]');
  await expect(table.locator('.er-dbtable__row')).toHaveCount(2);
  await expect(table.locator('.er-dbtable__f-name').first()).toHaveText('id');

  // Legend lg1: data-each over the flat entries. The swatch is gated on the authored color, so an
  // entry without one keeps the stylesheet default instead of voiding the background declaration.
  const legend = page.locator('[data-mdp-id="lg1"]');
  await expect(legend.locator('li')).toHaveCount(2);
  await expect(legend.locator('.er-legend__text')).toHaveText(['primary', 'uncolored']);
  await expect(legend.locator('.er-legend__swatch').first()).toHaveCSS(
    'background-color',
    'rgb(0, 170, 119)',
  );
  await expect(legend.locator('.er-legend__swatch').last()).toHaveCSS(
    'background-color',
    'rgb(228, 228, 228)',
  );

  // Relationship r1: label filled; layout routed the path through the author waypoints.
  const rel = page.locator('[data-mdp-id="r1"]');
  await expect(rel.locator('[data-role="external-text"]')).toHaveText('reads');
  await expect(rel.locator('[data-role="anchor"]')).toHaveAttribute('d', 'M340 35L400 35');

  for (const measure of result.measures) {
    expect(measure.body, measure.id).not.toBeNull();

    if (!CONNECTION_TAGS.has(measure.tag)) {
      expect(measure.body!.width, measure.id).toBeGreaterThan(0);
      expect(measure.body!.height, measure.id).toBeGreaterThan(0);
    }
  }

  // Apply positions nodes absolutely after resolving authored minimums against natural size.
  expect(result.layout.boxes['s1']).toMatchObject({ x: 200, y: 0, width: 140, height: 70 });
  await expect(page.locator('[data-mdp-id="s1"]')).toHaveCSS('position', 'absolute');
  expect(result.layout.boxes['i1']!.width).toBeGreaterThan(0);
});

test('connections: repeated shapes fill independently and conditional mounts stay absent', async ({
  page,
}) => {
  const result = await renderDocument(page, connectionsDocument);

  await expect(page.locator('[data-mdp-id="a"] .er-shape__text')).toHaveText(['A']);
  await expect(page.locator('[data-mdp-id="b"] .er-shape__text')).toHaveText(['B']);

  // Neither shape has a badge, so data-if removes the optional mount.
  await expect(page.locator('[data-use]')).toHaveCount(0);
  await expect(page.locator('[data-tpl="Badge"]')).toHaveCount(0);

  await expect(page.locator('[data-mdp-id="r1"] [data-role="external-text"]')).toHaveText(
    'links to',
  );
  await expect(page.locator('[data-mdp-id="r2"] [data-role="external-text"]')).toHaveText('self');
  // Layout filled both paths: r1 through its waypoints, r2 the self-loop through its own.
  await expect(page.locator('[data-mdp-id="r1"] [data-role="anchor"]')).toHaveAttribute(
    'd',
    'M100 25L300 25',
  );
  await expect(page.locator('[data-mdp-id="r2"] [data-role="anchor"]')).toHaveAttribute(
    'd',
    'M10 0L10 -14A6 6 0 0 1 16 -20L40 -20',
  );

  const shapeMeasures = result.measures.filter((m) => m.tag === 'Shape');
  expect(shapeMeasures).toHaveLength(2);

  for (const measure of shapeMeasures) {
    expect(measure.body!.width).toBeGreaterThan(0);
    expect(measure.body!.height).toBeGreaterThan(0);
  }
});

test('shape text uses neutral div runs and nested markdown lists keep their own semantics', async ({
  page,
}) => {
  const { payload, result } = await buildPayload({
    elements: [
      {
        tag: 'Shape',
        id: 'shape',
        x: 0,
        y: 0,
        texts: [{ text: 'Intro\n\n- one\n- two' }, { text: 'Detail' }],
      },
    ],
  });
  expect(result.ok, JSON.stringify(result.errors)).toBe(true);
  await runPayload(page, payload);

  const shape = page.locator('[data-mdp-id="shape"]');
  await expect(shape.locator('.er-shape__texts')).toHaveJSProperty('tagName', 'DIV');
  await expect(shape.locator('.er-shape__texts > .er-shape__text')).toHaveCount(2);
  await expect(shape.locator('.er-shape__text').first()).toHaveJSProperty('tagName', 'DIV');
  await expect(shape.locator('.er-shape__text').first().locator('ul > li')).toHaveText([
    'one',
    'two',
  ]);
});

test('shape icon and independently aligned text runs use the canvas side-icon lane', async ({
  page,
}) => {
  const { payload, result } = await buildPayload({
    elements: [
      {
        tag: 'Shape',
        id: 'mixed',
        x: 0,
        y: 0,
        width: 200,
        height: 100,
        icon: 'lucide-server',
        texts: [
          { text: 'Left', hAlign: 'left' },
          { text: 'Center', hAlign: 'center' },
          { text: 'Right', hAlign: 'right' },
        ],
      },
      {
        tag: 'Shape',
        id: 'padded',
        x: 250,
        y: 0,
        width: 200,
        height: 100,
        icon: 'lucide-server',
        iconPadding: 36,
        texts: [{ text: 'Label' }],
      },
      {
        tag: 'Shape',
        id: 'icon-only',
        x: 500,
        y: 0,
        width: 120,
        height: 60,
        icon: 'lucide-server',
      },
      {
        tag: 'Shape',
        id: 'top',
        x: 650,
        y: 0,
        width: 200,
        height: 100,
        icon: 'lucide-server',
        vAlign: 'top',
        vMargin: 24,
        texts: [{ text: 'Label' }],
      },
      {
        tag: 'Shape',
        id: 'bottom',
        x: 900,
        y: 0,
        width: 200,
        height: 100,
        icon: 'lucide-server',
        vAlign: 'bottom',
        vMargin: 24,
        texts: [{ text: 'Label' }],
      },
    ],
  });
  expect(result.ok, JSON.stringify(result.errors)).toBe(true);
  await runPayload(page, payload);

  const mixed = page.locator('[data-mdp-id="mixed"]');
  const body = await mixed.locator('[data-role="body"]').boundingBox();
  const icon = await mixed.locator('.er-shape__icon').boundingBox();
  const lane = await mixed.locator('.er-shape__texts').boundingBox();
  const runs = mixed.locator('.er-shape__text');
  const left = await textInkBox(runs.nth(0));
  const center = await textInkBox(runs.nth(1));
  const right = await textInkBox(runs.nth(2));

  expect(body).not.toBeNull();
  expect(icon).not.toBeNull();
  expect(lane).not.toBeNull();
  expect(Math.abs(icon!.x - body!.x - 20)).toBeLessThan(1.5);
  expect(Math.abs(lane!.x - body!.x - 55)).toBeLessThan(1.5);
  expect(Math.abs(body!.x + body!.width - (lane!.x + lane!.width) - 15)).toBeLessThan(1.5);
  expect(left.x).toBeCloseTo(lane!.x, 1);
  expect(center.x + center.width / 2).toBeCloseTo(lane!.x + lane!.width / 2, 1);
  expect(right.x + right.width).toBeCloseTo(lane!.x + lane!.width, 1);
  expect(icon!.y + icon!.height / 2).toBeCloseTo(lane!.y + lane!.height / 2, 1);

  const padded = page.locator('[data-mdp-id="padded"]');
  const paddedBody = await padded.locator('[data-role="body"]').boundingBox();
  const paddedIcon = await padded.locator('.er-shape__icon').boundingBox();
  expect(Math.abs(paddedIcon!.x - paddedBody!.x - 36)).toBeLessThan(1.5);

  const iconOnly = page.locator('[data-mdp-id="icon-only"]');
  const iconOnlyBody = await iconOnly.locator('[data-role="body"]').boundingBox();
  const iconOnlyGlyph = await iconOnly.locator('.er-shape__icon').boundingBox();
  expect(iconOnlyGlyph!.x + iconOnlyGlyph!.width / 2).toBeCloseTo(
    iconOnlyBody!.x + iconOnlyBody!.width / 2,
    1,
  );

  const top = page.locator('[data-mdp-id="top"]');
  const topBody = await top.locator('[data-role="body"]').boundingBox();
  const topIcon = await top.locator('.er-shape__icon').boundingBox();
  const topTexts = await top.locator('.er-shape__texts').boundingBox();
  expect(Math.abs(Math.min(topIcon!.y, topTexts!.y) - topBody!.y - 24)).toBeLessThan(1.5);
  expect(topIcon!.y + topIcon!.height / 2).toBeCloseTo(topTexts!.y + topTexts!.height / 2, 1);

  const bottom = page.locator('[data-mdp-id="bottom"]');
  const bottomBody = await bottom.locator('[data-role="body"]').boundingBox();
  const bottomIcon = await bottom.locator('.er-shape__icon').boundingBox();
  const bottomTexts = await bottom.locator('.er-shape__texts').boundingBox();
  const bottomContent = Math.max(
    bottomIcon!.y + bottomIcon!.height,
    bottomTexts!.y + bottomTexts!.height,
  );
  expect(Math.abs(bottomBody!.y + bottomBody!.height - bottomContent - 24)).toBeLessThan(1.5);
});

test('authored group width constrains its title while title overflow grows height', async ({
  page,
}) => {
  const { payload, result } = await buildPayload({
    elements: [
      {
        tag: 'Group',
        id: 'group',
        x: 0,
        y: 0,
        width: 80,
        height: 10,
        title: { text: 'AAAAAAAAAA', typeface: 'rough' },
      },
    ],
  });
  expect(result.ok, JSON.stringify(result.errors)).toBe(true);
  const run = await runPayload(
    page,
    payload,
    await stageFonts({
      roles: { rough: 'AhemTest', clean: 'MonoTest', mono: 'MonoTest' },
      faces: [
        { kind: 'file', family: 'AhemTest', path: AHEM_PATH },
        { kind: 'file', family: 'MonoTest', path: AHEM_PATH },
      ],
    }),
  );

  const body = run.measures[0]!.body!;
  const title = run.measures[0]!.parts['title']![0]!;
  expect(body.width).toBe(80);
  expect(body.height).toBeGreaterThan(10);
  expect(title.x).toBeGreaterThanOrEqual(0);
  expect(title.x + title.width).toBeLessThanOrEqual(body.width);
  expect(run.layout.boxes['group']!.width).toBe(Math.ceil(body.width));
  await expect(page.locator('.er-grouplike__title-text')).toHaveCSS('font-family', /AhemTest/);
});

test('shape balanced text policy wraps at authored width, then grows modestly past three lines', async ({
  page,
}) => {
  const text = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const { payload, result } = await buildPayload({
    elements: [
      { tag: 'Shape', id: 'shape', x: 0, y: 0, width: 100, height: 30, texts: [{ text }] },
    ],
  });
  expect(result.ok, JSON.stringify(result.errors)).toBe(true);
  const run = await runPayload(page, payload, await stageAhem());
  const body = run.measures[0]!.body!;
  const label = run.measures[0]!.roles['internal-text']![0]!;

  expect(body.width).toBeGreaterThan(100);
  expect(body.width).toBeLessThan(text.length * 15);
  expect(body.height).toBeGreaterThan(30);
  expect(label.width).toBeLessThan(body.width);
  await expect(page.locator('.er-shape__text')).toHaveCSS('overflow-wrap', 'break-word');
});

test('missing authored width uses the renderer fallback for stock policy-aware text', async ({
  page,
}) => {
  const longText = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const { payload, result } = await buildPayload({
    elements: [
      {
        tag: 'Group',
        id: 'group',
        x: 0,
        y: 0,
        title: { text: 'AAAAAAAAAA', typeface: 'rough' },
      },
      { tag: 'Textbox', id: 'textbox', x: 200, y: 0, text: 'AAAA AAAA' },
      { tag: 'Shape', id: 'shape', x: 400, y: 0, texts: [{ text: longText }] },
    ],
  });
  expect(result.ok, JSON.stringify(result.errors)).toBe(true);

  const run = await runPayload(page, payload, await stageAhem());
  const boxes = run.layout.boxes;

  expect(boxes['group']!.width).toBe(100);
  expect(boxes['textbox']!.width).toBe(100);
  expect(boxes['textbox']!.height).toBeGreaterThan(15);
  expect(boxes['shape']!.width).toBeGreaterThan(100);
  expect(boxes['shape']!.width).toBeLessThan(longText.length * 15);
});

test('an authored width one word short widens instead of breaking the word', async ({ page }) => {
  const { payload, result } = await buildPayload({
    elements: [
      { tag: 'Textbox', id: 'near', x: 0, y: 0, width: 70, text: 'AAAA AAAA', fontSize: 20 },
      { tag: 'Textbox', id: 'far', x: 200, y: 0, width: 40, text: 'AAAAAAAAAA', fontSize: 20 },
    ],
  });
  expect(result.ok, JSON.stringify(result.errors)).toBe(true);
  const run = await runPayload(page, payload, await stageAhem());
  const boxes = run.layout.boxes;

  // 'AAAA' is 4 em at 20px, just past the authored 70: a metric mismatch, so the box grows.
  expect(boxes['near']!.width).toBeGreaterThanOrEqual(79);
  expect(boxes['near']!.width).toBeLessThan(90);
  // Ten em against an authored 40 is no mismatch — that word cannot fit and still breaks.
  expect(boxes['far']!.width).toBe(40);
});

test('a wrapped connection label straddles the line its stored placement centred it on', async ({
  page,
}) => {
  const { payload, result } = await buildPayload({
    elements: [
      { tag: 'Shape', id: 'a', x: 0, y: 0, width: 100, height: 50, texts: [{ text: 'A' }] },
      { tag: 'Shape', id: 'b', x: 300, y: 0, width: 100, height: 50, texts: [{ text: 'B' }] },
      {
        tag: 'Relationship',
        id: 'r',
        from: 'a',
        to: 'b',
        points: [
          { x: 100, y: 25 },
          { x: 300, y: 25 },
        ],
        label: 'AAAA AAAA AAAA',
        labelPlacement: { x: 150, y: 16, width: 60, height: 18 },
      },
    ],
  });
  expect(result.ok, JSON.stringify(result.errors)).toBe(true);
  const run = await runPayload(page, payload, await stageAhem());
  const connection = run.layout.connections['r']!;

  // One word per line, never a broken one: three lines for three words.
  expect(connection.labelBox!.height).toBeGreaterThan(40);
  expect(connection.labelBox!.height).toBeLessThan(60);
  // Stored centre (180, 25) survives the taller painted box.
  expect(connection.label.x).toBeCloseTo(180);
  expect(connection.label.y).toBeCloseTo(25);
});

test('stock connection labels keep transparent horizontal spacing', async ({ page }) => {
  const { payload, result } = await buildPayload({
    elements: [
      {
        tag: 'Shape',
        id: 'a',
        x: 0,
        y: 0,
        width: 100,
        height: 50,
        texts: [{ text: 'A' }],
      },
      {
        tag: 'Shape',
        id: 'b',
        x: 300,
        y: 0,
        width: 100,
        height: 50,
        texts: [{ text: 'B' }],
      },
      {
        tag: 'Relationship',
        id: 'relationship',
        from: 'a',
        to: 'b',
        points: [
          { x: 100, y: 20 },
          { x: 300, y: 20 },
        ],
        label: 'relationship',
      },
      {
        tag: 'DatabaseRelationship',
        id: 'database-relationship',
        from: 'a',
        to: 'b',
        points: [
          { x: 100, y: 35 },
          { x: 300, y: 35 },
        ],
        label: 'database relationship',
      },
    ],
  });
  expect(result.ok, JSON.stringify(result.errors)).toBe(true);
  await runPayload(page, payload);

  for (const id of ['relationship', 'database-relationship']) {
    const label = page.locator(`[data-mdp-id="${id}"] [data-role="external-text"]`);
    await expect(label).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(label).toHaveCSS('padding-left', '2px');
    await expect(label).toHaveCSS('padding-right', '2px');
  }
});

test('hostile text renders as inert visible text — zero script execution', async ({ page }) => {
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });

  await renderFixture(page, 'unicode-and-hostile-text');

  // The payloads are visible as literal text (decoded once from the escaped props)...
  const texts = page.locator('[data-mdp-id="hostile"] .er-shape__text');
  await expect(texts.nth(0)).toHaveText('</script><script>alert(document.cookie)</script>');
  await expect(texts.nth(1)).toHaveText('<img src=x onerror=alert(1)>');
  await expect(texts.nth(2)).toContainText('Unicode: ☃ 你好 𝕏 café — “quotes” & <b>bold</b>');

  // ...and never became live markup.
  await expect(page.locator('#eraser-scene script, #eraser-scene img')).toHaveCount(0);
  expect(dialogs).toEqual([]);
});

test('markdown renders as markup, split block vs inline per the canvas policy', async ({
  page,
}) => {
  const { payload, result } = await buildPayload({
    elements: [
      {
        tag: 'Textbox',
        id: 'tb',
        x: 0,
        y: 0,
        text: '# Head\n\n- one\n- two\n\n**bold** [link](https://x.io)',
      },
      { tag: 'Shape', id: 's', x: 0, y: 300, texts: [{ text: '**svc**' }] },
      { tag: 'Shape', id: 's2', x: 300, y: 300, width: 120, height: 60, badge: { text: '# 1' } },
    ],
  });
  expect(result.ok, JSON.stringify(result.errors)).toBe(true);
  await runPayload(page, payload);

  // Block policy (Textbox): headings, lists, marks, links become real elements.
  const tb = page.locator('[data-mdp-id="tb"] .er-md');
  await expect(tb.locator('h1')).toHaveText('Head');
  await expect(tb.locator('li')).toHaveText(['one', 'two']);
  await expect(tb.locator('strong')).toHaveText('bold');
  await expect(tb.locator('a')).toHaveAttribute('href', 'https://x.io');

  // Block policy on shape text runs.
  await expect(page.locator('[data-mdp-id="s"] .er-shape__texts strong')).toHaveText('svc');

  // Inline policy (Badge): marks parse, block starters stay literal.
  const badge = page.locator('[data-mdp-id="s2"] [data-tpl="Badge"]');
  await expect(badge).toContainText('# 1');
  await expect(badge.locator('h1')).toHaveCount(0);
});

test('watercolor: texture stain mounts as the body via a shared tinted master', async ({
  page,
}) => {
  const { payload, result } = await buildPayload({
    elements: [
      {
        tag: 'Shape',
        id: 'w',
        x: 0,
        y: 0,
        width: 160,
        height: 80,
        styleMode: 'watercolor',
        color: 'blue',
      },
      {
        tag: 'Shape',
        id: 'hex',
        x: 400,
        y: 0,
        width: 160,
        height: 80,
        shape: 'hexagon',
        styleMode: 'watercolor',
        color: 'red',
      },
      {
        // Non-hex pigment: converted to hex at resolve time, so it textures like any other.
        tag: 'Shape',
        id: 'blob',
        x: 200,
        y: 0,
        width: 160,
        height: 80,
        styleMode: 'watercolor',
        bgColor: 'rgb(120, 140, 220)',
      },
      { tag: 'Shape', id: 'p', x: 600, y: 0, width: 160, height: 80, color: 'blue' },
    ],
  });
  expect(result.ok, JSON.stringify(result.errors)).toBe(true);
  await runPayload(page, payload);

  // The prephase registered one tinted master per pigment pair, as shared symbols (the rgb()
  // pigment converts to hex and gets its own).
  await expect(page.locator('#eraser-scene symbol[id^="er-wash-"]')).toHaveCount(3);

  // CSS-geometry kind: the master fills the inner box; the body fill itself goes transparent.
  const washtex = page.locator('[data-mdp-id="w"] .er-washtex use');
  await expect(washtex).toHaveCount(1);
  await expect(washtex).toHaveAttribute('href', /^#er-wash-\d+$/);
  await expect(page.locator('[data-mdp-id="w"] .er-shape__inner')).toHaveCSS(
    'background-color',
    'rgba(0, 0, 0, 0)',
  );

  // Polygon kind: the master clips to the dynamic geometry path inside the geo svg.
  const geoUse = page.locator('[data-mdp-id="hex"] .er-shape__geo--dynamic use');
  await expect(geoUse).toHaveCount(1);
  await expect(geoUse).toHaveAttribute('href', /^#er-wash-\d+$/);

  // Non-hex pigment: rgb(120, 140, 220) canonicalizes to #788cdc and textures like hex.
  const converted = page.locator('[data-mdp-id="blob"] .er-washtex use');
  await expect(converted).toHaveCount(1);
  await expect(converted).toHaveAttribute('href', /^#er-wash-\d+$/);
  await expect(page.locator('[data-mdp-id="blob"] .er-shape__inner')).toHaveCSS(
    'background-color',
    'rgba(0, 0, 0, 0)',
  );

  // Default (shadow) shapes mount no wash markup of any kind.
  await expect(page.locator('[data-mdp-id="p"] .er-washtex')).toHaveCount(0);
});

test('rounded polygon geometry mounts at real size; auto-sized falls back to static', async ({
  page,
}) => {
  const { payload, result } = await buildPayload({
    elements: [
      { tag: 'Shape', id: 'hex', x: 0, y: 0, width: 140, height: 100, shape: 'hexagon' },
      { tag: 'Shape', id: 'auto', x: 200, y: 0, shape: 'hexagon', texts: [{ text: 'x' }] },
    ],
  });
  expect(result.ok, JSON.stringify(result.errors)).toBe(true);
  await runPayload(page, payload);

  const dynamic = page.locator('[data-mdp-id="hex"] .er-shape__geo--dynamic');
  await expect(dynamic).toHaveAttribute('viewBox', '0 0 140 100');
  await expect(dynamic.locator('path')).toHaveAttribute('d', /^M.+A.+Z$/);
  await expect(
    page.locator('[data-mdp-id="hex"] .er-shape__geo:not(.er-shape__geo--dynamic)'),
  ).toHaveCount(0);

  // Auto-sized: static 0-100 geometry, no dynamic svg.
  await expect(page.locator('[data-mdp-id="auto"] .er-shape__geo--dynamic')).toHaveCount(0);
  await expect(
    page.locator('[data-mdp-id="auto"] .er-shape__geo .er-shape__path--hexagon'),
  ).toHaveCount(1);
});

test('fonts are applied before measurement: ink widths follow exact Ahem arithmetic', async ({
  page,
}) => {
  // Ahem draws every glyph as a full em square, so at the stock Textbox's 15px 'AAAA' measures
  // exactly 60px — but only if the injected FontFace was loaded AND applied before measureScene
  // ran. A fallback platform font yields a different width and fails this test.
  const { payload, result } = await buildPayload({
    elements: [{ tag: 'Textbox', id: 't', x: 0, y: 0, text: 'AAAA' }],
  });
  expect(result.ok).toBe(true);

  const run = await runPayload(page, payload, await stageAhem());

  // 4 × 15px em squares minus the stock -0.01em letter-spacing ⇒ ~59.4px. A fallback platform
  // font (or the 16px default from an unresolved font var) lands well outside this band.
  const body = run.measures[0]!.body!;
  expect(body.width).toBeGreaterThan(59);
  expect(body.width).toBeLessThan(60.01);

  // Belt: the family really was loaded (not falling back) at measure time.
  expect(await page.evaluate(() => document.fonts.check('16px "AhemTest"'))).toBe(true);
});

test('typeface prop switches the font role per Shape text run; absent uses the Shape default', async ({
  page,
}) => {
  const { payload, result } = await buildPayload({
    elements: [
      {
        tag: 'Shape',
        id: 's',
        x: 0,
        y: 0,
        texts: [{ text: 'plain' }, { text: 'coded', typeface: 'mono' }],
      },
    ],
  });
  expect(result.ok).toBe(true);

  // Roles map to two distinct families so the resolved font names the chosen role.
  const staged = await stageFonts({
    roles: { rough: 'AhemTest', clean: 'AhemTest', mono: 'MonoTest' },
    faces: [
      { kind: 'file', family: 'AhemTest', path: AHEM_PATH },
      { kind: 'file', family: 'MonoTest', path: AHEM_PATH },
    ],
  });
  await runPayload(page, payload, staged);

  const runs = page.locator('[data-tpl="Shape"] .er-shape__text');
  await expect(runs.nth(0)).toHaveCSS('font-family', /AhemTest/);
  await expect(runs.nth(1)).toHaveCSS('font-family', /MonoTest/);
});

test('two-pass measure: intrinsic vs resolved size, data-part boxes, ink extent', async ({
  page,
}) => {
  // Ahem: 8 'A's at 16px = 128px natural width. The authored 80px is a minimum, so the body
  // grows to the intrinsic width rather than clipping the text. The box-shadow extends ink.
  const { payload, result } = await buildPayload(
    {
      elements: [{ tag: 'Textbox', id: 't', x: 0, y: 0, width: 80, height: 40, text: 'AAAAAAAA' }],
    },
    {
      overrides: {
        templates: [
          {
            name: 'Textbox',
            html: '<template name="Textbox"><div data-tpl="Textbox" data-role="body"><p data-part="line">{{text}}</p></div></template>',
            css: 'p{margin:0;box-shadow:4px 4px 0 0 #e8e8e8}',
          },
        ],
      },
    },
  );
  expect(result.ok).toBe(true);

  const run = await runPayload(page, payload, await stageAhem());
  const measure = run.measures[0]!;

  expect(measure.intrinsic.width).toBe(128);
  expect(measure.body!.width).toBe(128);
  expect(measure.parts['line']![0]!.width).toBe(128);
  expect(measure.ink).toMatchObject({ x: 0, y: 0, width: 132, height: 40 });
});

test('containment: flat DOM, containers paint behind members, content union reported', async ({
  page,
}) => {
  const { payload, result } = await buildPayload({
    elements: [
      { tag: 'Group', id: 'g', x: 0, y: 0, width: 300, height: 200 },
      { tag: 'Shape', id: 's', x: 20, y: 30, width: 100, height: 50, containerId: 'g' },
    ],
  });
  expect(result.ok, JSON.stringify(result.errors)).toBe(true);

  const run = await runPayload(page, payload);

  // Flat DOM: both wrappers are direct scene children.
  await expect(page.locator('#eraser-scene > [data-mdp-id]')).toHaveCount(2);

  const zOf = (id: string) =>
    page
      .locator(`[data-mdp-id="${id}"]`)
      .evaluate((el) => Number((el as HTMLElement).style.zIndex));
  expect(await zOf('g')).toBeLessThan(await zOf('s'));

  const group = run.measures.find((m) => m.id === 'g')!;
  expect(group.content).toMatchObject({ x: 20, y: 30, width: 100, height: 50 });
});

test('isolation: identically-named selectors in sibling templates never collide', async ({
  page,
}) => {
  const { payload, result } = await buildPayload(
    {
      elements: [
        { tag: 'Shape', id: 's', x: 0, y: 0 },
        { tag: 'Icon', id: 'i', x: 200, y: 0, icon: 'lucide-server' },
      ],
    },
    {
      overrides: {
        templates: [
          {
            name: 'Shape',
            html: '<template name="Shape"><div data-tpl="Shape" data-role="body"><span class="title">x</span></div></template>',
            css: '.title{color:rgb(255, 0, 0)}',
          },
          {
            name: 'Icon',
            html: '<template name="Icon"><div data-tpl="Icon" data-role="body"><span class="title">y</span></div></template>',
            css: '.title{color:rgb(0, 0, 255)}',
          },
        ],
      },
    },
  );
  expect(result.ok).toBe(true);
  await runPayload(page, payload);

  await expect(page.locator('[data-tpl="Shape"] .title')).toHaveCSS('color', 'rgb(255, 0, 0)');
  await expect(page.locator('[data-tpl="Icon"] .title')).toHaveCSS('color', 'rgb(0, 0, 255)');
});

test('isolation: nested templates are walled off from their host template CSS — both directions', async ({
  page,
}) => {
  // Shape's own markup reuses Badge's root class name and its CSS tries to restyle it. The scope
  // boundary must keep Shape's rule on Shape's own span only, and Badge's stock CSS
  // (border-radius, --er-badge background) on Badge only.
  const { payload, result } = await buildPayload(
    { elements: [{ tag: 'Shape', id: 's', x: 0, y: 0, badge: { text: '3' } }] },
    {
      overrides: {
        templates: [
          {
            name: 'Shape',
            html: '<template name="Shape"><div data-tpl="Shape" data-role="body"><span class="er-badge">shape-owned</span><span data-use="Badge" data-props="badge" data-if="badge"></span></div></template>',
            css: '.er-badge{background:rgb(255, 0, 0)}',
          },
        ],
      },
    },
  );
  expect(result.ok).toBe(true);
  await runPayload(page, payload);

  const shapeOwned = page.locator('[data-tpl="Shape"] span.er-badge:not([data-tpl])');
  const badge = page.locator('[data-tpl="Badge"]');

  // Shape's rule applies to Shape's own span, not to the nested Badge root.
  await expect(shapeOwned).toHaveCSS('background-color', 'rgb(255, 0, 0)');
  await expect(badge).toHaveText('3');
  // Stock badge over an uncolored host: no --er-tint is published, so the white fallback stands.
  await expect(badge).toHaveCSS('background-color', 'rgb(255, 255, 255)');

  // And Badge's stock CSS does not leak out onto Shape's identically-classed span.
  await expect(badge).toHaveCSS('border-top-left-radius', '5px');
  await expect(shapeOwned).toHaveCSS('border-top-left-radius', '0px');
});
