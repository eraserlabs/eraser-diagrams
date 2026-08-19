import { describe, it, expect } from 'vitest';
import type { FontsConfig } from '@eraserlabs/protocol';
import { buildFontsHead } from '../src/fonts/head.js';
import { planFontStaging } from '../src/fonts/setup.js';

const roles = { rough: 'Comic', clean: 'Inter', mono: 'Mono' };

describe('buildFontsHead', () => {
  it('sets one var per role with the generic sans-serif fallback', () => {
    const head = buildFontsHead({ roles, faces: [{ kind: 'system', family: 'Inter' }] });
    expect(head).toBe(
      ":root{--font-rough:'Comic',sans-serif;--font-clean:'Inter',sans-serif;--font-mono:'Mono',sans-serif}",
    );
  });

  it('honors configured per-role fallbacks (role names mean nothing to the engine)', () => {
    const head = buildFontsHead({ roles, fallbacks: { mono: 'monospace' }, faces: [] });
    expect(head).toContain("--font-mono:'Mono',monospace");
    expect(head).toContain("--font-rough:'Comic',sans-serif");
  });

  it('emits @font-face only for url faces, with optional weight/style/format', () => {
    const cfg: FontsConfig = {
      roles,
      faces: [
        { kind: 'file', family: 'A', path: '/fonts/a.woff2', format: 'woff2' },
        { kind: 'url', family: 'B', url: 'https://f/b.woff2' },
        {
          kind: 'url',
          family: "O'Brien",
          url: 'https://f/c.woff2',
          weight: '700',
          style: 'italic',
          format: 'woff2',
        },
        {
          kind: 'file-from-url',
          family: 'D',
          url: 'https://f/d.woff2',
          cachePath: '/cache/d.woff2',
        },
      ],
    };
    const head = buildFontsHead(cfg);
    expect(head.startsWith(':root{')).toBe(true);
    expect(head).toContain("--font-clean:'Inter',sans-serif");
    expect(head).toContain("@font-face{font-family:'B';src:url('https://f/b.woff2')}");
    expect(head).toContain(
      "@font-face{font-family:'O\\'Brien';font-weight:700;font-style:italic;src:url('https://f/c.woff2') format('woff2')}",
    );
    expect(head).not.toContain("src:url('/fonts/a.woff2')");
    expect(head).not.toContain('https://f/d.woff2');
  });
});

describe('planFontStaging (pure staging plan)', () => {
  it('rewrites a file-from-url face to a file face and lists it for fetching', () => {
    const { fetches, config } = planFontStaging({
      roles,
      faces: [
        {
          kind: 'file-from-url',
          family: 'C',
          url: 'https://f/c.woff2',
          cachePath: '/cache/c.woff2',
          weight: '700',
          style: 'italic',
          format: 'woff2',
        },
      ],
    });

    expect(fetches).toEqual([
      { family: 'C', url: 'https://f/c.woff2', cachePath: '/cache/c.woff2' },
    ]);
    expect(config.faces).toEqual([
      {
        kind: 'file',
        family: 'C',
        path: '/cache/c.woff2',
        weight: '700',
        style: 'italic',
        format: 'woff2',
      },
    ]);
  });

  it('passes system / file / url faces through untouched with nothing to fetch', () => {
    const cfg: FontsConfig = {
      roles,
      faces: [
        { kind: 'system', family: 'Inter' },
        { kind: 'file', family: 'A', path: '/fonts/a.woff2' },
        { kind: 'url', family: 'B', url: 'https://f/b.woff2' },
      ],
    };

    const { fetches, config } = planFontStaging(cfg);
    expect(fetches).toEqual([]);
    expect(config.faces).toEqual(cfg.faces);
  });
});
