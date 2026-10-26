import { test, expect } from '@playwright/test';
import { stockLibrary } from '../src/index.js';
import { buildPayload, runPayload } from './support/payload.js';

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
      const body = host.locator(tag === 'Shape' ? '.er-shape__inner' : '[data-role="body"]');
      const explicit = suffix.startsWith('explicit');
      await expect(body).toHaveCSS('background-color', explicit ? 'rgb(0, 255, 255)' : tint);
      await expect(body).toHaveCSS(
        'border-top-color',
        suffix === 'explicit' ? 'rgb(0, 0, 255)' : 'rgb(0, 255, 255)',
      );
    }
  }
});
