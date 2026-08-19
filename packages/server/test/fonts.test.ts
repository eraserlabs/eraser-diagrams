import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FontsConfig } from '@eraserlabs/resolve';
import { buildServer } from '../src/boot.js';

// Staging behavior itself is covered in @eraserlabs/diagrams (test/font-staging.test.ts); this suite
// only proves the server wires staging results into /health.

let cacheDir: string;
beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'eraser-fonts-'));
});
afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('boot wiring', () => {
  it('surfaces degraded fonts at GET /health', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 500 })),
    );
    const fonts: FontsConfig = {
      roles: { rough: 'C', clean: 'C', mono: 'C' },
      faces: [
        {
          kind: 'file-from-url',
          family: 'C',
          url: 'https://f/c.woff2',
          cachePath: join(cacheDir, 'c.woff2'),
        },
      ],
    };
    const { app } = await buildServer({ fonts, renderPages: 0 });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toMatchObject({ status: 'degraded', degraded: ['C'] });

    await app.close();
  });
});
