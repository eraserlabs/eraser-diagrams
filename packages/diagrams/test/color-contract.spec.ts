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
  for (const entity of result.entities!) {
    if (
      entity.id.endsWith('-literal') ||
      (entity.id.endsWith('-token') && !entity.id.includes('explicit'))
    ) {
      expect(entity.props.color).toBe('#00ffff');
      expect(entity.props.bgColor).toBeUndefined();
    }
  }
  await runPayload(page, payload);
  const paints = await page.evaluate(() => {
    // Resolve relative CSS colors through a pixel so syntax/serialization differences don't matter.
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d')!;
    const pixel = (color: string) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      return [...ctx.getImageData(0, 0, 1, 1).data];
    };
    return Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>('[data-mdp-id]')].map((wrapper) => {
        const body = wrapper.querySelector<HTMLElement>('[data-role="body"]')!;
        const css = getComputedStyle(body.querySelector('.er-shape__inner') ?? body);
        return [
          wrapper.dataset.mdpId!,
          { fill: pixel(css.backgroundColor), border: pixel(css.borderTopColor) },
        ];
      }),
    );
  });
  for (const tag of ['Shape', 'Group']) {
    const tint = tag === 'Shape' ? [179, 255, 255, 255] : [245, 255, 255, 255];
    for (const suffix of ['literal', 'token', 'hsl']) {
      expect(paints[`${tag}-${suffix}`]).toEqual({ fill: tint, border: [0, 255, 255, 255] });
    }
    expect(paints[`${tag}-explicit`]).toEqual({
      fill: [0, 255, 255, 255],
      border: [0, 0, 255, 255],
    });
    expect(paints[`${tag}-explicit-token`]).toEqual({
      fill: [0, 255, 255, 255],
      border: [0, 255, 255, 255],
    });
  }
});
