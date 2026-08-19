import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEraserIconLoader } from '../src/icons/eraserLoader.js';

const SVG = '<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>';

let server: Server;
let baseUrl: string;
let hits: string[];

beforeAll(async () => {
  hits = [];
  server = createServer((req, res) => {
    hits.push(req.url ?? '');

    if (req.url === '/icons/db.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml' }).end(SVG);

      return;
    }

    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();

  if (address === null || typeof address !== 'object') {
    throw new Error('no server address');
  }

  baseUrl = `http://127.0.0.1:${address.port}/icons/`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('createEraserIconLoader', () => {
  it('fetches <baseUrl>/<name>.svg', async () => {
    const load = createEraserIconLoader({ baseUrl });
    expect(await load('db')).toBe(SVG);
  });

  it('rejects on a missing icon', async () => {
    const load = createEraserIconLoader({ baseUrl });
    await expect(load('nope')).rejects.toThrow('HTTP 404');
  });

  it('rejects names that are not plain path segments', async () => {
    const load = createEraserIconLoader({ baseUrl });
    await expect(load('../secrets')).rejects.toThrow('invalid icon name');
    await expect(load('a/b')).rejects.toThrow('invalid icon name');
  });

  it('times out against a hanging origin instead of stalling the pipeline', async () => {
    // A server that accepts the connection and never responds.
    const hang = createServer(() => {});
    await new Promise<void>((resolve) => hang.listen(0, '127.0.0.1', resolve));
    const address = hang.address();

    if (address === null || typeof address !== 'object') {
      throw new Error('no server address');
    }

    try {
      const load = createEraserIconLoader({
        baseUrl: `http://127.0.0.1:${address.port}/icons/`,
        timeoutMs: 100,
      });
      await expect(load('slow')).rejects.toThrow(/timeout/i);
    } finally {
      hang.closeAllConnections();
      await new Promise((resolve) => hang.close(resolve));
    }
  });

  it('serves repeat loads from the disk cache without a network hit', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'eraser-icons-'));
    const load = createEraserIconLoader({ baseUrl, cacheDir });

    await load('db');
    expect(await readFile(join(cacheDir, 'db.svg'), 'utf8')).toBe(SVG);

    const before = hits.length;
    expect(await load('db')).toBe(SVG);
    expect(hits.length).toBe(before);
  });

  it('refetches an expired cache entry and refreshes the file', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'eraser-icons-'));
    const load = createEraserIconLoader({ baseUrl, cacheDir });

    await load('db');
    // Age the entry past the TTL.
    const path = join(cacheDir, 'db.svg');
    const past = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await utimes(path, past, past);

    const before = hits.length;
    expect(await load('db')).toBe(SVG);
    expect(hits.length).toBe(before + 1);
    expect((await stat(path)).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
  });

  it('serves the stale copy when the refetch fails', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'eraser-icons-'));
    const load = createEraserIconLoader({ baseUrl, cacheDir });

    await load('db');
    const path = join(cacheDir, 'db.svg');
    const past = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await utimes(path, past, past);

    // Same cache dir, but an origin that always fails.
    const broken = createEraserIconLoader({ baseUrl: `${baseUrl}missing/`, cacheDir });
    expect(await broken('db')).toBe(SVG);
  });

  it('a custom cacheTtlMs controls expiry', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'eraser-icons-'));
    const load = createEraserIconLoader({ baseUrl, cacheDir, cacheTtlMs: 1 });

    await load('db');
    await new Promise((resolve) => setTimeout(resolve, 10));

    const before = hits.length;
    await load('db');
    expect(hits.length).toBe(before + 1);
  });
});
