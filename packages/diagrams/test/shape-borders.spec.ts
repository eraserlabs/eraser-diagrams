import { test, expect } from '@playwright/test';
import { buildPayload, runPayload } from './support/payload.js';

for (const styleMode of ['plain', 'shadow', 'watercolor']) {
  test(`Shape: literal outline widths across CSS and SVG geometry in ${styleMode}`, async ({
    page,
  }, testInfo) => {
    const geometries = [
      { shape: 'rectangle', fixed: true },
      { shape: 'oval', fixed: true },
      { shape: 'circle', fixed: true },
      { shape: 'ellipse', fixed: true },
      { shape: 'hexagon', fixed: true },
      { shape: 'cylinder', fixed: true },
      { shape: 'hexagon', fixed: false },
      { shape: 'cylinder', fixed: false },
    ];
    const entities = geometries.flatMap(({ shape, fixed }, row) =>
      [undefined, 0, 2, 3.5].map((borderWidth, column) => ({
        tag: 'Shape',
        id: `s${row}${column}`,
        x: 20 + column * 200,
        y: 20 + row * 150,
        ...(fixed ? { width: 170, height: 110 } : {}),
        shape,
        styleMode,
        color: 'blue',
        borderStyle: ['solid', 'dashed', 'dotted', 'solid'][column]!,
        ...(borderWidth !== undefined ? { borderWidth } : {}),
        texts: [{ text: `${shape}\n${borderWidth ?? 'default'}px` }],
        badge: { text: '3' },
      })),
    );
    const { payload, result } = await buildPayload({ entities, connections: [] });
    expect(result.ok, JSON.stringify(result.errors)).toBe(true);
    await runPayload(page, payload);
    // Chromium quantizes CSS borders at layout zoom, independently of deviceScaleFactor.
    // 4x makes both 0.75px and 3.5px observable without rounding to whole CSS pixels.
    await page.addStyleTag({ content: ':root { zoom: 4; }' });

    for (const entity of entities) {
      const root = page.locator(`[data-mdp-id="${entity.id}"] .er-shape`);
      const width = `${entity.borderWidth ?? 0.75}px`;
      await expect(root).toHaveAttribute('data-border-px', String(entity.borderWidth ?? ''));
      await expect(root.locator('[data-tpl="Badge"]')).toHaveCSS('border-top-width', width);

      if (['hexagon', 'cylinder'].includes(entity.shape)) {
        const paths = root.locator('.er-shape__path:visible, .er-shape__cap:visible');
        expect(await paths.count()).toBe(entity.shape === 'cylinder' ? 2 : 1);
        for (const path of await paths.all()) {
          await expect(path).toHaveCSS('stroke-width', width);
          await expect(path).toHaveCSS('vector-effect', 'non-scaling-stroke');
        }
        await expect(root.locator('.er-shape__inner')).toHaveCSS('border-top-width', '0px');
      } else {
        const inner = root.locator('.er-shape__inner');
        await expect(inner).toHaveCSS('border-top-width', width);
        if (styleMode === 'watercolor') {
          const overlay = await inner.evaluate((el) => {
            const css = getComputedStyle(el, '::after');
            return { content: css.content, width: css.borderTopWidth };
          });
          expect(overlay).toEqual({ content: '""', width });
        }
      }
    }

    await page.addStyleTag({ content: ':root { zoom: 1; }' });
    await testInfo.attach(`shape-borders-${styleMode}`, {
      body: await page.locator('#eraser-scene').screenshot({ scale: 'css' }),
      contentType: 'image/png',
    });
  });
}
