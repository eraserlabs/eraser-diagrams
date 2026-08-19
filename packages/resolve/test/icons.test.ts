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
    expect(first.icons['db']).toBe(CLEAN_SVG);
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
