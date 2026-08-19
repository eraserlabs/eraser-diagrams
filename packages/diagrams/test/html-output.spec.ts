import { test, expect, type Page } from '@playwright/test';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stubIconLoader } from './support/stubIcons.js';
import { createRenderer, type Renderer } from '../src/index.js';
import { stockLibrary } from '../src/library/index.js';
import { AHEM_PATH } from './support/payload.js';
import { connectionsDocument } from './support/documents.js';
import { CHROMIUM_PATH } from './support/browser.js';

/**
 * The HTML format contract for `inline: true` file faces: a self-contained artifact — fonts
 * embedded as data-URI @font-face, icons inline, styles inline — that renders pixel-identical
 * to the PNG the same instance produces, with zero network access.
 */

const FAMILY = 'AhemTest';

/**
 * Same-run pixel comparison of two PNG buffers, decoded in the page. Byte equality is the wrong
 * assertion here (Chromium's PNG encoder is not byte-deterministic across pages), and exact pixel
 * equality is too: the standalone document rasterizes the scene at a different subpixel phase
 * than the live page, so hairline-stroke antialiasing redistributes — measured ~0.3% of pixels on
 * stroke edges, deltas up to ~90. The meaningful contract is structural identity with an AA-phase
 * tolerance: any real regression (wrong color, shifted or missing element) differs on vastly more
 * pixels than edge antialiasing can. (This is NOT stored-snapshot testing: both images come from
 * the same run, same browser, same fonts — nothing persists between runs.)
 */
async function pixelDiff(
  page: Page,
  a: Buffer,
  b: Buffer,
): Promise<{ sameSize: boolean; differingFraction: number; largeDeltaFraction: number }> {
  return page.evaluate(
    async ([a64, b64]) => {
      const decode = async (base64: string) => {
        const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext('2d')!;
        context.drawImage(bitmap, 0, 0);

        return {
          width: bitmap.width,
          height: bitmap.height,
          data: context.getImageData(0, 0, bitmap.width, bitmap.height).data,
        };
      };

      const [left, right] = await Promise.all([decode(a64!), decode(b64!)]);

      if (left.width !== right.width || left.height !== right.height) {
        return { sameSize: false, differingFraction: 1, largeDeltaFraction: 1 };
      }

      let differing = 0;
      let large = 0;

      for (let i = 0; i < left.data.length; i += 1) {
        const delta = Math.abs(left.data[i]! - right.data[i]!);

        if (delta > 0) {
          differing += 1;
        }

        if (delta > 8) {
          large += 1;
        }
      }

      return {
        sameSize: true,
        differingFraction: differing / left.data.length,
        largeDeltaFraction: large / left.data.length,
      };
    },
    [a.toString('base64'), b.toString('base64')],
  );
}

let diagrams: Renderer;

test.beforeAll(async () => {
  diagrams = await createRenderer({
    library: stockLibrary,
    chromiumPath: CHROMIUM_PATH,
    iconLoader: stubIconLoader,
    fonts: {
      roles: { rough: FAMILY, clean: FAMILY, mono: FAMILY },
      faces: [{ kind: 'file', family: FAMILY, path: AHEM_PATH, inline: true }],
    },
  });
});

test.afterAll(async () => {
  await diagrams.close();
});

test('html artifact loads standalone, airgapped, and matches the PNG render', async ({ page }) => {
  const input = connectionsDocument;
  const asHtml = await diagrams.render({ ...input, outputs: { html: true } });
  const asPng = await diagrams.render(input);
  expect(asHtml.ok && asPng.ok).toBe(true);

  if (!asHtml.ok || !asPng.ok) {
    return;
  }

  expect(asHtml.html).toContain('<!doctype html>');
  expect(asHtml.html).toContain('@font-face');
  expect(asHtml.html).toContain('data:font/ttf;base64,');
  expect(asHtml.html).toContain('id="eraser-scene"');

  const dir = await mkdtemp(join(tmpdir(), 'eraser-html-'));
  const file = join(dir, 'diagram.html');
  await writeFile(file, asHtml.html);

  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.url().startsWith('http')) {
      requests.push(request.url());
    }
  });

  await page.goto(pathToFileURL(file).href);
  await page.evaluate(() => document.fonts.ready);

  const screenshot = await page.locator('#eraser-scene').screenshot({ type: 'png' });
  expect(requests).toEqual([]);
  const diff = await pixelDiff(page, screenshot, asPng.png);
  expect(diff.sameSize).toBe(true);
  // Measured baseline: ~1.6% of channels touched by AA phase, ~0.6% beyond delta 8. Hairline
  // strokes dominate that tail — a 1.3px line lands on one row or two depending on the crop
  // phase, so a whole corner arc or connector flips at once while nothing has moved.
  expect(diff.differingFraction, 'artifact differs on too many pixels').toBeLessThan(0.03);
  expect(diff.largeDeltaFraction, 'artifact deviates structurally, beyond AA phase').toBeLessThan(
    0.01,
  );
});

test('render failures return the error envelope regardless of format', async () => {
  const outcome = await diagrams.render({
    elements: [{ tag: 'Nope', id: 'x', x: 0, y: 0 }],
    outputs: { html: true },
  });
  expect(outcome.ok).toBe(false);

  if (!outcome.ok) {
    expect(outcome.errors[0]?.code).toBe('E_UNKNOWN_TAG');
  }
});
