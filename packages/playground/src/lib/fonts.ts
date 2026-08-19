import { buildFontsHead } from '@eraserlabs/resolve';
import type { RegisterFontsRequest } from '@eraserlabs/render/browser';
import shantellUrl from '../../../diagrams/fonts/ShantellSans.var.woff2?url';
import interUrl from '../../../diagrams/fonts/Inter.var.woff2?url';
import monoUrl from '../../../diagrams/fonts/JetBrainsMono-Regular.woff2?url';

/**
 * Stock faces as `url` sources Vite serves. The preview is a real origin, so Chromium loads
 * these the same way a `kind: 'url'` render does — without this, every `--font-*` role falls
 * through to the same sans-serif.
 */
export function playgroundFonts(): RegisterFontsRequest {
  const config = {
    roles: { rough: 'ShantellSans', clean: 'Inter', mono: 'JetBrainsMono' },
    fallbacks: { rough: 'sans-serif', clean: 'sans-serif', mono: 'monospace' },
    faces: [
      {
        kind: 'url' as const,
        family: 'ShantellSans',
        url: shantellUrl,
        format: 'woff2',
        weight: '300 800',
      },
      {
        kind: 'url' as const,
        family: 'Inter',
        url: interUrl,
        format: 'woff2',
        weight: '100 900',
      },
      {
        kind: 'url' as const,
        family: 'JetBrainsMono',
        url: monoUrl,
        format: 'woff2',
      },
    ],
  };

  return {
    css: buildFontsHead(config),
    faces: [],
    urlFaces: config.faces.map((face) => ({ family: face.family })),
  };
}
