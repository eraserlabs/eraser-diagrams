import { test, expect } from '@playwright/test';
import { createRenderer } from '../src/index.js';
import { CHROMIUM_PATH } from './support/browser.js';

for (const deviceScaleFactor of [1, 2]) {
  test(`PNG transparency preserves fills and dimensions at scale ${deviceScaleFactor}`, async ({
    page,
  }) => {
    const input = {
      elements: [
        {
          tag: 'Shape',
          id: 'a',
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          bgColor: '#ff0000',
          styleMode: 'plain',
        },
        {
          tag: 'Shape',
          id: 'b',
          x: 200,
          y: 0,
          width: 100,
          height: 100,
          bgColor: '#ff0000',
          styleMode: 'plain',
        },
      ],
      outputs: { png: true, html: true } as const,
    };
    let expectedSize: { width: number; height: number } | undefined;
    let expectedHtml: string | undefined;

    for (const transparent of [undefined, false, true]) {
      const renderer = await createRenderer({
        chromiumPath: CHROMIUM_PATH,
        deviceScaleFactor,
        ...(transparent === undefined ? {} : { transparent }),
      });

      try {
        // Reuse the page to ensure transparency survives subsequent captures.
        for (let capture = 0; capture < 2; capture += 1) {
          const result = await renderer.render(input);
          expect(result.ok).toBe(true);

          if (!result.ok) {
            return;
          }

          const pixels = await page.evaluate(async (base64) => {
            const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
            const bitmap = await createImageBitmap(blob);
            const canvas = document.createElement('canvas');
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            const context = canvas.getContext('2d')!;
            context.drawImage(bitmap, 0, 0);
            const pixel = (x: number, y: number) =>
              Array.from(context.getImageData(Math.floor(x), Math.floor(y), 1, 1).data);

            return {
              width: bitmap.width,
              height: bitmap.height,
              gap: pixel(bitmap.width / 2, bitmap.height / 2),
              fill: pixel(bitmap.width / 6, bitmap.height / 2),
            };
          }, result.png.toString('base64'));

          expectedSize ??= { width: pixels.width, height: pixels.height };
          expectedHtml ??= result.html;
          expect(pixels).toMatchObject(expectedSize);
          expect(pixels.gap).toEqual(transparent ? [0, 0, 0, 0] : [255, 255, 255, 255]);
          expect(pixels.fill).toEqual([255, 0, 0, 255]);
          expect(result.html).toBe(expectedHtml);
        }
      } finally {
        await renderer.close();
      }
    }
  });
}
