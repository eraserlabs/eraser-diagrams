import { test, expect } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stubIconLoader } from './support/stubIcons.js';
import { createRenderer, type OutputRequest, type RenderOutcome } from '../src/index.js';
import { stockLibrary } from '../src/library/index.js';
import { startFontServer } from './support/font-server.js';
import { CHROMIUM_PATH } from './support/browser.js';

const FAMILY = 'UrlFaceTest';
const FONTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'fonts');
const SCENE = {
  elements: [{ tag: 'Shape' as const, id: 's', x: 40, y: 40, texts: [{ text: 'MMMMMMMM' }] }],
};

async function renderWithUrl<const O extends OutputRequest>(
  url: string,
  outputs: O,
): Promise<RenderOutcome<{ outputs: O }>> {
  const renderer = await createRenderer({
    library: stockLibrary,
    chromiumPath: CHROMIUM_PATH,
    iconLoader: stubIconLoader,
    fonts: {
      roles: { rough: FAMILY, clean: FAMILY, mono: FAMILY },
      throwOnFontFail: true,
      faces: [{ kind: 'url', family: FAMILY, url, format: 'woff2' }],
    },
  });

  try {
    return await renderer.render({ ...SCENE, outputs });
  } finally {
    await renderer.close();
  }
}

test('url face: the render page loads the font and HTML references the URL', async () => {
  test.setTimeout(60_000);

  const server = await startFontServer(FONTS);
  const missing = await startFontServer(FONTS);
  missing.failWith = 404;
  const url = server.url('Inter.var.woff2');
  const deadUrl = missing.url('Inter.var.woff2');

  try {
    const loaded = await renderWithUrl(url, { html: true, json: true });
    const fallback = await renderWithUrl(deadUrl, { json: true });

    expect(loaded.ok && fallback.ok).toBe(true);

    if (!loaded.ok || !fallback.ok) {
      return;
    }

    expect(loaded.html).toContain(`src:url('${url}')`);
    expect(loaded.html).toContain("format('woff2')");
    expect(loaded.html).not.toContain('base64');
    expect(server.requests).toContain('/Inter.var.woff2');

    expect(loaded.json.entities[0]?.width).toEqual(expect.any(Number));
    expect(fallback.json.entities[0]?.width).toEqual(expect.any(Number));
    expect(loaded.json.entities[0]?.width).not.toBe(fallback.json.entities[0]?.width);
  } finally {
    await server.close();
    await missing.close();
  }
});

test('url face with an unreachable URL degrades without throwing', async () => {
  const missing = await startFontServer(FONTS);
  missing.failWith = 404;

  try {
    const outcome = await renderWithUrl(missing.url('Inter.var.woff2'), { png: true });
    expect(outcome.ok, JSON.stringify(outcome.ok ? undefined : outcome.errors)).toBe(true);
  } finally {
    await missing.close();
  }
});
