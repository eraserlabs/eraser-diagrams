import { test, expect } from '@playwright/test';
import { stubIconLoader } from './support/stubIcons.js';
import { createRenderer } from '../src/index.js';
import { CHROMIUM_PATH } from './support/browser.js';
import {
  buildPayload,
  runPayload,
  type ElementMeasure,
  type RunResult,
} from './support/payload.js';
import {
  CARD_WIDTH,
  cardHeight,
  kanbanLibrary,
  kanbanNormalizers,
  kanbanScene,
} from './support/kanban.js';

/**
 * The browser path against a foreign vocabulary. Measurement is driven by the dialect's `data-role`
 * / `data-part` attributes and layout by the measured boxes — neither knows a stock tag name, and
 * these assertions are exact numbers derived from the fixture's own CSS.
 */

const BUILD = { library: kanbanLibrary, normalizers: kanbanNormalizers };

function measureOf(run: RunResult, id: string): ElementMeasure {
  const measure = run.measures.find((m) => m.id === id);

  if (!measure) {
    throw new Error(`no measure for "${id}"`);
  }

  return measure;
}

test('custom templates measure through data-role / data-part', async ({ page }) => {
  const { payload, result } = await buildPayload(kanbanScene, BUILD);
  expect(result.ok, JSON.stringify(result.errors)).toBe(true);

  const run = await runPayload(page, payload);
  const cardA = measureOf(run, 'card-a');

  // Intrinsic box is the template's own content stack, not an author-declared size.
  expect(cardA.intrinsic).toMatchObject({
    width: CARD_WIDTH,
    height: cardHeight({ checks: 2, pill: true }),
  });
  expect(cardA.body).toMatchObject({ width: CARD_WIDTH });

  // Parts are reported per custom name, including the one inside the composed sub-template.
  expect(cardA.parts['head']).toHaveLength(1);
  expect(cardA.parts['check']).toHaveLength(2);
  expect(cardA.parts['pill']).toHaveLength(1);
  expect(cardA.roles['internal-text']).toHaveLength(1);

  // The icon reached the slot named by a non-stock prop (`glyph`).
  await expect(page.locator('[data-mdp-id="card-a"] .kb-card__glyph svg')).toHaveCount(1);

  const flow = measureOf(run, 'flow-1');
  expect(flow.roles['anchor']).toHaveLength(1);
  expect(flow.parts['caption']).toHaveLength(1);
});

test('custom vocabulary lays out: measured boxes, containment, center-to-center connection', async ({
  page,
}) => {
  const { payload, result } = await buildPayload(kanbanScene, BUILD);
  expect(result.ok, JSON.stringify(result.errors)).toBe(true);

  const run = await runPayload(page, payload);

  // Authored minimums win when larger (Column); measured intrinsic fills in otherwise (Cards).
  expect(run.layout.boxes['todo']).toEqual({ x: 0, y: 0, width: 240, height: 200 });
  expect(run.layout.boxes['card-a']).toEqual({
    x: 20,
    y: 40,
    width: CARD_WIDTH,
    height: cardHeight({ checks: 2, pill: true }),
  });
  expect(run.layout.boxes['card-b']).toEqual({
    x: 400,
    y: 60,
    width: CARD_WIDTH,
    height: cardHeight({ checks: 1 }),
  });

  // Connection is routed face-to-face between the two measured cards, orthogonally.
  expect(run.layout.connections['flow-1']!.d).toBe('M180 83L400 83');

  // Containment stays a flat-DOM paint order, keyed off containerId alone.
  await expect(page.locator('#eraser-scene > [data-mdp-id]')).toHaveCount(4);
  const zOf = (id: string): Promise<number> =>
    page
      .locator(`[data-mdp-id="${id}"]`)
      .evaluate((el) => Number((el as HTMLElement).style.zIndex));
  expect(await zOf('todo')).toBeLessThan(await zOf('card-a'));
});

test('author waypoints are adopted verbatim, diagonals are re-routed', async ({ page }) => {
  const scene = (points: Array<{ x: number; y: number }>): { elements: unknown[] } => ({
    elements: [
      { tag: 'Card', id: 'a', x: 0, y: 0, title: 'a' },
      { tag: 'Card', id: 'b', x: 300, y: 0, title: 'b' },
      { tag: 'Flow', id: 'f', from: 'a', to: 'b', points },
    ],
  });

  // Orthogonal and clear of both cards: the router adopts this geometry as authored.
  const authored = await buildPayload(
    scene([
      { x: 160, y: 26 },
      { x: 230, y: 26 },
      { x: 230, y: 120 },
      { x: 300, y: 120 },
    ]),
    BUILD,
  );
  expect(authored.result.ok, JSON.stringify(authored.result.errors)).toBe(true);
  expect((await runPayload(page, authored.payload)).layout.connections['f']!.d).toBe(
    'M160 26L230 26L230 120L300 120',
  );

  // A diagonal is geometry the router cannot adopt — it comes back orthogonal instead.
  const diagonal = await buildPayload(
    scene([
      { x: 10, y: 10 },
      { x: 290, y: 200 },
    ]),
    BUILD,
  );
  const rerouted = (await runPayload(page, diagonal.payload)).layout.connections['f']!.d;
  expect(rerouted).not.toContain('L290 200');
  expect(rerouted).toBe('M160 20L300 20');
});

test('the conductor renders a scene in a vocabulary it has never seen', async () => {
  const diagrams = await createRenderer({
    chromiumPath: CHROMIUM_PATH,
    library: kanbanLibrary,
    normalizers: kanbanNormalizers,
    iconLoader: stubIconLoader,
  });

  try {
    // The stock vocabulary is gone: only the custom tags dispatch.
    const stock = await diagrams.validate({ elements: [{ tag: 'Shape', id: 's', x: 0, y: 0 }] });
    expect(stock.ok).toBe(false);
    expect(diagrams.registryInfo().tags.map((t) => t.tag)).toEqual(['Column', 'Card', 'Flow']);

    const outcome = await diagrams.render({
      ...kanbanScene,
      outputs: { html: true },
    });
    expect(outcome.ok, outcome.ok ? '' : JSON.stringify(outcome.errors)).toBe(true);

    if (!outcome.ok) {
      return;
    }

    expect(outcome.html).toContain('data-tpl="Card"');
    // Derived accent from the custom normalizer, and the sanitized title, both survive to output.
    expect(outcome.html).toContain('--er-accent: #ef4444');
    expect(outcome.html).toContain('Swap &lt;b&gt;schema&lt;/b&gt;');
    expect(outcome.html).not.toContain('<b>schema</b>');

    const png = await diagrams.render(kanbanScene);
    expect(png.ok).toBe(true);
  } finally {
    await diagrams.close();
  }
});
