import { expect, test, type Page } from '@playwright/test';
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import type { ElementFit, FitConstraints } from '../src/browser/fitApi.js';

declare global {
  interface Window {
    fitTest: typeof import('../src/browser/fitApi.js');
  }
}

/**
 * fitElement and measureElement on one mounted element, as a host that fits one element at a time
 * uses them (`@eraserlabs/render/fit`). The template keeps a 10px inset round its text lane and
 * breaks a word only when it is wider than the lane (`overflow-wrap: break-word`), as the stock
 * Shape template does; every size is relative, so the assertions hold for any font.
 */
const script = buildSync({
  entryPoints: [fileURLToPath(new URL('../src/browser/fitApi.ts', import.meta.url))],
  bundle: true,
  format: 'iife',
  globalName: 'fitTest',
  write: false,
}).outputFiles[0]!.text;

const LONG = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen';
const WORD = 'Supercalifragilisticexpialidocious';

test.beforeEach(async ({ page }) => {
  await page.setContent(`<!doctype html><style>
    body { margin: 0; font: 16px/20px sans-serif }
    [data-mdp-tag="Fit"] { position: absolute; left: 0; top: 0 }
    .fit { display: block; width: 100%; height: 100%; box-sizing: border-box; padding: 0 10px }
    .fit-text { display: block; min-width: 0; white-space: normal; overflow-wrap: break-word; word-break: normal }
    .fit-caption { position: absolute; top: 100%; left: 0; width: max-content; max-width: 180%; white-space: normal }
  </style>`);
  await page.addScriptTag({ content: script });
});

async function fit(
  page: Page,
  text: string,
  constraints: FitConstraints,
  caption?: string,
): Promise<ElementFit> {
  return page.evaluate(
    ({ text, constraints, caption }) => {
      document.querySelector('[data-mdp-tag]')?.remove();
      const wrapper = document.createElement('div');
      wrapper.setAttribute('data-mdp-tag', 'Fit');
      wrapper.innerHTML = `<div class="fit" data-tpl="Fit" data-role="body"><span class="fit-text" data-role="internal-text" data-text-grow-policy="balanced" data-text-max-lines="3" data-text-aspect="0.8">${text}</span>${
        caption === undefined
          ? ''
          : `<span class="fit-caption" data-role="external-text" data-part="caption">${caption}</span>`
      }</div>`;
      document.body.appendChild(wrapper);

      return window.fitTest.fitElement(wrapper, constraints);
    },
    { text, constraints, caption },
  );
}

const region = (result: ElementFit) => result.textRegions[0]!;

test('natural: the max-content box, never below the authored size', async ({ page }) => {
  const long = await fit(page, LONG, { policy: 'natural', width: 80, height: 16 });
  expect(long.body.width).toBeGreaterThan(300);
  expect(region(long).lines).toBe(1);
  const short = await fit(page, 'A', { policy: 'natural', width: 80, height: 40 });
  expect(short.body).toEqual({ width: 80, height: 40 });
});

test('fixed: the authored width is kept whatever the text does; the height follows', async ({
  page,
}) => {
  const long = await fit(page, LONG, { policy: 'fixed', width: 80, height: 16 });
  expect(long.body.width).toBe(80);
  expect(long.body.height).toBeGreaterThan(16);
  expect(region(long).lines).toBeGreaterThan(3);
  expect(long.overflow.right).toBe(0);
  // a word wider than the lane breaks; nothing widens for it
  const word = await fit(page, WORD, { policy: 'fixed', width: 80, height: 16 });
  expect(word.body.width).toBe(80);
  // the height fits the text (a text box), or grows only from the authored floor (a shape)
  const fitted = await fit(page, 'A', { policy: 'fixed', width: 80, height: 60, heightMode: 'fit' });
  expect(fitted.body.height).toBeLessThan(60);
  const grown = await fit(page, 'A', { policy: 'fixed', width: 80, height: 60, heightMode: 'grow' });
  expect(grown.body.height).toBe(60);
});

test('content: short text takes its own width, text past the target plus slack wraps at the target', async ({
  page,
}) => {
  const natural = await fit(page, 'one two', { policy: 'natural' });
  const short = await fit(page, 'one two', {
    policy: 'content',
    width: natural.body.width + 40,
    heightMode: 'fit',
  });
  expect(short.body.width).toBe(natural.body.width);
  expect(region(short).lines).toBe(1);
  // within the slack (2px, or 5% of the target): still unwrapped, at its own width
  const slack = await fit(page, 'one two', {
    policy: 'content',
    width: natural.body.width - 1,
    heightMode: 'fit',
  });
  expect(slack.body.width).toBe(natural.body.width);
  // wider than that: wrapped at the target, which the element keeps
  const long = await fit(page, LONG, { policy: 'content', width: 120, heightMode: 'fit' });
  expect(long.body.width).toBe(120);
  expect(region(long).lines).toBeGreaterThan(1);
  expect(long.body.height).toBeGreaterThanOrEqual(region(long).lines * 20);
  // no target (a box just made): the text's own width
  const made = await fit(page, LONG, { policy: 'content', width: 0, heightMode: 'fit' });
  expect(made.body.width).toBe((await fit(page, LONG, { policy: 'natural' })).body.width);
});

test('balanced: text past the line threshold widens toward the aspect, short text keeps the floor', async ({
  page,
}) => {
  const natural = await fit(page, LONG, { policy: 'natural' });
  const balanced = await fit(page, LONG, { policy: 'balanced', width: 80, height: 16 });
  expect(balanced.body.width).toBeGreaterThan(80);
  expect(balanced.body.width).toBeLessThan(natural.body.width);
  const strict = await fit(page, LONG, { policy: 'fixed', width: 80, height: 16 });
  expect(balanced.body.height).toBeLessThan(strict.body.height);
  // the caller's parameters override the template's: a higher line threshold leaves it narrower
  const tall = await fit(page, LONG, {
    policy: 'balanced',
    width: 80,
    height: 16,
    balanced: { maxLines: 20 },
  });
  expect(tall.body.width).toBeLessThan(balanced.body.width);
  const short = await fit(page, 'A', { policy: 'balanced', width: 120, height: 20 });
  expect(short.body).toEqual({ width: 120, height: 20 });
});

test('balanced: a fit of the fitted size is a fixed point (no drift)', async ({ page }) => {
  const first = await fit(page, LONG, { policy: 'balanced', width: 80, height: 16 });
  const second = await fit(page, LONG, {
    policy: 'balanced',
    width: first.body.width,
    height: first.body.height,
  });
  expect(second.body).toEqual(first.body);
  const content = await fit(page, LONG, { policy: 'content', width: 120, heightMode: 'fit' });
  const again = await fit(page, LONG, {
    policy: 'content',
    width: content.body.width,
    heightMode: 'fit',
  });
  expect(again.body).toEqual(content.body);
});

test('balanced: a word wider than the lane widens the element within wordGrowth; past it, break or clamp', async ({
  page,
}) => {
  const word = (await fit(page, WORD, { policy: 'natural' })).body.width;
  // the word fits within 1.5× the lane: the element widens to it (the document path's rule)
  const kept = await fit(page, WORD, { policy: 'balanced', width: word - 30, height: 16 });
  expect(kept.body.width).toBeGreaterThanOrEqual(word);
  expect(region(kept).lines).toBe(1);
  // far too wide for the lane: broken where it is (default), the width kept (the line threshold
  // is lifted so the aspect rule stays out of the picture)
  const broken = await fit(page, WORD, {
    policy: 'balanced',
    width: 60,
    height: 16,
    balanced: { maxLines: 50 },
  });
  expect(broken.body.width).toBe(60);
  expect(region(broken).lines).toBeGreaterThan(1);
  // the canvas's rule: up to twice the lane plus headroom, then clamped there and broken
  const clamped = await fit(page, WORD, {
    policy: 'balanced',
    width: 60,
    height: 16,
    balanced: { maxLines: 50, wordGrowth: 2, wordHeadroom: 2, wordPastGrowth: 'clamp' },
  });
  expect(clamped.body.width).toBeGreaterThan(60);
  expect(clamped.body.width).toBeLessThanOrEqual(2 * 40 + 20 + 1);
  const grown = await fit(page, WORD, {
    policy: 'balanced',
    width: word - 30,
    height: 16,
    balanced: { wordGrowth: 2, wordHeadroom: 2, wordPastGrowth: 'clamp' },
  });
  expect(grown.body.width).toBeGreaterThanOrEqual(word + 2);
  expect(region(grown).lines).toBe(1);
});

test('measureElement: every text region at the proposed size, a caption by its part, and the overflow', async ({
  page,
}) => {
  const result = await fit(page, 'A', { policy: 'fixed', width: 40, height: 20 }, LONG);
  expect(result.body).toEqual({ width: 40, height: 20 });
  const caption = result.textRegions.find((r) => r.role === 'external-text')!;
  expect(caption.part).toBe('caption');
  expect(caption.box.width).toBeLessThanOrEqual(40 * 1.8 + 1);
  expect(caption.lines).toBeGreaterThan(1);
  expect(caption.naturalWidth).toBeGreaterThan(caption.box.width);
  const measured = await page.evaluate(() =>
    window.fitTest.measureElement(document.querySelector<HTMLElement>('[data-mdp-tag]')!),
  );
  expect(measured).toEqual(result);
});
