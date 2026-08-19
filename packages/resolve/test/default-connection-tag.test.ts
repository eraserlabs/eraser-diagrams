import { describe, it, expect } from 'vitest';
import {
  createResolver,
  prepareLibrary,
  RegistryError,
  type AuthoredLibrary,
} from '../src/index.js';
import { connectionSchema, entitySchema } from '@eraserlabs/protocol/schema';

/**
 * The split form's tag-less connections: `{ "from": "a", "to": "b" }` dispatches as the library's
 * declared default connection tag. Only the split form defaults — a list must assert the kind
 * before a tag can be inferred — and the declaration itself is boot-checked.
 */

function library(overrides: Partial<AuthoredLibrary> = {}) {
  return {
    manifest: ['Node', 'Edge'],
    schemas: {
      Node: entitySchema('Node', {}, { required: ['x', 'y'] }),
      Edge: connectionSchema('Edge', {}),
    },
    templates: [
      {
        name: 'Node',
        html: '<template name="Node"><div data-tpl="Node" data-role="body"></div></template>',
        css: '',
      },
      {
        name: 'Edge',
        html: '<template name="Edge"><div data-tpl="Edge"><svg><path data-role="anchor" d="{{ }}" /></svg></div></template>',
        css: '',
      },
    ],
    baseCss: '',
    defaultConnectionTag: 'Edge',
    ...overrides,
  } satisfies AuthoredLibrary;
}

const NODES = [
  { tag: 'Node', id: 'a', x: 0, y: 0 },
  { tag: 'Node', id: 'b', x: 100, y: 0 },
];

describe('defaultConnectionTag boot validation', () => {
  it('rejects a default that is not a tag in the library', () => {
    expect(() => prepareLibrary(library({ defaultConnectionTag: 'Nope' }))).toThrow(RegistryError);
    expect(() => prepareLibrary(library({ defaultConnectionTag: 'Nope' }))).toThrow(
      /not a tag in this library/,
    );
  });

  it('rejects an entity-kind default', () => {
    expect(() => prepareLibrary(library({ defaultConnectionTag: 'Node' }))).toThrow(
      /not a connection-kind tag/,
    );
  });

  it('carries a valid default through preparation', () => {
    expect(prepareLibrary(library()).defaultConnectionTag).toBe('Edge');
  });
});

describe('split-form tag defaulting', () => {
  it('dispatches a tag-less connection as the default', async () => {
    const resolver = await createResolver({ library: library() });
    const result = await resolver.resolve({
      entities: NODES,
      connections: [{ from: 'a', to: 'b' }],
    });

    expect(result.ok, JSON.stringify(result.errors)).toBe(true);
    expect(result.connections).toHaveLength(1);
    expect(result.connections![0]!.tag).toBe('Edge');
  });

  it('keeps the authored source tag-less (purity)', async () => {
    const resolver = await createResolver({ library: library() });
    const result = await resolver.resolve({
      entities: NODES,
      connections: [{ from: 'a', to: 'b' }],
    });

    expect(result.ok).toBe(true);
    const authoredConnection = result.authored!.find((r) => r.kind === 'connection')!;
    expect(Object.hasOwn(authoredConnection.source, 'tag')).toBe(false);
  });

  it('an authored tag still wins over the default', async () => {
    const resolver = await createResolver({ library: library() });
    const result = await resolver.resolve({
      entities: NODES,
      connections: [{ tag: 'Edge', from: 'a', to: 'b' }],
    });

    expect(result.ok).toBe(true);
    expect(result.connections![0]!.tag).toBe('Edge');
  });

  it('entities never default', async () => {
    const resolver = await createResolver({ library: library() });
    const result = await resolver.resolve({
      entities: [{ id: 'a', x: 0, y: 0 }],
      connections: [],
    });

    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'E_MISSING_TAG')).toBe(true);
  });

  it('the { elements } form still requires tag', async () => {
    const resolver = await createResolver({ library: library() });
    const result = await resolver.resolve({ elements: [...NODES, { from: 'a', to: 'b' }] });

    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'E_MISSING_TAG')).toBe(true);
  });

  it('without a declared default, the split form errors with a hint', async () => {
    const resolver = await createResolver({
      library: library({ defaultConnectionTag: undefined }),
    });
    const result = await resolver.validate({
      entities: NODES,
      connections: [{ from: 'a', to: 'b' }],
    });

    expect(result.ok).toBe(false);
    const issue = result.errors.find((e) => e.code === 'E_MISSING_TAG')!;
    expect(issue.message).toMatch(/declares no default connection tag/);
  });

  it('registryInfo exposes the default', async () => {
    const withDefault = await createResolver({ library: library() });
    expect(withDefault.registryInfo().defaultConnectionTag).toBe('Edge');

    const without = await createResolver({ library: library({ defaultConnectionTag: undefined }) });
    expect(without.registryInfo().defaultConnectionTag).toBeUndefined();
  });
});
