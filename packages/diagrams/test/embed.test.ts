import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildEmbeddedFontCss } from '../src/fonts/embed.js';
import type { StagedFonts } from '../src/fonts/staging.js';

const bytes = new TextEncoder().encode('font-bytes');

function staged(overrides: Partial<StagedFonts> = {}): StagedFonts {
  return {
    faces: [],
    css: '',
    degraded: [],
    config: { roles: {}, faces: [] },
    ...overrides,
  };
}

describe('buildEmbeddedFontCss', () => {
  it('emits a file:/// rule for a file face and base64 only with inline: true', () => {
    const path = '/tmp/eraser-fonts/Inter.woff2';
    const file = staged({
      faces: [
        {
          family: 'Inter',
          bytes,
          source: { kind: 'file', family: 'Inter', path, format: 'woff2' },
        },
      ],
    });

    expect(buildEmbeddedFontCss(file)).toBe(
      `@font-face{font-family:'Inter';src:url('${pathToFileURL(resolve(path)).href}') format('woff2')}`,
    );

    const inlined = staged({
      faces: [
        {
          family: 'Inter',
          bytes,
          source: { kind: 'file', family: 'Inter', path, inline: true },
        },
      ],
    });

    expect(buildEmbeddedFontCss(inlined)).toBe(
      `@font-face{font-family:'Inter';src:url(data:font/ttf;base64,${Buffer.from(bytes).toString('base64')})}`,
    );
  });

  it('emits the original URL for a file-from-url face and base64 with inline: true', () => {
    const url = 'https://cdn.example/Inter.woff2';
    const fromUrl = staged({
      faces: [
        {
          family: 'Inter',
          bytes,
          weight: '700',
          source: {
            kind: 'file-from-url',
            family: 'Inter',
            url,
            cachePath: '/cache/Inter.woff2',
          },
        },
      ],
    });

    expect(buildEmbeddedFontCss(fromUrl)).toBe(
      `@font-face{font-family:'Inter';font-weight:700;src:url('${url}')}`,
    );

    const inlined = staged({
      faces: [
        {
          family: 'Inter',
          bytes,
          source: {
            kind: 'file-from-url',
            family: 'Inter',
            url,
            cachePath: '/cache/Inter.woff2',
            inline: true,
          },
        },
      ],
    });

    expect(buildEmbeddedFontCss(inlined)).toContain('data:font/ttf;base64,');
    expect(buildEmbeddedFontCss(inlined)).not.toContain(url);
  });
});
