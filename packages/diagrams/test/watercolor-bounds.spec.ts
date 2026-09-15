import { test, expect } from '@playwright/test';
import { createRenderer, type Renderer } from '../src/index.js';
import { AHEM_PATH } from './support/payload.js';
import { CHROMIUM_PATH } from './support/browser.js';
import { stubIconLoader } from './support/stubIcons.js';
import { ALLOWED_SHAPES } from '../src/library/schema/enums.js';

let renderer: Renderer;
test.beforeAll(async () => {
  renderer = await createRenderer({
    chromiumPath: CHROMIUM_PATH,
    deviceScaleFactor: 2,
    iconLoader: stubIconLoader,
    fonts: {
      roles: { clean: 'Ahem', rough: 'Ahem', mono: 'Ahem' },
      faces: [{ kind: 'file', family: 'Ahem', path: AHEM_PATH }],
    },
  });
});
test.afterAll(async () => {
  await renderer?.close();
});

for (const kind of [...ALLOWED_SHAPES, 'Group', 'Lane', 'Pool', 'DatabaseTable']) {
  test(`${kind}: watercolor PNG bounds stay within normal export padding`, async ({
    page,
  }, testInfo) => {
    const container = ['Group', 'Lane', 'Pool', 'DatabaseTable'].includes(kind);
    const sizes = [];
    for (const styleMode of ['plain', 'watercolor']) {
      const result = await renderer.render({
        entities: [
          {
            tag: container ? kind : 'Shape',
            id: 'box',
            ...(container ? {} : { shape: kind }),
            x: 40,
            y: 40,
            width: 200,
            height: 100,
            bgColor: '#4F76A8',
            borderColor: '#4F76A8',
            styleMode,
            ...(container ? {} : { texts: [] }),
          },
        ],
        connections: [],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(JSON.stringify(result));
      }
      const png = result.png!;
      sizes.push({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });
      if (kind === 'rectangle') {
        await testInfo.attach(styleMode, { body: png, contentType: 'image/png' });
        const ink = await page.evaluate(async (base64) => {
          const img = new Image();
          img.src = `data:image/png;base64,${base64}`;
          await img.decode();
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(img, 0, 0);
          const { data } = ctx.getImageData(0, 0, img.width, img.height);
          let left = img.width;
          let top = img.height;
          let right = -1;
          let bottom = -1;
          for (let y = 0; y < img.height; y++) {
            for (let x = 0; x < img.width; x++) {
              const i = (y * img.width + x) * 4;
              if (data[i + 3]! > 0 && Math.min(data[i]!, data[i + 1]!, data[i + 2]!) < 250) {
                left = Math.min(left, x);
                top = Math.min(top, y);
                right = Math.max(right, x);
                bottom = Math.max(bottom, y);
              }
            }
          }
          return {
            left,
            top,
            rightMargin: img.width - 1 - right,
            bottomMargin: img.height - 1 - bottom,
          };
        }, png.toString('base64'));
        for (const margin of Object.values(ink)) {
          expect(margin).toBeGreaterThanOrEqual(24);
          expect(margin).toBeLessThanOrEqual(36);
        }
      }
    }
    expect(sizes[1]).toEqual(sizes[0]);
    if (kind === 'rectangle') {
      expect(sizes[1]).toEqual({ width: 464, height: 264 });
    }
  });
}
