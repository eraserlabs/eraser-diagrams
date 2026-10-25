import { test, expect } from '@playwright/test';
import { createRenderer } from '../src/index.js';
import { CHROMIUM_PATH } from './support/browser.js';

for (const theme of ['light', 'dark'] as const) {
  for (const deviceScaleFactor of [1, 2]) {
    test(`PNG transparency preserves ${theme} fills and dimensions at scale ${deviceScaleFactor}`, async ({
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
      const expectedHtml = new Map<string, string>();

      for (const transparent of [undefined, false, true]) {
        const renderer = await createRenderer({
          chromiumPath: CHROMIUM_PATH,
          deviceScaleFactor,
          theme,
          ...(transparent === undefined ? {} : { transparent }),
        });

        try {
          // Exercise the renderer default, a request override, then the default again on one pooled page.
          // Repeating for both backgrounds catches stale theme state as well as screenshot overrides.
          const otherTheme = theme === 'light' ? 'dark' : 'light';
          for (const requestTheme of [undefined, otherTheme, undefined] as const) {
            const actualTheme = requestTheme ?? theme;
            const result = await renderer.render({
              ...input,
              ...(requestTheme === undefined ? {} : { theme: requestTheme }),
            });
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
            if (!expectedHtml.has(actualTheme)) {
              expectedHtml.set(actualTheme, result.html);
            }
            expect(pixels).toMatchObject(expectedSize);
            const background = actualTheme === 'dark' ? [23, 23, 23, 255] : [255, 255, 255, 255];
            expect(pixels.gap).toEqual(transparent ? [0, 0, 0, 0] : background);
            expect(pixels.fill).toEqual([255, 0, 0, 255]);
            expect(result.html).toBe(expectedHtml.get(actualTheme));
            expect(result.html).toContain(`data-er-theme="${actualTheme}"`);
          }
        } finally {
          await renderer.close();
        }
      }
    });
  }
}
