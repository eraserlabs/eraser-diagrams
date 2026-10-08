import { describe, it, expect } from 'vitest';
import { sanitizeSvg } from '../src/icons/svg-sanitize.js';
import { stageIcons, PLACEHOLDER_GLYPH, type IconCache } from '../src/pipeline/icons.js';
import type { PipelineElement } from '../src/pipeline/element.js';
import type { PolicyEntry } from '../src/types.js';

const ICON_POLICY: Record<string, PolicyEntry[]> = {
  Icon: [{ pointer: '/name', kind: 'icon-name' }],
};

function iconElement(name: string, index = 0): PipelineElement {
  return { index, path: `/${index}`, tag: 'Icon', kind: 'entity', element: { name } };
}

const CLEAN_SVG = '<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>';

describe('icon stage (loader + cache model)', () => {
  it('loads, sanitizes, caches, and ships the SVG once in the sidecar', async () => {
    const calls: string[] = [];
    const cache: IconCache = new Map();

    const loader = async (name: string): Promise<string> => {
      calls.push(name);

      return CLEAN_SVG;
    };

    const first = await stageIcons(
      [iconElement('db', 0), iconElement('db', 1)],
      ICON_POLICY,
      cache,
      loader,
      'resolve',
      'placeholder',
    );
    expect(first.icons['db']).toBe('<svg viewBox="0 0 1 1"><path d="M0 0"></path></svg>');
    expect(first.inlined).toBe(1);
    expect(calls).toEqual(['db']);

    // Second request: served from the cache, no loader call.
    await stageIcons([iconElement('db')], ICON_POLICY, cache, loader, 'resolve', 'placeholder');
    expect(calls).toEqual(['db']);
  });

  it('caches a loader failure as a negative entry and never refetches', async () => {
    const calls: string[] = [];
    const cache: IconCache = new Map();

    const loader = async (name: string): Promise<string> => {
      calls.push(name);
      throw new Error('404');
    };

    const first = await stageIcons(
      [iconElement('gone')],
      ICON_POLICY,
      cache,
      loader,
      'resolve',
      'placeholder',
    );
    expect(first.warnings.some((w) => w.code === 'W_UNKNOWN_ICON')).toBe(true);
    expect(first.icons['gone']).toBe(PLACEHOLDER_GLYPH);

    await stageIcons([iconElement('gone')], ICON_POLICY, cache, loader, 'resolve', 'placeholder');
    expect(calls).toEqual(['gone']);
  });

  it('drops a hostile SVG at the sanitizer and treats the name as unknown', async () => {
    const cache: IconCache = new Map();
    const loader = async (): Promise<string> => '<svg><script>alert(1)</script></svg>';

    const r = await stageIcons(
      [iconElement('evil')],
      ICON_POLICY,
      cache,
      loader,
      'resolve',
      'error',
    );
    expect(r.errors.some((e) => e.code === 'E_UNKNOWN_ICON')).toBe(true);
    expect(cache.get('evil')).toBeNull();
  });

  it('validate mode never calls the loader and only reports cache-known misses', async () => {
    const calls: string[] = [];
    const cache: IconCache = new Map([['known-missing', null]]);

    const loader = async (name: string): Promise<string> => {
      calls.push(name);

      return CLEAN_SVG;
    };

    const r = await stageIcons(
      [iconElement('never-seen', 0), iconElement('known-missing', 1)],
      ICON_POLICY,
      cache,
      loader,
      'validate',
      'placeholder',
    );
    expect(calls).toEqual([]);
    // never-seen: skipped (validate does not fetch); known-missing: warned from the negative entry.
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]!.path).toBe('/1/name');
  });

  it('without a loader every name falls to the onUnknownIcon policy', async () => {
    const r = await stageIcons(
      [iconElement('anything')],
      ICON_POLICY,
      new Map(),
      undefined,
      'resolve',
      'placeholder',
    );
    expect(r.warnings.some((w) => w.code === 'W_UNKNOWN_ICON')).toBe(true);
    expect(r.icons['anything']).toBe(PLACEHOLDER_GLYPH);
  });
});

describe('svg sanitizer (fail-closed)', () => {
  it('accepts a clean single-root svg', () => {
    expect(sanitizeSvg('<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>').ok).toBe(true);
  });
  it('rejects scripts, handlers, external refs, and multiple roots', () => {
    expect(sanitizeSvg('<svg><script>x</script></svg>').ok).toBe(false);
    expect(sanitizeSvg('<svg onload="x"></svg>').ok).toBe(false);
    expect(sanitizeSvg('<svg><image href="http://evil/x.png"/></svg>').ok).toBe(false);
    expect(sanitizeSvg('<svg></svg><svg></svg>').ok).toBe(false);
    expect(sanitizeSvg('<div>not svg</div>').ok).toBe(false);
  });
});

const SVG_BYPASSES = [
  '<svg xmlns="http://www.w3.org/2000/svg"><svg/onload=document.body.setAttribute("data-poc","executed")></svg></svg>',
  '<svg/onload=alert(1)></svg>',
  '<svg><g/onload="alert(1)"></g></svg>',
  '<svg><g ONCLICK=alert(1)></g></svg>',
  '<svg><svg></svg></svg>',
  '<svg><use href=javascript:alert(1) /></svg>',
  '<svg><use href="&#106;avascript:alert(1)"/></svg>',
  '<svg><use href="https://example.com/icon.svg#x"/></svg>',
  '<svg><path fill="url(https://example.com/x)"/></svg>',
  '<svg><path style="fill:u\\72l(https://example.com/x)"/></svg>',
  '<svg><path style="fill:URL(&#104;ttps://example.com/x)"/></svg>',
  '<svg><animate attributeName="href" values="javascript:alert(1)"/></svg>',
  '<svg><set attributeName="onload" to="alert(1)"/></svg>',
  '<svg><foreignObject><div>HTML</div></foreignObject></svg>',
  '<svg><style>body{display:none}</style></svg>',
  '<svg><image href="data:image/svg+xml,evil"/></svg>',
  '<svg><a target="_top" href="https://example.com">link</a></svg>',
  '<svg></svg><img src=x onerror=alert(1)>',
  '<!DOCTYPE svg><svg></svg>',
];

describe('parsed SVG security policy', () => {
  it.each(SVG_BYPASSES)('rejects %s', (svg) => {
    expect(sanitizeSvg(svg).ok).toBe(false);
  });

  it('preserves static drawing features and local references', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 24 24"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient><clipPath id="c"><rect width="24" height="24"/></clipPath></defs><path id="p" d="M0 0" fill="url(#g)" clip-path="url(#c)" style="stroke:rgb(0, 0, 0);stroke-width:2"/><use xlink:href="#p"/></svg>';
    const result = sanitizeSvg(svg);
    expect(result.ok).toBe(true);
    expect(result.svg).toContain('url(#g)');
    expect(result.svg).toContain('xlink:href="#p"');
    expect(sanitizeSvg(result.svg!).svg).toBe(result.svg);
  });

  it('enforces the size limit in UTF-8 bytes', () => {
    expect(sanitizeSvg(`<svg><title>${'é'.repeat(33 * 1024)}</title></svg>`).ok).toBe(false);
  });

  it('negative-caches rejected icons and uses the placeholder', async () => {
    const cache: IconCache = new Map();
    let calls = 0;
    const loader = async () => {
      calls++;
      return SVG_BYPASSES[0]!;
    };
    for (let i = 0; i < 2; i++) {
      const result = await stageIcons(
        [iconElement('evil')],
        ICON_POLICY,
        cache,
        loader,
        'resolve',
        'placeholder',
      );
      expect(result.icons['evil']).toBe(PLACEHOLDER_GLYPH);
      expect(result.warnings[0]?.code).toBe('W_UNKNOWN_ICON');
    }
    expect(cache.get('evil')).toBeNull();
    expect(calls).toBe(1);
  });
});

it('rejects excessive nesting before serialization', () => {
  expect(sanitizeSvg(`<svg>${'<g>'.repeat(100)}${'</g>'.repeat(100)}</svg>`).ok).toBe(false);
});
