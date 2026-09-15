import { test, expect } from '@playwright/test';
import { openScene } from './support/harness.js';

for (const clipUnits of ['userSpaceOnUse', 'objectBoundingBox']) {
  test(`ink excludes clipped overflow and SVG definitions (${clipUnits})`, async ({ page }) => {
    await openScene(page);
    const result = await page.evaluate(async (units) => {
      window.__eraser.setup({
        baseCss: '* { box-sizing: border-box; }',
        templates: {
          ClipBox: {
            html: `<template name="ClipBox"><div data-tpl="ClipBox" class="box">
            <div class="clip"><div class="overflow"></div></div>
            <svg width="100" height="60" style="overflow:visible;display:block">
              <defs><rect x="-900" y="-900" width="1800" height="1800"/></defs>
              <mask id="mask"><rect x="-800" y="-800" width="1600" height="1600"/></mask>
              <clipPath id="clip" clipPathUnits="${units}">
                <rect x="${units === 'objectBoundingBox' ? 0.4 : 0}" y="${units === 'objectBoundingBox' ? 0.4 : 0}"
                  width="${units === 'objectBoundingBox' ? 0.2 : 20}" height="${units === 'objectBoundingBox' ? 0.2 : 20}"/>
              </clipPath>
              <g transform="translate(20 10)" clip-path="url(#clip)">
                <rect x="-100" y="-100" width="200" height="200" fill="red"/>
              </g>
            </svg>
            <span class="badge">!</span>
          </div></template>`,
            css: `.box { position:relative;width:100%;height:100%; }
            .clip { position:absolute;left:20px;top:10px;width:60px;height:40px;overflow:hidden; }
            .overflow { position:absolute;left:-200px;top:-200px;width:500px;height:500px;box-shadow:0 0 10px 5px black; }
            .badge { position:absolute;left:-30px;top:-30px;width:20px;height:20px;overflow:hidden;box-shadow:0 0 2px 3px black; }`,
          },
        },
      });
      return window.__eraser.run({
        entities: [{ tag: 'ClipBox', id: 'box', x: 0, y: 0, width: 100, height: 60, props: {} }],
        connections: [],
        icons: {},
      });
    }, clipUnits);
    // The clipped children stay within the body, while the real badge and its shadow survive.
    expect(result.measures[0]!.ink).toEqual({ x: -35, y: -35, width: 135, height: 95 });
  });
}
