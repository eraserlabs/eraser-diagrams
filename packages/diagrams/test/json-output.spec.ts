import { test, expect } from '@playwright/test';
import { stubIconLoader } from './support/stubIcons.js';
import { createRenderer, type AuthoredLibrary, type Renderer } from '../src/index.js';
import { stockLibrary, STOCK_PALETTE } from '../src/library/index.js';
import { CHROMIUM_PATH } from './support/browser.js';

/**
 * The measured-JSON purity invariant: **the json output is the authored document verbatim, plus
 * measured geometry. Nothing else.**
 *
 * The point is portability across libraries. A measured document is a document to re-submit, and
 * a document outlives the library that measured it — so anything the library interpreted (a
 * translated palette color, a derived prop, a defaulted field, a sanitized string) would freeze
 * the old library's opinion into the author's own data. The library-swap test below is the direct
 * proof: the same json, rendered against a library whose palette maps the same token names to
 * different colors, must come out in the NEW colors.
 */

const DOC = {
  entities: [
    {
      tag: 'Shape',
      id: 'api',
      x: 40,
      y: 40,
      width: 160,
      height: 80,
      color: 'blue',
      styleMode: 'watercolor',
      texts: [{ text: 'API' }],
      badge: { text: '3' },
    },
    {
      tag: 'Icon',
      id: 'db',
      x: 320,
      y: 40,
      // Round-tripping a preset token as a token — not as the px some stylesheet chose for it —
      // is the same invariant seen from the sizing side.
      size: 'md',
      icon: 'lucide-server',
      texts: [{ text: 'Store' }],
    },
    {
      tag: 'Group',
      id: 'zone',
      x: 20,
      y: 20,
      width: 460,
      height: 140,
      color: 'green',
      title: { text: 'Zone', width: 'full' },
    },
  ],
  connections: [{ tag: 'Relationship', from: 'api', to: 'db', label: 'reads' }],
} as const;

let diagrams: Renderer;

test.beforeAll(async () => {
  diagrams = await createRenderer({
    library: stockLibrary,
    chromiumPath: CHROMIUM_PATH,
    iconLoader: stubIconLoader,
  });
});

test.afterAll(async () => {
  await diagrams.close();
});

test('idempotence: render → json → re-render the json → identical output, tokens intact', async () => {
  const first = await diagrams.render({ ...DOC, outputs: { json: true } });
  expect(first.ok).toBe(true);

  if (!first.ok) {
    return;
  }

  // The authored vocabulary survived the round trip: a palette token is still a token, and a
  // size preset is still a preset.
  expect(first.json.entities[0]!.color).toBe('blue');
  expect(first.json.entities[1]!.size).toBe('md');
  expect(first.json.entities[2]!.color).toBe('green');
  // Nothing was invented: the connection's author omitted an id, so the output has none.
  expect(first.json.connections[0]).not.toHaveProperty('id');
  // …and the measured overlay is there.
  expect(first.json.entities[0]!.width).toBeGreaterThan(0);
  expect(first.json.connections[0]!.points).toBeDefined();

  // The measured document is a fixed point of the whole pipeline: re-submitting it produces
  // itself, byte for byte, tokens included. (The rendered markup is not yet a fixed point —
  // size-derived template props are stamped at authored size; that gap is pinned separately in
  // echo-idempotence.spec.ts.)
  const second = await diagrams.render({ ...first.json, outputs: { json: true } });
  expect(second.ok).toBe(true);

  if (!second.ok) {
    return;
  }

  expect(second.json).toEqual(first.json);

  const third = await diagrams.render({ ...second.json, outputs: { json: true } });
  expect(third.ok && third.json).toEqual(second.json);
});

test('library swap: the same json re-renders in the NEW palette, not the measured one', async () => {
  const measured = await diagrams.render({ ...DOC, outputs: { json: true, html: true } });
  expect(measured.ok).toBe(true);

  if (!measured.ok) {
    return;
  }

  // Same token names, different colors — the only change between the two libraries.
  const repainted: AuthoredLibrary = {
    ...stockLibrary,
    palette: { ...STOCK_PALETTE, blue: '#b8860b', green: '#8b008b' },
  };
  const other = await createRenderer({
    library: repainted,
    chromiumPath: CHROMIUM_PATH,
    iconLoader: stubIconLoader,
  });

  try {
    const swapped = await other.render({ ...measured.json, outputs: { html: true } });
    expect(swapped.ok).toBe(true);

    if (!swapped.ok) {
      return;
    }

    // The new library's colors reached the markup, and the old library's did not.
    expect(swapped.html).toContain('--er-color: #b8860b');
    expect(swapped.html).toContain('--er-color: #8b008b');
    expect(swapped.html).not.toContain(STOCK_PALETTE['blue']);
    expect(swapped.html).not.toContain(STOCK_PALETTE['green']);
    // A frozen color would have made this render identical to the measured one.
    expect(swapped.html).not.toBe(measured.html);
  } finally {
    await other.close();
  }
});

test('purity: a watercolor shape carries no derived prop into the json', async () => {
  const outcome = await diagrams.render({ ...DOC, outputs: { json: true } });
  expect(outcome.ok).toBe(true);

  if (!outcome.ok) {
    return;
  }

  const [shape, icon, group] = outcome.json.entities;
  const derived = [
    'fillColor',
    'fillMode',
    'borderColor',
    'washColor',
    'washTexCss',
    'washTexGeo',
    'washUid',
    'washShade',
    'washMid',
    'geoPath',
    'geoW',
    'geoH',
    'staticGeo',
    'outline',
    'textAspectRatio',
    'vAlign',
    'vMargin',
    'iconColor',
    'sizePx',
    'titleStyle',
    'titleRule',
    'titleBgColor',
    'titleColor',
    'titleHAlign',
    'titleIconColor',
    'dividerColor',
  ];

  for (const key of derived) {
    expect(shape, `Shape leaked "${key}"`).not.toHaveProperty(key);
    expect(icon, `Icon leaked "${key}"`).not.toHaveProperty(key);
    expect(group, `Group leaked "${key}"`).not.toHaveProperty(key);
  }

  // Defaults the normalizers apply to the clone stay on the clone.
  expect(shape).not.toHaveProperty('lineWidthPx');
  expect(outcome.json.connections[0]).not.toHaveProperty('lineWidthPx');
  expect(outcome.json.connections[0]).not.toHaveProperty('endArrowhead');
  expect(outcome.json.connections[0]).not.toHaveProperty('color');
  // The authored keys, and only those plus the overlay, survive.
  expect(Object.keys(shape!).sort()).toEqual(
    ['badge', 'color', 'height', 'id', 'styleMode', 'tag', 'texts', 'width', 'x', 'y'].sort(),
  );
});
