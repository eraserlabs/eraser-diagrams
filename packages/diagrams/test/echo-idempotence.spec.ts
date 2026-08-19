import { test, expect, type Page } from '@playwright/test';
import { buildPayload, runPayload, type RenderPayload, type RunResult } from './support/payload.js';

/**
 * The size-echo contract: rendering returns final boxes, and feeding those boxes back as the
 * authored width/height must be a FIXED POINT — same sizes (holds today: the text solver only
 * grows from the authored floor, so a returned size re-enters as its own solution) and the same
 * scene markup (pinned below as an expected failure: size-derived template props — geoPath,
 * viewBox — are stamped at authored size and never re-derived at the final size, so a no-op echo
 * currently changes the drawing. Flips green when the echo/refit pass lands).
 */

const ELEMENTS = [
  {
    tag: 'Shape',
    id: 'grown',
    x: 0,
    y: 0,
    width: 60,
    height: 40,
    shape: 'hexagon',
    styleMode: 'plain',
    texts: [{ text: 'an_unbreakable_service_identifier_wider_than_the_box' }],
  },
  {
    tag: 'Shape',
    id: 'stable',
    x: 400,
    y: 0,
    width: 160,
    height: 80,
    shape: 'rectangle',
    styleMode: 'plain',
    texts: [{ text: 'fits' }],
  },
];

const INPUT = { elements: ELEMENTS };

function boxesOf(run: RunResult): Record<string, { width: number; height: number }> {
  return Object.fromEntries(
    Object.entries(run.layout.boxes).map(([id, box]) => [
      id,
      { width: box.width, height: box.height },
    ]),
  );
}

function echoedInput(boxes: Record<string, { width: number; height: number }>): {
  elements: unknown[];
} {
  return {
    elements: ELEMENTS.map((element) => {
      const box = boxes[element.id];

      return box ? { ...element, width: box.width, height: box.height } : element;
    }),
  };
}

async function renderOnce(
  page: Page,
  input: unknown,
): Promise<{ run: RunResult; scene: string; payload: RenderPayload }> {
  const { payload, result } = await buildPayload(input);
  expect(result.ok, JSON.stringify(result.errors)).toBe(true);
  const run = await runPayload(page, payload);
  const scene = await page.evaluate(() => window.__eraser.serialize().scene);

  return { run, scene, payload };
}

test('echoed sizes are a fixed point of the size solver', async ({ page }) => {
  const first = await renderOnce(page, INPUT);
  const firstBoxes = boxesOf(first.run);

  // The premise: the solver actually grew the overflowing element past its authored width.
  expect(firstBoxes['grown']!.width).toBeGreaterThan(65);
  expect(firstBoxes['stable']!.width).toBeCloseTo(160, 0);

  // Echo pass: returned sizes re-enter as authored sizes and must reproduce themselves.
  const second = await renderOnce(page, echoedInput(firstBoxes));
  const secondBoxes = boxesOf(second.run);

  for (const id of Object.keys(firstBoxes)) {
    expect(secondBoxes[id]!.width, `${id} width drifted on echo`).toBeCloseTo(
      firstBoxes[id]!.width,
      0,
    );
    expect(secondBoxes[id]!.height, `${id} height drifted on echo`).toBeCloseTo(
      firstBoxes[id]!.height,
      0,
    );
  }

  // And a second echo is exactly stationary.
  const third = await renderOnce(page, echoedInput(secondBoxes));
  expect(boxesOf(third.run)).toEqual(secondBoxes);
});

test('echo-back reproduces the identical scene markup', async ({ page }) => {
  // Pinned gap: fill stamps geoPath/viewBox at AUTHORED size, so the grown element letterboxes
  // in pass one but fills its box when the echoed size is authored — same boxes, different
  // drawing. Expected to fail until the echo/refit pass re-derives size-stamped props at the
  // final size; playwright will flag this test the moment it starts passing.
  test.fail();

  const first = await renderOnce(page, INPUT);
  const second = await renderOnce(page, echoedInput(boxesOf(first.run)));

  expect(second.scene).toBe(first.scene);
});
