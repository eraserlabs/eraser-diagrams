import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FontsConfig } from '@eraserlabs/resolve';
import { stageFonts } from '../src/fonts/staging.js';

let cacheDir: string;
beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'eraser-fonts-'));
});
afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

const roles = { rough: 'C', clean: 'C', mono: 'C' };

function fromUrlConfig(overrides: Partial<FontsConfig> = {}): FontsConfig {
  return {
    roles,
    faces: [
      {
        kind: 'file-from-url',
        family: 'C',
        url: 'https://f/c.woff2',
        cachePath: join(cacheDir, 'c.woff2'),
      },
    ],
    ...overrides,
  };
}

function stubFetchOk(): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => new Response(new TextEncoder().encode('font-bytes')));
  vi.stubGlobal('fetch', mock);

  return mock;
}

describe('stageFonts (bytes in Node)', () => {
  it('fetches and caches a file-from-url face once, resolving it to bytes', async () => {
    const fetchMock = stubFetchOk();
    const { faces, degraded, css } = await stageFonts(fromUrlConfig());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(degraded).toEqual([]);
    expect(faces).toHaveLength(1);
    expect(new TextDecoder().decode(faces[0]!.bytes)).toBe('font-bytes');
    expect(await readFile(join(cacheDir, 'c.woff2'), 'utf8')).toBe('font-bytes');
    // Role vars survive; file-from-url faces do not become @font-face rules.
    expect(css).toContain("--font-clean:'C'");
    expect(css).not.toContain('@font-face');
  });

  it('reuses an already-cached file (no re-fetch), reading its bytes from disk', async () => {
    const fetchMock = stubFetchOk();
    await writeFile(join(cacheDir, 'c.woff2'), 'cached-bytes');

    const { faces } = await stageFonts(fromUrlConfig());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(new TextDecoder().decode(faces[0]!.bytes)).toBe('cached-bytes');
  });

  it('does not fetch url faces; they appear in css, never in faces or degraded', async () => {
    const fetchMock = stubFetchOk();
    const { faces, css, degraded, config } = await stageFonts({
      roles,
      faces: [{ kind: 'url', family: 'C', url: 'https://f/c.woff2', weight: '700' }],
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(faces).toEqual([]);
    expect(degraded).toEqual([]);
    expect(config.faces).toEqual([
      { kind: 'url', family: 'C', url: 'https://f/c.woff2', weight: '700' },
    ]);
    expect(css).toContain(
      "@font-face{font-family:'C';font-weight:700;src:url('https://f/c.woff2')}",
    );
  });

  it('ignores throwOnFontFail for url faces', async () => {
    const fetchMock = stubFetchOk();
    const staged = await stageFonts({
      roles,
      throwOnFontFail: true,
      faces: [{ kind: 'url', family: 'C', url: 'https://127.0.0.1:1/missing.woff2' }],
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(staged.faces).toEqual([]);
    expect(staged.degraded).toEqual([]);
  });

  it('reads file faces from disk and drops an unreadable one as degraded', async () => {
    const path = join(cacheDir, 'a.woff2');
    await writeFile(path, 'disk-bytes');
    const { faces, degraded } = await stageFonts({
      roles,
      faces: [
        { kind: 'file', family: 'A', path },
        { kind: 'file', family: 'B', path: join(cacheDir, 'missing.woff2') },
      ],
    });

    expect(faces.map((f) => f.family)).toEqual(['A']);
    expect(degraded).toEqual(['B']);
  });

  it('throws on fetch failure when throwOnFontFail is set', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    await expect(stageFonts(fromUrlConfig({ throwOnFontFail: true }))).rejects.toThrow('404');
  });

  it('drops the face and reports it degraded without throwOnFontFail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    const { faces, degraded, config } = await stageFonts(fromUrlConfig());

    expect(degraded).toEqual(['C']);
    expect(faces).toEqual([]);
    expect(config.faces).toEqual([]);
  });
});
