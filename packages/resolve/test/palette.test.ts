import { describe, it, expect } from 'vitest';
import {
  createResolver,
  prepareLibrary,
  RegistryError,
  SchemaDefinitionError,
  type AuthoredLibrary,
  type Resolver,
} from '../src/index.js';
import { entitySchema, PaletteColor, type JsonSchema } from '@eraserlabs/protocol/schema';

/**
 * Library palettes and the `x-palette` annotation: named colors as inert library data, and a prop
 * whose two arms — a token name, any raw CSS color — unify into one validated CSS-color domain
 * before anything downstream sees the value.
 */

const PALETTE = { blue: '#2866c4', green: '#30a050' };

function library(overrides: Partial<AuthoredLibrary> = {}, color: JsonSchema = PaletteColor) {
  return {
    manifest: ['Node'],
    schemas: {
      Node: entitySchema('Node', {
        color,
        // The same annotation nested under an object and under an array of objects.
        titleProps: { type: 'object', additionalProperties: false, properties: { color } },
        runs: {
          type: 'array',
          items: { type: 'object', additionalProperties: false, properties: { color } },
        },
      }),
    },
    templates: [
      {
        name: 'Node',
        html: '<template name="Node"><div data-tpl="Node" data-role="body" data-color="{{color}}" style="--er-color: {{color}}"></div></template>',
        css: '',
      },
    ],
    baseCss: '',
    palette: PALETTE,
    ...overrides,
  } satisfies AuthoredLibrary;
}

function boot(overrides: Partial<AuthoredLibrary> = {}, color?: JsonSchema): Promise<Resolver> {
  return createResolver({ library: library(overrides, color) });
}

async function props(
  resolver: Resolver,
  element: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await resolver.resolve({
    elements: [{ tag: 'Node', id: 'n', x: 0, y: 0, ...element }],
  });
  expect(result.ok, JSON.stringify(result.errors)).toBe(true);

  return result.entities![0]!.props;
}

describe('library palette — boot validation', () => {
  it('accepts a map of identifier names to strict-grammar colors', () => {
    const prepared = prepareLibrary(library({ palette: { blue: '#2866c4', 'brand-2': 'red' } }));

    expect(prepared.palette).toEqual({ blue: '#2866c4', 'brand-2': 'red' });
    // Null-prototype, so an authored `"constructor"` can never resolve to something inherited.
    expect(Object.getPrototypeOf(prepared.palette!)).toBe(null);
  });

  it('carries no palette when the library declares none', () => {
    const plain = library({ palette: undefined }, { type: 'string', 'x-css-color': true });

    expect(prepareLibrary(plain).palette).toBe(undefined);
  });

  it('rejects a token name outside the identifier charset', () => {
    let error: RegistryError | undefined;

    try {
      prepareLibrary(library({ palette: { 'a b': 'red', '--x': 'red', '': 'red' } }));
    } catch (e) {
      error = e as RegistryError;
    }

    expect(error).toBeInstanceOf(RegistryError);
    expect(error!.issues.map((i) => i.rule)).toEqual([
      'palette-token-name',
      'palette-token-name',
      'palette-token-name',
    ]);
    expect(error!.issues[0]!.message).toContain('"a b"');
    expect(error!.issues[0]!.template).toBe('palette');
  });

  it('rejects a value outside the strict CSS-color grammar, including injection payloads', () => {
    let error: RegistryError | undefined;

    try {
      prepareLibrary(
        library({
          palette: {
            bad: 'not-a-color',
            evil: 'red;background:url(http://x)',
            wrong: 42 as unknown as string,
          },
        }),
      );
    } catch (e) {
      error = e as RegistryError;
    }

    expect(error).toBeInstanceOf(RegistryError);
    expect(error!.issues.map((i) => i.rule)).toEqual([
      'palette-color',
      'palette-color',
      'palette-color',
    ]);
    expect(error!.issues[0]!.message).toBe(
      'token "bad" must map to one CSS color, got "not-a-color"',
    );
  });

  it('rejects a palette that is not an object at all', () => {
    expect(() => prepareLibrary(library({ palette: ['red'] as unknown as never }))).toThrow(
      RegistryError,
    );
  });
});

describe('x-palette — schema definition', () => {
  it('is a definition error in a library that declares no palette', async () => {
    await expect(boot({ palette: undefined })).rejects.toThrow(SchemaDefinitionError);

    const error = await boot({ palette: undefined }).catch((e) => e as SchemaDefinitionError);
    expect(error.issues).toContainEqual({
      path: '/properties/color/x-palette',
      keyword: 'x-palette',
      message: 'requires the library to declare a palette',
    });
  });

  it('may only annotate a string-accepting schema', async () => {
    const error = await boot({}, { type: 'number', 'x-palette': true } as JsonSchema).catch(
      (e) => e as SchemaDefinitionError,
    );

    expect(error.issues).toContainEqual({
      path: '/properties/color/x-palette',
      keyword: 'x-palette',
      message: 'may only annotate a schema that accepts strings',
    });
  });

  it('may not be combined with x-css-color — the two mean different things', async () => {
    const error = await boot({}, {
      type: 'string',
      'x-palette': true,
      'x-css-color': true,
    } as JsonSchema).catch((e) => e as SchemaDefinitionError);

    expect(error.issues).toContainEqual({
      path: '/properties/color/x-palette',
      keyword: 'x-palette',
      message: 'may not be combined with x-css-color on the same schema',
    });
  });

  it('makes the prop style-bindable: both arms land in the CSS-color domain', async () => {
    // The template in `library()` binds `--er-color: {{color}}`; a non-bindable prop would have
    // failed the lint pass and thrown RegistryError at boot.
    await expect(boot()).resolves.toBeTruthy();
  });
});

describe('x-palette — resolution', () => {
  it('translates a token to its palette color in place', async () => {
    const resolver = await boot();

    expect(await props(resolver, { color: 'blue' })).toMatchObject({ color: '#2866c4' });
    expect(await props(resolver, { color: 'green' })).toMatchObject({ color: '#30a050' });
  });

  it('passes a raw CSS color through untouched', async () => {
    const resolver = await boot();

    expect(await props(resolver, { color: 'peachpuff' })).toMatchObject({ color: 'peachpuff' });
    expect(await props(resolver, { color: '#123456' })).toMatchObject({ color: '#123456' });
    expect(await props(resolver, { color: 'rgba(1, 2, 3, 0.5)' })).toMatchObject({
      color: 'rgba(1, 2, 3, 0.5)',
    });
  });

  it('leaves an unauthored prop absent rather than defaulting it', async () => {
    expect(await props(await boot(), {})).not.toHaveProperty('color');
  });

  it('applies at every schema location, including inside arrays', async () => {
    const resolved = await props(await boot(), {
      color: 'blue',
      titleProps: { color: 'green' },
      runs: [{ color: 'blue' }, { color: 'gold' }, {}],
    });

    expect(resolved).toMatchObject({
      color: '#2866c4',
      titleProps: { color: '#30a050' },
      runs: [{ color: '#2866c4' }, { color: 'gold' }, {}],
    });
  });

  it('errors on a string that is neither, with a did-you-mean over the token names', async () => {
    const resolver = await boot();
    const result = await resolver.resolve({
      elements: [{ tag: 'Node', id: 'n', x: 0, y: 0, color: 'blu', runs: [{ color: 'greeen' }] }],
    });

    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => [e.code, e.path, e.suggestion])).toEqual([
      ['E_INVALID_COLOR', '/elements/0/color', 'blue'],
      ['E_INVALID_COLOR', '/elements/0/runs/0/color', 'green'],
    ]);
    expect(result.errors[0]!.message).toBe(
      '"blu" at /elements/0/color is neither a palette token nor a CSS color.',
    );
  });

  it('errors without a suggestion when nothing is close', async () => {
    const result = await (
      await boot()
    ).resolve({ elements: [{ tag: 'Node', id: 'n', x: 0, y: 0, color: 'not-a-colour-at-all' }] });

    expect(result.ok).toBe(false);
    expect(result.errors[0]!.suggestion).toBeUndefined();
  });

  it('looks tokens up exactly, and never through the prototype chain', async () => {
    const resolver = await boot();

    // Case is not folded: "Blue" is not the token, but it IS a CSS named color, so it stands.
    expect(await props(resolver, { color: 'Blue' })).toMatchObject({ color: 'Blue' });

    const polluted = await resolver.resolve({
      elements: [{ tag: 'Node', id: 'n', x: 0, y: 0, color: 'toString' }],
    });
    expect(polluted.ok).toBe(false);
  });

  it('keeps the post-derive safety net: a normalizer writing junk is still caught', async () => {
    const resolver = await createResolver({
      library: library(),
      normalizers: {
        Node: (element) => {
          element.color = 'red;url(evil)';
        },
      },
    });
    const result = await resolver.resolve({ elements: [{ tag: 'Node', id: 'n', x: 0, y: 0 }] });

    expect(result.ok).toBe(false);
    expect(result.errors[0]!.code).toBe('E_INVALID_COLOR');
  });
});
