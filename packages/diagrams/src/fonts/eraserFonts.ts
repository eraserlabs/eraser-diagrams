import { fileURLToPath } from 'node:url';
import type { FontsConfig } from '@eraserlabs/resolve';

/**
 * Stock fonts, all SIL OFL 1.1 and vendored under `fonts/`: Shantell Sans for rough,
 * Inter for clean, JetBrains Mono for mono.
 *
 * The Shantell face is subset for size (1.25MB source → ~94KB): the novelty axes
 * (BNCE/INFM/SPAC) are pinned at their defaults — the positions we rendered at anyway — keeping
 * the wght axis, and the charset is Latin + general punctuation + €/™/arrows/math operators,
 * all layout features retained so metrics and kerning are unchanged. Non-Latin rough text falls
 * through the role's generic fallback. Regenerate with fonttools: varLib.instancer INFM=0
 * BNCE=0 SPAC=0, then pyftsubset
 * --unicodes="U+0000-017F,U+2000-206F,U+20AC,U+2122,U+2190-2199,U+2200-22FF"
 * --layout-features='*' --flavor=woff2.
 */
export function eraserFonts(): FontsConfig {
  const fontPath = (file: string): string =>
    fileURLToPath(new URL(`../../fonts/${file}`, import.meta.url));

  return {
    roles: { rough: 'ShantellSans', clean: 'Inter', mono: 'JetBrainsMono' },
    faces: [
      // The variable weight range must be declared, or Chromium matches the face for bold text
      // and renders it at the default 400 axis position (no synthesis for a matched family).
      {
        kind: 'file',
        family: 'ShantellSans',
        path: fontPath('ShantellSans.var.woff2'),
        format: 'woff2',
        weight: '300 800',
      },
      {
        kind: 'file',
        family: 'Inter',
        path: fontPath('Inter.var.woff2'),
        format: 'woff2',
        weight: '100 900',
      },
      {
        kind: 'file',
        family: 'JetBrainsMono',
        path: fontPath('JetBrainsMono-Regular.woff2'),
        format: 'woff2',
      },
    ],
    fallbacks: { rough: 'sans-serif', clean: 'sans-serif', mono: 'monospace' },
  };
}
