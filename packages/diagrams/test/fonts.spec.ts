import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, copyFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FontsConfig } from '@eraserlabs/resolve';
import { buildServer } from '@eraserlabs/server';
import { stageFonts } from '../src/fonts/staging.js';
import { injectFonts, prepareFontsRequest } from '../src/fonts/inject.js';
import { startFontServer } from './support/font-server.js';
import { IIFE_PATH } from './support/payload.js';
import { loadFont, probeWidth, trackFontRequests, AHEM_PROBE_WIDTH } from './support/page.js';

/** injectFonts drives the render bundle's registerFonts, so every page loads the IIFE first. */
async function openPage(page: Page): Promise<void> {
  await page.addInitScript({ path: IIFE_PATH });
  await page.goto('about:blank');
}

const FAMILY = 'AhemTest';
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const roles = { rough: FAMILY, clean: FAMILY, mono: FAMILY };

test('file face: staged bytes register as a FontFace with zero font network traffic', async ({
  page,
}) => {
  const dir = await mkdtemp(join(tmpdir(), 'eraser-fonts-'));
  const path = join(dir, 'ahem.ttf');
  await copyFile(join(FIXTURES, 'Ahem.ttf'), path);

  const staged = await stageFonts({ roles, faces: [{ kind: 'file', family: FAMILY, path }] });
  const netFonts = trackFontRequests(page);
  await openPage(page);
  await injectFonts(page, prepareFontsRequest(staged));

  const { loaded, statuses } = await loadFont(page, FAMILY);
  expect(loaded).toBe(true);
  expect(statuses[FAMILY]).toBe('loaded');
  expect(await probeWidth(page, FAMILY)).toBe(AHEM_PROBE_WIDTH);
  expect(netFonts).toEqual([]);
});

test('url face: Node does not fetch; the browser loads the @font-face URL', async ({ page }) => {
  const server = await startFontServer(FIXTURES);

  try {
    const staged = await stageFonts({
      roles,
      faces: [{ kind: 'url', family: FAMILY, url: server.url('Ahem.ttf') }],
    });
    expect(server.requests).toEqual([]);
    expect(staged.faces).toEqual([]);
    expect(staged.css).toContain(`src:url('${server.url('Ahem.ttf')}')`);

    const netFonts = trackFontRequests(page);
    await openPage(page);
    await injectFonts(page, prepareFontsRequest(staged));

    const { loaded } = await loadFont(page, FAMILY);
    expect(loaded).toBe(true);
    expect(await probeWidth(page, FAMILY)).toBe(AHEM_PROBE_WIDTH);
    expect(netFonts).toEqual([server.url('Ahem.ttf')]);
    expect(server.requests).toEqual(['/Ahem.ttf']);
  } finally {
    await server.close();
  }
});

test('file-from-url: staged once into the disk cache, and the font survives origin death', async ({
  page,
}) => {
  const server = await startFontServer(FIXTURES);
  const cacheDir = await mkdtemp(join(tmpdir(), 'eraser-cache-'));
  const fonts: FontsConfig = {
    roles,
    faces: [
      {
        kind: 'file-from-url',
        family: FAMILY,
        url: server.url('Ahem.ttf'),
        cachePath: join(cacheDir, 'ahem.ttf'),
      },
    ],
  };

  await stageFonts(fonts);
  await access(join(cacheDir, 'ahem.ttf'));
  expect(server.requests).toEqual(['/Ahem.ttf']);

  // Second staging with the same cache dir: no re-fetch, and from here only the disk cache can
  // serve the bytes.
  await server.close();
  const staged = await stageFonts(fonts);
  expect(server.requests).toEqual(['/Ahem.ttf']);

  const netFonts = trackFontRequests(page);
  await openPage(page);
  await injectFonts(page, prepareFontsRequest(staged));

  const { loaded, statuses } = await loadFont(page, FAMILY);
  expect(loaded).toBe(true);
  expect(statuses[FAMILY]).toBe('loaded');
  expect(await probeWidth(page, FAMILY)).toBe(AHEM_PROBE_WIDTH);
  expect(netFonts).toEqual([]);
});

test('degraded staging: /health reports the family and the page falls back', async ({ page }) => {
  const server = await startFontServer(FIXTURES);
  server.failWith = 404;
  const cacheDir = await mkdtemp(join(tmpdir(), 'eraser-cache-'));

  const fonts: FontsConfig = {
    roles,
    faces: [
      {
        kind: 'file-from-url',
        family: FAMILY,
        url: server.url('Ahem.ttf'),
        cachePath: join(cacheDir, 'ahem.ttf'),
      },
    ],
  };

  const { app } = await buildServer({ fonts, renderPages: 0 });

  try {
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.json()).toMatchObject({ status: 'degraded', degraded: [FAMILY] });

    // The same degraded staging drives the page: no face registers, metrics fall back.
    const staged = await stageFonts(fonts);
    expect(staged.faces).toEqual([]);
    await openPage(page);
    await injectFonts(page, prepareFontsRequest(staged));

    const { statuses } = await loadFont(page, FAMILY);
    expect(statuses).toEqual({});
    expect(await probeWidth(page, FAMILY)).not.toBe(AHEM_PROBE_WIDTH);
  } finally {
    await app.close();
    await server.close();
  }
});

test('hostile bytes: a face that is not a font degrades to status error without crashing', async ({
  page,
}) => {
  await openPage(page);
  await injectFonts(
    page,
    prepareFontsRequest({
      faces: [{ family: FAMILY, bytes: new TextEncoder().encode('not a font at all') }],
      css: `:root{--font-rough:'${FAMILY}',sans-serif;--font-clean:'${FAMILY}',sans-serif;--font-mono:'${FAMILY}',monospace}`,
      degraded: [],
      config: { roles, faces: [] },
    }),
  );

  const { loaded, statuses } = await loadFont(page, FAMILY);
  expect(loaded).toBe(false);
  expect(statuses[FAMILY]).toBe('error');
  expect(await probeWidth(page, FAMILY)).not.toBe(AHEM_PROBE_WIDTH);
});
