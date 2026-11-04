import { test, expect } from '@playwright/test';
import { stockLibrary } from '../src/index.js';
import { buildPayload, runPayload } from './support/payload.js';

test('white backgrounds render like literal white, including readable Shape text', async ({
  page,
}) => {
  for (const theme of ['light', 'dark'] as const) {
    const elements = ['white', '#ffffff'].flatMap((bgColor, i) =>
      ['Shape', 'Group'].map((tag, j) => ({
        tag,
        id: `${tag}-${i}`,
        x: i * 180,
        y: j * 120,
        width: 160,
        height: 100,
        bgColor,
        ...(tag === 'Shape' ? { texts: [{ text: 'Traditional Limitations' }] } : {}),
      })),
    );
    const { payload, result } = await buildPayload({ elements }, { theme });
    expect(result.ok, JSON.stringify(result.errors)).toBe(true);
    await runPayload(page, payload);
    for (const tag of ['Shape', 'Group']) {
      for (const i of [0, 1]) {
        const host = page.locator(`[data-mdp-id="${tag}-${i}"]`);
        const body = host.locator(
          tag === 'Shape' ? '.er-shape__path--dynamic' : '[data-role="body"]',
        );
        await expect(body).toHaveCSS(
          tag === 'Shape' ? 'fill' : 'background-color',
          theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(23, 23, 23)',
        );
        if (tag === 'Shape') {
          await expect(host.locator('.er-shape__text')).toHaveCSS(
            'color',
            theme === 'light' ? 'rgb(36, 36, 36)' : 'rgb(226, 226, 226)',
          );
        }
      }
    }
  }
});

test('color derives template-specific tints; explicit paints override them for tokens and literals', async ({
  page,
}) => {
  const palette = { ...stockLibrary.palette, blue: '#00ffff' };
  const cases = [
    { suffix: 'literal', color: '#00ffff' },
    { suffix: 'token', color: 'blue' },
    { suffix: 'hsl', color: 'hsl(180, 100%, 50%)' },
    { suffix: 'explicit', color: '#ff0000', bgColor: '#00ffff', borderColor: '#0000ff' },
    { suffix: 'explicit-token', color: '#ff0000', bgColor: 'blue', borderColor: 'blue' },
  ];
  const elements = ['Shape', 'Group'].flatMap((tag) =>
    cases.map(({ suffix, ...props }, i) => ({
      tag,
      id: `${tag}-${suffix}`,
      x: i * 160,
      y: tag === 'Shape' ? 0 : 120,
      width: 140,
      height: 100,
      styleMode: 'plain',
      ...props,
    })),
  );
  const { payload, result } = await buildPayload(
    { elements },
    { library: { ...stockLibrary, palette } },
  );
  expect(result.ok, JSON.stringify(result.errors)).toBe(true);
  await runPayload(page, payload);
  for (const tag of ['Shape', 'Group']) {
    const tint = tag === 'Shape' ? 'rgb(179, 255, 255)' : 'rgb(245, 255, 255)';
    for (const { suffix } of cases) {
      const host = page.locator(`[data-mdp-id="${tag}-${suffix}"]`);
      const body = host.locator(
        tag === 'Shape' ? '.er-shape__path--dynamic' : '[data-role="body"]',
      );
      const explicit = suffix.startsWith('explicit');
      await expect(body).toHaveCSS(
        tag === 'Shape' ? 'fill' : 'background-color',
        explicit ? 'rgb(0, 255, 255)' : tint,
      );
      const stroke = suffix === 'explicit' ? 'rgb(0, 0, 255)' : 'rgb(0, 255, 255)';
      if (tag === 'Shape') {
        await expect(body).toHaveCSS('stroke', stroke);
        await expect(body).toHaveCSS('stroke-width', '1.2px');
      } else {
        await expect(body).toHaveCSS('border-top-color', stroke);
      }
    }
  }
});
