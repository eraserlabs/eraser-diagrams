import { describe, it, expect, beforeAll } from 'vitest';
import { tagSchemas } from '../src/library/index.js';
import type { Resolver } from '@eraserlabs/resolve';
import { buildTestResolver } from './helper.js';
import { allTagsDocument } from './support/documents.js';

let resolver: Resolver;
beforeAll(async () => {
  resolver = await buildTestResolver();
});

describe('stage 1 — input shape', () => {
  it('rejects a body that is not a recognized envelope', async () => {
    const r = await resolver.validate({ tag: 'Shape' });
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.code).toBe('E_ENVELOPE');
  });

  it('accepts the elements envelope and the split envelope, and rejects a bare array', async () => {
    const elements = [
      { tag: 'Shape', id: 'a', x: 0, y: 0 },
      { tag: 'Shape', id: 'b', x: 200, y: 0 },
      { tag: 'Relationship', from: 'a', to: 'b' },
    ];

    expect((await resolver.validate({ elements })).ok).toBe(true);
    expect((await resolver.validate({ title: 'demo', elements })).ok).toBe(true);
    expect(
      (
        await resolver.validate({
          entities: elements.slice(0, 2),
          connections: elements.slice(2),
        })
      ).ok,
    ).toBe(true);

    // The bare array is not a third form: it is an envelope error with a teaching message.
    const bare = await resolver.validate(elements);
    expect(bare.ok).toBe(false);
    expect(bare.errors[0]?.code).toBe('E_ENVELOPE');
    expect(bare.errors[0]?.message).toBe(
      'Input must be an object: wrap the array in { "elements": [...] }.',
    );
  });

  it('rejects prototype-pollution keys anywhere', async () => {
    // Built via JSON.parse so `__proto__` is a real own key (a JS object literal would special-case it).
    const hostile = JSON.parse(
      '{"elements":[{"tag":"Shape","id":"s","x":0,"y":0,"texts":[{"text":"x","__proto__":{}}]}]}',
    );
    const r = await resolver.validate(hostile);
    expect(r.errors.some((e) => e.code === 'E_FORBIDDEN_KEY')).toBe(true);
  });
});

describe('stage 2 — dispatch (US2)', () => {
  it('suggests the closest tag for a misspelling', async () => {
    const r = await resolver.validate({ elements: [{ tag: 'Shpe', id: 'x', x: 0, y: 0 }] });
    const err = r.errors.find((e) => e.code === 'E_UNKNOWN_TAG');
    expect(err?.suggestion).toBe('Shape');
    expect(err?.message).toContain('Shpe');
  });

  it('flags a missing tag', async () => {
    const r = await resolver.validate({ elements: [{ id: 'x', x: 0, y: 0 }] });
    expect(r.errors[0]?.code).toBe('E_MISSING_TAG');
  });
});

describe('stage 3 — schema matrix', () => {
  it('accepts a document holding one of every tag', async () => {
    const r = await resolver.validate(allTagsDocument);
    expect(r.ok, JSON.stringify(r.errors, null, 2)).toBe(true);
  });

  it('every tag has a compiled schema', async () => {
    const info = resolver.registryInfo();
    expect(info.tags.map((t) => t.tag).sort()).toEqual(Object.keys(tagSchemas).sort());
  });

  it('requires positioned stock entities and keeps connection ids optional', () => {
    const info = resolver.registryInfo();

    for (const tag of info.tags) {
      if (tag.kind === 'entity') {
        expect(tag.requiredProps, tag.tag).toEqual(expect.arrayContaining(['id', 'x', 'y']));
        expect(tag.requiredProps, tag.tag).not.toContain('width');
        expect(tag.requiredProps, tag.tag).not.toContain('height');
        if (tag.tag === 'Group' || tag.tag === 'Lane' || tag.tag === 'Pool') {
          expect(tag.container, tag.tag).toBe(true);
        } else {
          expect(tag.container, tag.tag).toBeUndefined();
        }
      } else {
        expect(tag.requiredProps, tag.tag).toEqual(expect.arrayContaining(['from', 'to']));
        expect(tag.requiredProps, tag.tag).not.toContain('id');
        expect(tag.container, tag.tag).toBeUndefined();
        const schema = resolver.tagSchema(tag.tag) as {
          properties?: Record<string, unknown>;
        };
        expect(schema.properties, tag.tag).not.toHaveProperty('width');
        expect(schema.properties, tag.tag).not.toHaveProperty('height');
      }
    }
  });

  it('reports a bad enum with a did-you-mean suggestion', async () => {
    const r = await resolver.validate({
      elements: [{ tag: 'Shape', id: 's', x: 0, y: 0, shape: 'rectangel' }],
    });
    const err = r.errors.find((e) => e.code === 'E_SCHEMA' && e.path.endsWith('/shape'));
    expect(err?.suggestion).toBe('rectangle');
  });

  it('reports a missing required property', async () => {
    const r = await resolver.validate({ elements: [{ tag: 'Textbox', id: 't', x: 0, y: 0 }] }); // Textbox requires `text`
    expect(r.errors.some((e) => e.code === 'E_SCHEMA' && /text/.test(e.message))).toBe(true);
  });

  it.each(['x', 'y', 'width', 'height'] as const)('rejects negative %s', async (property) => {
    const r = await resolver.validate({
      elements: [{ tag: 'Shape', id: 's', x: 0, y: 0, width: 10, height: 10, [property]: -1 }],
    });
    expect(
      r.errors.some((e) => e.code === 'E_SCHEMA' && e.path === `/elements/0/${property}`),
    ).toBe(true);
  });

  it.each(['x', 'y'] as const)('rejects an entity without required %s', async (property) => {
    const input = { tag: 'Shape', id: 'positioned', x: 10, y: 20 };
    delete input[property];
    const r = await resolver.validate({ elements: [input] });

    expect(r.errors.some((e) => e.code === 'E_SCHEMA' && /required/.test(e.message))).toBe(true);
  });

  it('accepts positioned entities without authored width or height', async () => {
    const r = await resolver.resolve({
      elements: [{ tag: 'Shape', id: 'intrinsic-size', x: 10, y: 20 }],
    });

    expect(r.ok, JSON.stringify(r.errors)).toBe(true);
    expect(r.entities?.[0]).toMatchObject({ x: 10, y: 20 });
    expect(r.entities?.[0]).not.toHaveProperty('width');
    expect(r.entities?.[0]).not.toHaveProperty('height');
  });

  it('accepts a connection without an authored id', async () => {
    const r = await resolver.validate({
      elements: [
        { tag: 'Shape', id: 'a', x: 0, y: 0 },
        { tag: 'Shape', id: 'b', x: 100, y: 0 },
        { tag: 'Relationship', from: 'a', to: 'b' },
      ],
    });

    expect(r.ok, JSON.stringify(r.errors)).toBe(true);
  });

  it('requires at least two strict object points when connection geometry is authored', async () => {
    const entities = [
      { tag: 'Shape', id: 'a', x: 0, y: 0 },
      { tag: 'Shape', id: 'b', x: 100, y: 0 },
    ];
    const valid = await resolver.validate({
      elements: [
        ...entities,
        {
          tag: 'Relationship',
          from: 'a',
          to: 'b',
          points: [
            { x: 10, y: -20 },
            { x: 90, y: -20 },
          ],
        },
      ],
    });
    const tuple = await resolver.validate({
      elements: [
        ...entities,
        {
          tag: 'Relationship',
          from: 'a',
          to: 'b',
          points: [
            [10, 0],
            [90, 0],
          ],
        },
      ],
    });
    const tooShort = await resolver.validate({
      elements: [
        ...entities,
        { tag: 'Relationship', from: 'a', to: 'b', points: [{ x: 10, y: 0 }] },
      ],
    });
    const missingCoordinate = await resolver.validate({
      elements: [
        ...entities,
        {
          tag: 'Relationship',
          from: 'a',
          to: 'b',
          points: [{ x: 10 }, { x: 90, y: 0 }],
        },
      ],
    });

    expect(valid.ok, JSON.stringify(valid.errors)).toBe(true);
    expect(tuple.errors.some((e) => e.code === 'E_SCHEMA')).toBe(true);
    expect(tooShort.errors.some((e) => e.code === 'E_SCHEMA')).toBe(true);
    expect(missingCoordinate.errors.some((e) => e.code === 'E_SCHEMA')).toBe(true);
  });

  it('rejects containerId on a schema-declared connection', async () => {
    const r = await resolver.validate({
      elements: [
        { tag: 'Shape', id: 'a', x: 0, y: 0 },
        { tag: 'Shape', id: 'b', x: 100, y: 0 },
        { tag: 'Relationship', id: 'r', from: 'a', to: 'b', containerId: null },
      ],
    });

    expect(r.errors.some((error) => error.code === 'E_SCHEMA')).toBe(true);
  });

  it('collects multiple problems in one pass', async () => {
    const r = await resolver.validate({
      elements: [
        { tag: 'Textbox', id: 't', x: 0, y: 0 }, // missing text
        { tag: 'Shape', id: 's', x: 0, y: 0, shape: 'nope' }, // bad enum
      ],
    });
    expect(
      r.errors.some(
        (e) => e.code === 'E_SCHEMA' && e.path.startsWith('/elements/0') && /text/.test(e.message),
      ),
    ).toBe(true);
    expect(r.errors.some((e) => e.code === 'E_SCHEMA' && e.path === '/elements/1/shape')).toBe(
      true,
    );
  });
});

describe('stage 3 — strip-with-warn (US2)', () => {
  it('strips an unknown property and warns with a suggestion', async () => {
    const r = await resolver.validate({
      elements: [{ tag: 'Shape', id: 's', x: 0, y: 0, bgColour: '#fff' }],
    });
    expect(r.ok).toBe(true);
    const w = r.warnings.find((w) => w.code === 'W_UNKNOWN_PROP');
    expect(w?.message).toContain('bgColour');
    expect(w?.suggestion).toBe('bgColor');
  });
});

describe('stage 4 — cross-ref (US2)', () => {
  it('detects duplicate ids', async () => {
    const r = await resolver.validate({
      elements: [
        { tag: 'Shape', id: 'dup', x: 0, y: 0 },
        { tag: 'Shape', id: 'dup', x: 10, y: 0 },
      ],
    });
    expect(r.errors.some((e) => e.code === 'E_DUPLICATE_ID')).toBe(true);
  });

  it('flags an unresolved reference', async () => {
    const r = await resolver.validate({
      elements: [{ tag: 'Relationship', id: 'r', x: 0, y: 0, from: 'ghost', to: 'ghost2' }],
    });
    expect(r.errors.some((e) => e.code === 'E_MISSING_REF')).toBe(true);
  });

  it('rejects a reference that points at a connection', async () => {
    const r = await resolver.validate({
      elements: [
        { tag: 'Shape', id: 's', x: 0, y: 0 },
        { tag: 'Relationship', id: 'r1', x: 0, y: 0, from: 's', to: 's' },
        { tag: 'Relationship', id: 'r2', x: 0, y: 0, from: 'r1', to: 's' },
      ],
    });
    expect(r.errors.some((e) => e.code === 'E_REF_TO_CONNECTION')).toBe(true);
  });

  it('allows a self-referencing connection with no warning', async () => {
    const r = await resolver.validate({
      elements: [
        { tag: 'Shape', id: 's', x: 0, y: 0 },
        { tag: 'Relationship', id: 'r', x: 0, y: 0, from: 's', to: 's' },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.warnings).toHaveLength(0);
  });

  it('containerId: accepted as a validated element reference', async () => {
    const r = await resolver.validate({
      elements: [
        { tag: 'Group', id: 'g', x: 0, y: 0, width: 100, height: 100 },
        { tag: 'Shape', id: 's', x: 10, y: 10, containerId: 'g' },
      ],
    });
    expect(r.ok, JSON.stringify(r.errors)).toBe(true);
  });

  it('stamps isContainer from the tag, including empty containers', async () => {
    const r = await resolver.resolve({
      elements: [
        { tag: 'Group', id: 'g', x: 0, y: 0 },
        { tag: 'Shape', id: 's', x: 10, y: 10 },
      ],
    });
    expect(r.ok, JSON.stringify(r.errors)).toBe(true);
    expect(r.entities?.find((el) => el.id === 'g')?.isContainer).toBe(true);
    expect(r.entities?.find((el) => el.id === 's')?.isContainer).toBeUndefined();
  });

  it('containerId: a non-container target is rejected', async () => {
    const r = await resolver.validate({
      elements: [
        { tag: 'Shape', id: 's', x: 0, y: 0 },
        { tag: 'Shape', id: 'child', x: 10, y: 10, containerId: 's' },
      ],
    });
    expect(r.errors.some((e) => e.code === 'E_NOT_CONTAINER')).toBe(true);
  });

  it('accepts authored isContainer on a group and on a shape used as a container', async () => {
    const r = await resolver.resolve({
      elements: [
        { tag: 'Group', id: 'g', x: 0, y: 0, isContainer: true },
        { tag: 'Shape', id: 'box', x: 200, y: 0, isContainer: true },
        { tag: 'Shape', id: 'child', x: 210, y: 10, containerId: 'box' },
      ],
    });
    expect(r.ok, JSON.stringify(r.errors)).toBe(true);
    expect(r.entities?.find((el) => el.id === 'g')?.isContainer).toBe(true);
    expect(r.entities?.find((el) => el.id === 'box')?.isContainer).toBe(true);
  });

  it('honors isContainer: false on a container tag', async () => {
    const r = await resolver.validate({
      elements: [
        { tag: 'Group', id: 'g', x: 0, y: 0, isContainer: false },
        { tag: 'Shape', id: 'child', x: 10, y: 10, containerId: 'g' },
      ],
    });
    expect(r.errors.some((e) => e.code === 'E_NOT_CONTAINER')).toBe(true);
  });

  it('containerId: null explicitly represents no container and survives resolution', async () => {
    const r = await resolver.resolve({
      elements: [{ tag: 'Shape', id: 's', x: 0, y: 0, containerId: null }],
    });
    expect(r.ok, JSON.stringify(r.errors)).toBe(true);
    expect(r.entities?.[0]?.containerId).toBeNull();
  });

  it('containerId: an unresolved container is a missing ref', async () => {
    const r = await resolver.validate({
      elements: [{ tag: 'Shape', id: 's', x: 0, y: 0, containerId: 'ghost' }],
    });
    expect(r.errors.some((e) => e.code === 'E_MISSING_REF')).toBe(true);
  });

  it('containerId: self-containment and cycles are rejected per cycle member', async () => {
    const self = await resolver.validate({
      elements: [{ tag: 'Group', id: 'g', x: 0, y: 0, containerId: 'g' }],
    });
    expect(self.errors.filter((e) => e.code === 'E_CONTAINER_CYCLE')).toHaveLength(1);

    const cycle = await resolver.validate({
      elements: [
        { tag: 'Group', id: 'a', x: 0, y: 0, containerId: 'b' },
        { tag: 'Group', id: 'b', x: 0, y: 0, containerId: 'a' },
        { tag: 'Shape', id: 'outside', x: 0, y: 0, containerId: 'a' },
      ],
    });
    expect(cycle.errors.filter((e) => e.code === 'E_CONTAINER_CYCLE')).toHaveLength(2);
  });
});
