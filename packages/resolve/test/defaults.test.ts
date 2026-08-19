import { describe, it, expect } from 'vitest';
import { createResolver, type AuthoredLibrary, type Resolver } from '../src/index.js';
import { connectionSchema, entitySchema } from '@eraserlabs/protocol/schema';

/**
 * Schema `default` is AJV `useDefaults` on the prepared clone. The authored source stays
 * verbatim — missing stays missing there, and `null` is an explicit value either side.
 */

function library(): AuthoredLibrary {
  return {
    manifest: ['Node', 'Wire'],
    schemas: {
      Node: entitySchema('Node', {
        tone: { type: 'string', enum: ['loud', 'quiet'], default: 'quiet' },
      }),
      Wire: connectionSchema('Wire', {
        end: {
          anyOf: [{ type: 'string', enum: ['arrow', 'triangle'] }, { type: 'null' }],
          default: 'triangle',
        },
      }),
    },
    templates: [
      {
        name: 'Node',
        html: '<template name="Node"><div data-tpl="Node" data-role="body"></div></template>',
        css: '',
      },
      {
        name: 'Wire',
        html: '<template name="Wire"><div data-tpl="Wire" data-role="anchor"></div></template>',
        css: '',
      },
    ],
    baseCss: '',
  };
}

function boot(): Promise<Resolver> {
  return createResolver({ library: library() });
}

describe('schema default', () => {
  it('fills a missing optional enum on the resolved clone only', async () => {
    const resolver = await boot();
    const authored = { tag: 'Node', id: 'n', x: 0, y: 0 };
    const result = await resolver.resolve({ elements: [authored] });
    expect(result.ok, JSON.stringify(result.errors)).toBe(true);
    expect(result.entities![0]!.props.tone).toBe('quiet');
    expect(result.authored![0]!.source).not.toHaveProperty('tone');
    expect(Object.hasOwn(authored, 'tone')).toBe(false);
  });

  it('keeps an authored value, including null on a nullable anyOf', async () => {
    const resolver = await boot();
    const loud = await resolver.resolve({
      elements: [{ tag: 'Node', id: 'n', x: 0, y: 0, tone: 'loud' }],
    });
    expect(loud.ok, JSON.stringify(loud.errors)).toBe(true);
    expect(loud.entities![0]!.props.tone).toBe('loud');

    const wire = await resolver.resolve({
      elements: [
        { tag: 'Node', id: 'n', x: 0, y: 0 },
        { tag: 'Wire', id: 'w', from: 'n', to: 'n', end: null },
      ],
    });
    expect(wire.ok, JSON.stringify(wire.errors)).toBe(true);
    expect(wire.connections![0]!.props.end).toBeNull();
    expect(wire.authored!.find((r) => r.kind === 'connection')!.source.end).toBeNull();
  });

  it('fills a missing nullable anyOf with the schema default', async () => {
    const resolver = await boot();
    const result = await resolver.resolve({
      elements: [
        { tag: 'Node', id: 'n', x: 0, y: 0 },
        { tag: 'Wire', from: 'n', to: 'n' },
      ],
    });
    expect(result.ok, JSON.stringify(result.errors)).toBe(true);
    expect(result.connections![0]!.props.end).toBe('triangle');
    expect(result.authored!.find((r) => r.kind === 'connection')!.source).not.toHaveProperty('end');
  });
});
