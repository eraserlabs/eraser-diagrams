import { describe, expect, it } from 'vitest';
import { entitySchema } from '@eraserlabs/protocol/schema';
import {
  createResolver,
  prepareLibrary,
  RegistryError,
  SchemaDefinitionError,
  scaleColorForTheme,
  type AuthoredLibrary,
} from '../src/index.js';
import { CssColor, PaletteColor } from '../src/schema/index.js';

const schema = entitySchema('Tile', { color: PaletteColor });
const library: AuthoredLibrary = {
  manifest: ['Tile'],
  schemas: { Tile: schema },
  renderProps: {
    Tile: {
      fillColor: CssColor,
      paints: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ink: CssColor,
            text: { type: 'string', 'x-content': 'plain' },
          },
        },
      },
    },
  },
  templates: [
    {
      name: 'Tile',
      html: '<template name="Tile"><div data-tpl="Tile" data-role="body" style="--er-fill: {{fillColor}}"></div></template>',
      css: '',
    },
  ],
  baseCss: '',
  palette: { brand: '#2866c4' },
};

const element = { tag: 'Tile', id: 'a', x: 0, y: 0, color: 'brand' };

describe('internal render properties', () => {
  it('lints internal bindings without publishing or admitting internal input properties', async () => {
    const seen: unknown[] = [];
    const resolver = await createResolver({
      library,
      normalizers: {
        Tile: (props) => {
          seen.push(props.fillColor);
          props.fillColor = props.color;
        },
      },
    });
    expect(resolver.library.schemas).toBe(library.schemas);
    expect(resolver.tagSchema('Tile')).toBe(schema);
    expect(schema.properties as object).not.toHaveProperty('fillColor');
    const input = { elements: [{ ...element, fillColor: 'red' }] };
    const result = await resolver.resolve(input, { theme: 'dark' });

    expect(result.ok, JSON.stringify(result.errors)).toBe(true);
    expect(seen).toEqual([undefined]);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'W_UNKNOWN_PROP', path: '/elements/0/fillColor' }),
    );
    expect(result.entities![0]!.props.fillColor).toBe(scaleColorForTheme('#2866c4', 'dark'));
    expect(input.elements[0]!.fillColor).toBe('red');
    expect(result.authored![0]!.source).toEqual(input.elements[0]);
  });

  it('includes nested internal fields in post-normalizer policies', async () => {
    const resolver = await createResolver({
      library,
      normalizers: {
        Tile: (props) => {
          props.paints = [{ ink: '#ffffff', text: '<b>literal</b>' }];
        },
      },
    });
    const result = await resolver.resolve({ elements: [element] }, { theme: 'dark' });
    expect(result.ok, JSON.stringify(result.errors)).toBe(true);
    expect(result.entities![0]!.props.paints).toEqual([
      { ink: '#171717', text: '&lt;b&gt;literal&lt;/b&gt;' },
    ]);
  });

  it('rejects invalid derived colors before presentation', async () => {
    const resolver = await createResolver({
      library,
      normalizers: {
        Tile: (props) => {
          props.fillColor = 'bad-color';
        },
      },
    });
    const result = await resolver.resolve({ elements: [element] }, { theme: 'dark' });
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'E_INVALID_COLOR', path: '/elements/0/fillColor' }),
    );
    expect(result.entities).toBeUndefined();
  });

  it('keeps existing custom libraries unchanged when renderProps is omitted', async () => {
    const { renderProps: _renderProps, ...oldLibrary } = library;
    const authoredSchema = entitySchema('Tile', { color: PaletteColor, fillColor: CssColor });
    const resolver = await createResolver({
      library: { ...oldLibrary, schemas: { Tile: authoredSchema } },
    });
    const result = await resolver.resolve({ elements: [{ ...element, fillColor: '#00ffff' }] });
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.entities![0]!.props.fillColor).toBe('#00ffff');
    expect(resolver.tagSchema('Tile')).toBe(authoredSchema);
  });

  it('still rejects undeclared template bindings', () => {
    const { renderProps: _renderProps, ...withoutRenderProps } = library;
    expect(() => prepareLibrary(withoutRenderProps)).toThrow(RegistryError);
  });

  it.each([
    ['unknown tag', { Missing: { fillColor: CssColor } }],
    ['authored conflict', { Tile: { color: CssColor } }],
    ['implicit authored field', { Tile: { isContainer: { type: 'boolean' } } }],
    ['invalid annotation', { Tile: { fillColor: { type: 'number', 'x-css-color': true } } }],
    ['unsupported schema', { Tile: { fillColor: { type: 'string', $ref: '#/elsewhere' } } }],
    ['palette output', { Tile: { fillColor: PaletteColor } }],
    ['invalid property declaration', { Tile: { fillColor: 'string' } }],
    ['invalid map', []],
    ['invalid entry', { Tile: null }],
    ['forbidden key', JSON.parse('{"Tile":{"__proto__":{"type":"string"}}}')],
    [
      'nested forbidden key',
      JSON.parse(
        '{"Tile":{"paint":{"type":"object","properties":{"constructor":{"type":"string"}}}}}',
      ),
    ],
  ])('rejects %s at library boot', (_name, renderProps) => {
    expect(() => prepareLibrary({ ...library, renderProps } as AuthoredLibrary)).toThrow(
      SchemaDefinitionError,
    );
  });
});
