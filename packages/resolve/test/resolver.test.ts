import { describe, it, expect } from 'vitest';
import { createResolver, ERROR_CODE, type AuthoredLibrary } from '../src/index.js';
import { connectionSchema, entitySchema } from '@eraserlabs/protocol/schema';

/**
 * End-to-end over the public factory: boot a resolver on a two-tag toy library and drive the full
 * input-shape parse → per-element pass → crossref → sanitize → emit pipeline through `resolve()`
 * and `validate()`. The library is deliberately not the Eraser stock set — the engine is
 * tag-agnostic.
 */

const NODE_SCHEMA = entitySchema(
  'Node',
  {
    label: { type: 'string', 'x-content': 'plain' },
  },
  { isContainer: true },
);

const WIRE_SCHEMA = connectionSchema('Wire', {});

const LIBRARY: AuthoredLibrary = {
  manifest: ['Node', 'Wire'],
  schemas: { Node: NODE_SCHEMA, Wire: WIRE_SCHEMA },
  templates: [
    {
      name: 'Node',
      html: '<template name="Node"><div data-tpl="Node" data-role="body">{{label}}</div></template>',
      css: '',
    },
    {
      name: 'Wire',
      html: '<template name="Wire"><div data-tpl="Wire" data-role="body"><svg><path data-role="anchor" d="{{ }}"></path></svg></div></template>',
      css: '',
    },
  ],
  baseCss: '',
  subTemplates: {},
};

describe('createResolver end-to-end', () => {
  it('resolves a valid scene: emitted shape, lifted position fields, escaped content', async () => {
    const resolver = await createResolver({ library: LIBRARY });
    const result = await resolver.resolve({
      elements: [
        { tag: 'Node', id: 'g', x: 0, y: 0, width: 200, height: 100 },
        { tag: 'Node', id: 'a', x: 10, y: 10, containerId: 'g', label: '<b>&"hi"</b>' },
        { tag: 'Wire', id: 'w', from: 'a', to: 'g' },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.meta.elementCount).toBe(3);
    expect(result.entities).toHaveLength(2);
    expect(result.connections).toHaveLength(1);

    // Position fields lift to the top level; everything else lands in props.
    const [g, a] = result.entities!;
    const [w] = result.connections!;
    expect(g).toMatchObject({
      tag: 'Node',
      id: 'g',
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      isContainer: true,
    });
    expect(a).toMatchObject({ tag: 'Node', id: 'a', containerId: 'g', isContainer: true });
    expect(a!.props['containerId']).toBeUndefined();
    expect(a!.props['isContainer']).toBeUndefined();

    // Missing authored geometry stays absent so a later layout policy can place the element.
    expect(w).toMatchObject({ tag: 'Wire', id: 'w' });
    expect(w).not.toHaveProperty('x');
    expect(w).not.toHaveProperty('y');
    expect(w!.props).toMatchObject({ from: 'a', to: 'g' });

    // The plain content policy pre-escapes — the render stage's innerHTML inertness contract.
    expect(a!.props['label']).toBe('&lt;b&gt;&amp;&quot;hi&quot;&lt;/b&gt;');
  });

  it('blocks the payload on cross-element errors and emits nothing', async () => {
    const resolver = await createResolver({ library: LIBRARY });
    const result = await resolver.resolve({
      elements: [
        { tag: 'Node', id: 'a', x: 0, y: 0, containerId: 'b' },
        { tag: 'Node', id: 'b', x: 0, y: 0, containerId: 'a' },
        { tag: 'Wire', id: 'w', from: 'a', to: 'ghost' },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.entities).toBeUndefined();
    expect(result.connections).toBeUndefined();
    expect(result.icons).toBeUndefined();
    expect(result.errors.map((e) => e.code).sort()).toEqual([
      ERROR_CODE.CONTAINER_CYCLE,
      ERROR_CODE.CONTAINER_CYCLE,
      ERROR_CODE.MISSING_REF,
    ]);
  });

  it('accepts both envelope forms and pins issue paths to the submitted shape', async () => {
    const resolver = await createResolver({ library: LIBRARY });

    const plain = await resolver.resolve({ elements: [{ tag: 'Node', id: 'a' }] });
    expect(plain.ok).toBe(true);
    expect(plain.entities).toHaveLength(1);

    const wrapped = await resolver.resolve({ title: 'demo', elements: [{ tag: 'Node', id: 'a' }] });
    expect(wrapped.ok).toBe(true);
    expect(wrapped.warnings).toEqual([]);

    const split = await resolver.resolve({
      entities: [
        { tag: 'Node', id: 'a' },
        { tag: 'Node', id: 'b' },
      ],
      connections: [{ tag: 'Wire', from: 'a', to: 'b' }],
    });
    expect(split.ok).toBe(true);
    expect(split.entities).toHaveLength(2);
    expect(split.connections).toHaveLength(1);

    // Paths reflect the shape that was submitted, list by list.
    const elementsPath = await resolver.validate({ elements: [{ tag: 'Ghost' }] });
    expect(elementsPath.errors[0]).toMatchObject({
      code: ERROR_CODE.UNKNOWN_TAG,
      path: '/elements/0',
      elementIndex: 0,
    });

    const splitPath = await resolver.validate({ entities: [], connections: [{ tag: 'Ghost' }] });
    expect(splitPath.errors[0]).toMatchObject({
      code: ERROR_CODE.UNKNOWN_TAG,
      path: '/connections/0',
      elementIndex: 0,
    });
  });

  it('rejects every unrecognized envelope, and both halves of the split form are required', async () => {
    const resolver = await createResolver({ library: LIBRARY });

    for (const input of [null, 'nope', 42, {}, { nodes: [] }]) {
      const result = await resolver.resolve(input);
      expect(result.ok, JSON.stringify(input)).toBe(false);
      expect(result.errors.map((e) => e.code)).toEqual([ERROR_CODE.ENVELOPE]);
      expect(result.meta.elementCount).toBe(0);
    }

    // A bare array is not a shorthand for anything: it is an envelope error, and the message
    // teaches the wrap rather than performing it.
    const bareArray = await resolver.resolve([{ tag: 'Node', id: 'a' }]);
    expect(bareArray.ok).toBe(false);
    expect(bareArray.errors.map((e) => e.code)).toEqual([ERROR_CODE.ENVELOPE]);
    expect(bareArray.errors[0]?.message).toBe(
      'Input must be an object: wrap the array in { "elements": [...] }.',
    );
    expect(bareArray.errors[0]?.path).toBe('/');
    expect(bareArray.entities).toBeUndefined();

    const halfSplit = await resolver.resolve({ entities: [{ tag: 'Node', id: 'a' }] });
    expect(halfSplit.errors[0]?.code).toBe(ERROR_CODE.ENVELOPE);
    expect(halfSplit.errors[0]?.message).toContain('"connections": []');

    const mixed = await resolver.resolve({ elements: [], entities: [], connections: [] });
    expect(mixed.errors[0]?.code).toBe(ERROR_CODE.ENVELOPE);
    expect(mixed.errors[0]?.message).toContain('never both');
  });

  it('recognizes title, reserves outputs, and warns once on anything else', async () => {
    const resolver = await createResolver({ library: LIBRARY });
    const result = await resolver.resolve({
      title: 'ignored',
      outputs: { png: true },
      layout: 'auto',
      elements: [{ tag: 'Node', id: 'a' }],
    });

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'W_UNKNOWN_KEY', path: '/layout' }),
    ]);
  });

  it('errors when a tag lands in the list for the other kind', async () => {
    const resolver = await createResolver({ library: LIBRARY });
    const result = await resolver.resolve({
      entities: [
        { tag: 'Node', id: 'a' },
        { tag: 'Wire', from: 'a', to: 'a' },
      ],
      connections: [{ tag: 'Node', id: 'b' }],
    });

    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toEqual([
      ERROR_CODE.KIND_MISMATCH,
      ERROR_CODE.KIND_MISMATCH,
    ]);
    expect(result.errors[0]).toMatchObject({ path: '/entities/1', tag: 'Wire' });
    expect(result.errors[0]?.message).toContain('connections');
    expect(result.errors[1]).toMatchObject({ path: '/connections/0', tag: 'Node' });
    expect(result.errors[1]?.message).toContain('entities');
  });

  it('validate() reports the same issues without emitting', async () => {
    const resolver = await createResolver({ library: LIBRARY });

    const bad = await resolver.validate({
      elements: [{ tag: 'Node', id: 'a', x: 0, y: 0, containerId: 'a' }],
    });
    expect(bad.ok).toBe(false);
    expect(bad.errors.map((e) => e.code)).toEqual([ERROR_CODE.CONTAINER_CYCLE]);

    const good = await resolver.validate({ elements: [{ tag: 'Node', id: 'a', x: 0, y: 0 }] });
    expect(good.ok).toBe(true);
    expect(good.errors).toEqual([]);
  });

  it('registryInfo lists schema-declared kinds and required props, tag excluded', async () => {
    const resolver = await createResolver({ library: LIBRARY });

    expect(resolver.registryInfo()).toEqual({
      tags: [
        { tag: 'Node', kind: 'entity', requiredProps: ['id'], container: true },
        { tag: 'Wire', kind: 'connection', requiredProps: ['from', 'to'] },
      ],
    });
  });

  it('synthesizes stable collision-free ids before normalizers for parallel connections', async () => {
    const seenByNormalizer: unknown[] = [];
    const resolver = await createResolver({
      library: LIBRARY,
      normalizers: {
        Wire(element) {
          seenByNormalizer.push(element.id);
        },
      },
    });
    const reserved = '@connection:Wire:a:b:1';
    const input = {
      elements: [
        { tag: 'Node', id: 'a' },
        { tag: 'Node', id: 'b' },
        { tag: 'Node', id: reserved },
        { tag: 'Wire', from: 'a', to: 'b' },
        { tag: 'Wire', from: 'a', to: 'b' },
      ],
    };

    const first = await resolver.resolve(input);
    const second = await resolver.resolve(input);
    const expected = ['@connection:Wire:a:b:1~2', '@connection:Wire:a:b:2'];

    expect(first.ok).toBe(true);
    expect(first.connections?.map(({ id }) => id)).toEqual(expected);
    expect(second.connections?.map(({ id }) => id)).toEqual(expected);
    expect(seenByNormalizer).toEqual([...expected, ...expected]);
  });

  it('treats an explicitly undefined optional connection id as omitted', async () => {
    const resolver = await createResolver({ library: LIBRARY });
    const result = await resolver.resolve({
      elements: [
        { tag: 'Node', id: 'a' },
        { tag: 'Node', id: 'b' },
        { tag: 'Wire', id: undefined, from: 'a', to: 'b' },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.connections?.[0]?.id).toBe('@connection:Wire:a:b:1');
  });

  it('keeps explicit connection-id requirements as authored validation constraints', async () => {
    const identifiedLibrary: TemplateLibrary = {
      ...LIBRARY,
      schemas: {
        ...LIBRARY.schemas,
        Wire: connectionSchema('Wire', {}, { required: ['id'] }),
      },
    };
    const resolver = await createResolver({ library: identifiedLibrary });

    expect(resolver.registryInfo().tags[1]?.requiredProps).toEqual(['id', 'from', 'to']);

    const missing = await resolver.resolve({
      elements: [
        { tag: 'Node', id: 'a' },
        { tag: 'Node', id: 'b' },
        { tag: 'Wire', from: 'a', to: 'b' },
      ],
    });

    expect(missing.ok).toBe(false);
    expect(missing.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: ERROR_CODE.SCHEMA, path: '/elements/2' }),
      ]),
    );
    expect(missing.connections).toBeUndefined();
  });

  it('rejects fields owned by the other element kind', async () => {
    const resolver = await createResolver({ library: LIBRARY });
    const connectionBounds = await resolver.resolve({
      elements: [
        { tag: 'Node', id: 'a' },
        { tag: 'Node', id: 'b' },
        { tag: 'Wire', from: 'a', to: 'b', width: 40, height: 20 },
      ],
    });
    const entityEndpoints = await resolver.resolve({
      elements: [{ tag: 'Node', id: 'a', from: 'left', to: 'right' }],
    });

    expect(connectionBounds.ok).toBe(false);
    expect(connectionBounds.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: ERROR_CODE.SCHEMA, path: '/elements/2' }),
      ]),
    );
    expect(connectionBounds.connections).toBeUndefined();

    expect(entityEndpoints.ok).toBe(false);
    expect(entityEndpoints.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: ERROR_CODE.SCHEMA, path: '/elements/0' }),
      ]),
    );
    expect(entityEndpoints.entities).toBeUndefined();
  });
});
