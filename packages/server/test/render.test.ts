import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { chromium } from 'playwright-core';
import { buildServer } from '../src/boot.js';

// The real product path: one warm Chromium page pool behind the endpoint. Boot once for the suite.
let app: FastifyInstance;
beforeAll(async () => {
  ({ app } = await buildServer({
    renderPages: 1,
    chromiumPath: chromium.executablePath(),
  }));
  await app.ready();
}, 60_000);
afterAll(async () => {
  await app.close();
});

const INPUT = { elements: [{ tag: 'Shape', id: 's', x: 0, y: 0, texts: [{ text: 'hi' }] }] };

describe('POST /render', () => {
  it('renders a PNG envelope by default', async () => {
    const res = await app.inject({ method: 'POST', url: '/render', payload: INPUT });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.format).toBe('png');
    expect(body.png).toMatch(/^data:image\/png;base64,/);
    // The data URL payload decodes to a real PNG (magic bytes).
    const encoded = body.png.slice('data:image/png;base64,'.length);
    expect(Buffer.from(encoded, 'base64').subarray(0, 4)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
  });

  it('renders a self-contained HTML artifact with format=html', async () => {
    const res = await app.inject({ method: 'POST', url: '/render?format=html', payload: INPUT });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.format).toBe('html');
    expect(body.html).toContain('<!doctype html>');
    expect(body.html).toContain('id="eraser-scene"');
  });

  it('returns the validation envelope for bad input, without touching the browser', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/render',
      payload: { elements: [{ tag: 'Nope', id: 'x', x: 0, y: 0 }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.errors[0].code).toBe('E_UNKNOWN_TAG');
  });

  it('does not wrap a bare-array body: it flows through to the envelope error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/render',
      payload: [{ tag: 'Shape', id: 's', x: 0, y: 0, texts: [{ text: 'hi' }] }],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.errors[0].code).toBe('E_ENVELOPE');
    expect(body.errors[0].message).toContain('{ "elements": [...] }');
  });

  it('rejects an unknown format with a 400 envelope', async () => {
    const res = await app.inject({ method: 'POST', url: '/render?format=gif', payload: INPUT });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].code).toBe('E_BAD_FORMAT');
  });

  it('reports render capability at /health', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toMatchObject({ status: 'ok', render: true });
  });
});

describe('browserless mode', () => {
  it('fails fast when rendering is enabled without a Chromium path', async () => {
    await expect(buildServer({ renderPages: 1, chromiumPath: undefined })).rejects.toThrow(
      'CHROMIUM_PATH is required when rendering is enabled.',
    );
  });

  it('renderPages: 0 boots without /render and reports render: false', async () => {
    const { app: lite } = await buildServer({ renderPages: 0 });
    await lite.ready();

    try {
      const res = await lite.inject({ method: 'POST', url: '/render', payload: INPUT });
      expect(res.statusCode).toBe(404);

      const health = await lite.inject({ method: 'GET', url: '/health' });
      expect(health.json().render).toBe(false);
    } finally {
      await lite.close();
    }
  });
});
