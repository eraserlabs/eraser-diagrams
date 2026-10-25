import { describe, expect, it } from 'vitest';
import {
  createResolver,
  scaleColorForTheme,
  setColorLightness,
  type AuthoredLibrary,
} from '../src/index.js';
import { entitySchema } from '@eraserlabs/protocol/schema';
import { CssColor, PaletteColor } from '../src/schema/index.js';

const library: AuthoredLibrary = {
  manifest: ['Tile'],
  schemas: {
    Tile: entitySchema('Tile', {
      color: PaletteColor,
      fill: CssColor,
      text: { type: 'string', 'x-content': 'plain' },
      runs: {
        type: 'array',
        items: { type: 'object', properties: { color: CssColor }, additionalProperties: false },
      },
      badge: { type: 'object', properties: { background: CssColor }, additionalProperties: false },
    }),
  },
  templates: [
    {
      name: 'Tile',
      html: '<template name="Tile"><div data-tpl="Tile" data-role="body">{{text}}</div></template>',
      css: '',
    },
  ],
  subTemplates: {},
  baseCss: '',
  palette: { brand: '#2866c4' },
};

async function resolver() {
  return createResolver({
    library,
    normalizers: {
      Tile: (element) => {
        if (typeof element.color === 'string') {
          element.fill ??= setColorLightness(element.color, 0.85);
        }
      },
    },
  });
}

describe('schema-wide presentation colors', () => {
  it('transforms derived and nested paints once while preserving source and noncolor content', async () => {
    const r = await resolver();
    const source = {
      elements: [
        {
          tag: 'Tile',
          id: 'a',
          x: 0,
          y: 0,
          color: 'brand',
          text: '#ffffff',
          runs: [{ color: 'hsl(0, 0%, 100%)' }, { color: 'rgba(0, 0, 0, 0.125)' }],
          badge: { background: '#ffffff' },
        },
      ],
    };
    const original = structuredClone(source);
    const dark = await r.resolve(source, { theme: 'dark' });
    expect(dark.ok, JSON.stringify(dark.errors)).toBe(true);
    const e = dark.entities![0]!;
    expect(e.theme).toBe('dark');
    expect(e.props).toMatchObject({
      color: '#407edd',
      text: '#ffffff',
      fill: scaleColorForTheme(setColorLightness('#2866c4', 0.85), 'dark'),
      runs: [{ color: '#171717' }, { color: 'rgba(255, 255, 255, 0.125)' }],
      badge: { background: '#171717' },
    });
    expect(source).toEqual(original);
    expect(dark.authored![0]!.source).toEqual(original.elements[0]);
    const light = await r.resolve(source);
    expect(light.entities![0]!.theme).toBe('light');
    expect(light.entities![0]!.props.color).toBe('#2866c4');
    expect((await r.resolve(source, { theme: 'dark' })).entities).toEqual(dark.entities);
    expect(r.resolveForLayout(source, { theme: 'dark' }).entities).toEqual(dark.entities);
  });

  it('resolves palette tokens and equivalent literals identically; explicit fill wins', async () => {
    const r = await resolver();
    const base = { tag: 'Tile', id: 'a', x: 0, y: 0, fill: '#00ffff' };
    const token = await r.resolve({ elements: [{ ...base, color: 'brand' }] }, { theme: 'dark' });
    const literal = await r.resolve(
      { elements: [{ ...base, color: '#2866c4' }] },
      { theme: 'dark' },
    );
    expect(token.entities).toEqual(literal.entities);
    expect(token.entities![0]!.props.fill).toBe(scaleColorForTheme('#00ffff', 'dark'));
  });

  it('rejects invalid colors before presentation and retains strict/partial validation', async () => {
    const r = await resolver();
    const input = {
      elements: [{ tag: 'Tile', id: 'a', x: 0, y: 0, containerId: 'missing', color: '#000000' }],
    };
    expect((await r.resolve(input, { theme: 'dark' })).ok).toBe(false);
    expect((await r.resolve(input, { theme: 'dark', partial: true })).ok).toBe(true);
    const invalid = await r.resolve(
      { elements: [{ tag: 'Tile', id: 'a', x: 0, y: 0, runs: [{ color: 'not-a-color' }] }] },
      { theme: 'dark', partial: true },
    );
    expect(invalid.ok).toBe(false);
    expect(invalid.entities).toBeUndefined();
  });
});
