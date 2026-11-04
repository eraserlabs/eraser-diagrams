import { test, expect } from '@playwright/test';
import { buildPayload, runPayload } from './support/payload.js';

for (const deviceScaleFactor of [1, 2]) {
  test.describe(`rectangle shadows at ${deviceScaleFactor}x`, () => {
    test.use({ deviceScaleFactor });
    for (const theme of ['light', 'dark'] as const) {
      for (const cornerRadius of ['round', 'sharp'] as const) {
        test(`${theme}, ${cornerRadius}: shadow paints outside a transparent body`, async ({
          page,
        }) => {
          const { payload, result } = await buildPayload(
            {
              elements: [
                {
                  tag: 'Shape',
                  id: 'rectangle',
                  x: 20,
                  y: 20,
                  width: 140,
                  height: 80,
                  cornerRadius,
                  bgColor: 'transparent',
                  borderWidth: 0,
                  styleMode: 'shadow',
                },
              ],
            },
            { theme },
          );
          expect(result.errors).toEqual([]);
          await runPayload(page, payload);
          await page.evaluate((dark) => {
            document.body.style.background = dark ? '#171717' : '#ffffff';
          }, theme === 'dark');
          const host = page.locator('[data-mdp-id="rectangle"]');
          const bounds = (await host.boundingBox())!;
          const screenshot = await page.screenshot({
            clip: { ...bounds, width: bounds.width + 5, height: bounds.height + 5 },
            scale: 'css',
          });
          const pixels = await page.evaluate(async (data) => {
            const image = new Image();
            image.src = `data:image/png;base64,${data}`;
            await image.decode();
            const canvas = document.createElement('canvas');
            canvas.width = image.width;
            canvas.height = image.height;
            const ctx = canvas.getContext('2d')!;
            ctx.drawImage(image, 0, 0);
            return [
              [70, 40],
              [142, 40],
              [70, 82],
            ].map(([x, y]) => [...ctx.getImageData(x!, y!, 1, 1).data]);
          }, screenshot.toString('base64'));
          const ground = theme === 'dark' ? 23 : 255;
          const shadow = theme === 'dark' ? 63 : 232;
          expect(pixels).toEqual([
            [ground, ground, ground, 255],
            [shadow, shadow, shadow, 255],
            [shadow, shadow, shadow, 255],
          ]);
          await expect(host.locator('.er-shape__shadow')).toHaveCount(1);
          await expect(host.locator('.er-shape__inner')).toHaveCSS('box-shadow', 'none');
        });
      }
    }
  });
}
