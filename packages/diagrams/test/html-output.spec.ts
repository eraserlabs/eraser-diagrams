import { test, expect, type Page } from '@playwright/test';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stubIconLoader } from './support/stubIcons.js';
import { createRenderer, type Renderer } from '../src/index.js';
import { stockLibrary } from '@eraserlabs/diagram-templates';
import { AHEM_PATH } from './support/payload.js';
import { connectionsDocument } from './support/documents.js';
import { CHROMIUM_PATH } from './support/browser.js';

/**
 * The HTML format contract for `inline: true` file faces: a self-contained artifact — fonts
 * embedded as data-URI @font-face, icons inline, styles inline — that renders pixel-identical
 * to the PNG the same instance produces, with zero network access, under its own content policy.
 */

/** Opens a written artifact and collects what its content policy refused. */
async function openArtifact(page: Page, html: string): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), 'eraser-html-'));
  const file = join(dir, 'diagram.html');
  await writeFile(file, html);

  const refused: string[] = [];
  page.on('console', (message) => {
    if (message.text().includes('Content Security Policy')) {
      refused.push(message.text());
    }
  });

  await page.goto(pathToFileURL(file).href);
  await page.evaluate(() => document.fonts.ready);

  return refused;
}

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
  expect(asHtml.html).toContain(
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'">`,
  );

  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.url().startsWith('http')) {
      requests.push(request.url());
    }
  });

  const refused = await openArtifact(page, asHtml.html);
  const screenshot = await page.locator('#eraser-scene').screenshot({ type: 'png' });
  expect(requests).toEqual([]);
  expect(refused).toEqual([]);
  // The artifact's policy refuses the fetch that decodes the PNGs; compare on a blank page.
  await page.goto('about:blank');
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

test('the stock fonts and the watercolor texture load under the artifact policy', async ({
  page,
}) => {
  const stock = await createRenderer({
    library: stockLibrary,
    chromiumPath: CHROMIUM_PATH,
    iconLoader: stubIconLoader,
  });

  try {
    const outcome = await stock.render({
      elements: [
        {
          tag: 'Shape',
          id: 'wash',
          x: 40,
          y: 40,
          width: 200,
          height: 80,
          color: 'blue',
          styleMode: 'watercolor',
          texts: [{ text: 'Rough **bold** `mono`' }],
        },
      ],
      outputs: { html: true },
    });
    expect(outcome.ok).toBe(true);

    if (!outcome.ok) {
      return;
    }

    // Stock faces are local files, referenced rather than inlined.
    expect(outcome.html).toContain('font-src data: file:;');
    expect(outcome.html).toContain('data:image/webp');

    const refused = await openArtifact(page, outcome.html);
    expect(refused).toEqual([]);
    // Faces load on use: whatever the text used loaded, and no face was refused.
    const statuses = await page.evaluate(() => [...document.fonts].map((face) => face.status));
    expect(statuses).not.toContain('error');
    expect(statuses).toContain('loaded');
  } finally {
    await stock.close();
  }
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
