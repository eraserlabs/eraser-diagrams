import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { IconLoader } from '@eraserlabs/resolve';
import { normalizeFetchedIcon } from './svgTransforms.js';

/**
 * The public Eraser icon bucket — the same asset store the product and docs.eraser.io/icons use.
 * Icons are fetched per request and normalized in-flight (normalizeFetchedIcon); nothing is
 * vendored or re-hosted.
 */
export const ERASER_ICON_BASE_URL =
  'https://storage.googleapis.com/eraser-public-assets/canvas-icons/';

export interface EraserIconLoaderOptions {
  /** Base URL of the icon asset host; defaults to the public Eraser bucket's v1 prefix. */
  baseUrl?: string;
  timeoutMs?: number;
  /** Directory for the on-disk SVG cache; no disk cache when omitted. */
  cacheDir?: string;
  /**
   * Max age of a disk-cache entry before it is refetched (default 24h — bucket icons change
   * rarely). An expired entry whose refetch fails is served stale rather than erroring.
   */
  cacheTtlMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ICON_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The default icon loader for eraser.io assets: fetches `<baseUrl>/<name>.svg` with a timeout and
 * an optional disk cache. Requests never leave the host `baseUrl` names (allowlist by
 * construction: the icon name is a validated path segment, never a URL). Sanitization and the
 * in-memory negative cache live in the resolver, not here.
 */
export function createEraserIconLoader(options: EraserIconLoaderOptions = {}): IconLoader {
  const base = new URL(options.baseUrl ?? ERASER_ICON_BASE_URL);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;

  return async function eraserIconLoader(name: string): Promise<string> {
    if (!ICON_NAME_RE.test(name)) {
      throw new Error(`invalid icon name "${name}"`);
    }

    let stale: string | undefined;

    if (options.cacheDir) {
      const cached = await readCache(options.cacheDir, name, cacheTtlMs);

      if (cached?.fresh) {
        return cached.svg;
      }

      stale = cached?.svg;
    }

    const url = new URL(`${name}.svg`, base);

    if (url.host !== base.host || url.protocol !== base.protocol) {
      throw new Error(`icon "${name}" escapes the configured host`);
    }

    let svg: string;

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });

      if (!response.ok) {
        throw new Error(`icon "${name}": HTTP ${response.status}`);
      }

      // Brand assets in the bucket are raw (style-class palettes, no viewBox) — normalize
      // in-flight; the disk cache stores the normalized form.
      svg = normalizeFetchedIcon(await response.text(), name);
    } catch (err) {
      // An expired-but-present copy beats an outage: serve stale on any refetch failure.
      if (stale !== undefined) {
        return stale;
      }

      throw err;
    }

    if (options.cacheDir) {
      await writeCache(options.cacheDir, name, svg);
    }

    return svg;
  };
}

async function readCache(
  cacheDir: string,
  name: string,
  ttlMs: number,
): Promise<{ svg: string; fresh: boolean } | undefined> {
  const path = join(cacheDir, `${name}.svg`);

  try {
    const [svg, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);

    return { svg, fresh: Date.now() - info.mtimeMs < ttlMs };
  } catch {
    return undefined;
  }
}

async function writeCache(cacheDir: string, name: string, svg: string): Promise<void> {
  const path = join(cacheDir, `${name}.svg`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, svg, 'utf8');
}
