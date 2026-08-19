import { readFileSync } from 'node:fs';
import type { FontsConfig } from '@eraserlabs/resolve';

export interface ServerConfig {
  host: string;
  port: number;
  /** Fastify body limit in bytes (default 1 MiB). */
  bodyLimit: number;
  /** Warm render page pool size; 0 disables `POST /render` (no browser launches). */
  renderPages: number;
  /** Caller-managed Chromium executable. Required when renderPages is greater than 0. */
  chromiumPath?: string;
  /** Renders allowed to wait for a page beyond the pool before the server sheds load. */
  renderQueue: number;
  /** Architect fonts config (from FONTS_CONFIG_PATH). Unset → the stock Eraser fonts. */
  fonts?: FontsConfig;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];

  if (raw === undefined || raw === '') {
    return fallback;
  }

  const n = Number.parseInt(raw, 10);

  return Number.isNaN(n) ? fallback : n;
}

export function loadConfig(): ServerConfig {
  const chromiumPath = process.env.CHROMIUM_PATH;
  const config: ServerConfig = {
    host: process.env.HOST ?? '0.0.0.0',
    port: intEnv('PORT', 8080),
    bodyLimit: intEnv('BODY_LIMIT', 1024 * 1024),
    renderPages: intEnv('RENDER_PAGES', chromiumPath ? 1 : 0),
    renderQueue: intEnv('RENDER_QUEUE', 16),
  };

  if (chromiumPath) {
    config.chromiumPath = chromiumPath;
  }

  // Boot-time read; an unreadable or malformed file propagates and aborts boot (fail fast).
  const fontsPath = process.env.FONTS_CONFIG_PATH;

  if (fontsPath) {
    config.fonts = JSON.parse(readFileSync(fontsPath, 'utf8')) as FontsConfig;
  }

  return config;
}
