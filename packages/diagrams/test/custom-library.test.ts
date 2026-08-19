import { describe, expect, it } from 'vitest';
import { createResolver, prepareLibrary, ERROR_CODE, type Resolver } from '@eraserlabs/resolve';
import { stubIconLoader } from './support/stubIcons.js';
import { buildRenderPageSetup } from '../src/index.js';
import { kanbanLibrary, kanbanNormalizers, kanbanScene } from './support/kanban.js';

/**
 * The engine against a foreign vocabulary: hand-written JSON Schema, custom tags, custom prop
 * names, custom normalizers. Everything asserted here is stock-free — if any pipeline stage were
 * wired to Eraser tag or prop names, these would fail.
 */

function buildKanbanResolver(): Promise<Resolver> {
  return createResolver({
    library: kanbanLibrary,
    normalizers: kanbanNormalizers,
    iconLoader: stubIconLoader,
  });
}

describe('custom library', () => {
  it('lints and prepares without touching the stock library', () => {
    const prepared = prepareLibrary(kanbanLibrary);

    expect(prepared.manifest).toEqual(['Column', 'Card', 'Flow', 'Pill']);
    expect(Object.keys(prepared.schemas)).toEqual(['Column', 'Card', 'Flow']);
  });

  it('builds the page registry from markup alone — kind never crosses into the page', () => {
    const setup = buildRenderPageSetup(prepareLibrary(kanbanLibrary));

    expect(Object.keys(setup.templates).sort()).toEqual(['Card', 'Column', 'Flow', 'Pill']);

    for (const template of Object.values(setup.templates)) {
      expect(Object.keys(template).sort()).toEqual(['css', 'html']);
    }
  });

  it('registers the custom tags with their required props', async () => {
    const resolver = await buildKanbanResolver();

    expect(resolver.registryInfo().tags).toEqual([
      {
        tag: 'Column',
        kind: 'entity',
        requiredProps: ['id', 'x', 'y', 'heading'],
        container: true,
      },
      { tag: 'Card', kind: 'entity', requiredProps: ['id', 'x', 'y', 'title'] },
      { tag: 'Flow', kind: 'connection', requiredProps: ['from', 'to'] },
    ]);
    expect(resolver.tagSchema('Card')).toBe(kanbanLibrary.schemas['Card']);
    expect(resolver.tagSchema('Shape')).toBeUndefined();

    const flowProperties = (
      kanbanLibrary.schemas['Flow'] as { properties?: Record<string, unknown> }
    ).properties;
    expect(flowProperties).not.toHaveProperty('width');
    expect(flowProperties).not.toHaveProperty('height');
  });

  it('resolves a scene: derives, sanitizes, cross-refs, and inlines icons', async () => {
    const resolver = await buildKanbanResolver();
    const result = await resolver.resolve(kanbanScene);

    expect(result.ok, JSON.stringify(result.errors)).toBe(true);

    const entities = Object.fromEntries((result.entities ?? []).map((el) => [el.id, el]));

    // Derived by the library's own normalizer, from its own enum.
    expect(entities['card-a']!.props).toMatchObject({ accent: '#ef4444', stripePx: 6 });
    expect(entities['card-b']!.props).toMatchObject({ accent: '#3b82f6', stripePx: 2 });

    // Content policy on a custom prop name.
    expect(entities['card-a']!.props['title']).toBe('Swap &lt;b&gt;schema&lt;/b&gt;');

    // Containment survives as a layout relationship, and the icon rides the sidecar.
    expect(entities['todo']!.isContainer).toBe(true);
    expect(entities['card-a']!.isContainer).toBeUndefined();
    expect(entities['card-a']!.containerId).toBe('todo');
    expect(Object.keys(result.icons ?? {})).toEqual(['lucide-server']);
    expect(result.meta.iconsInlined).toBe(1);
  });

  it('uses the schema-declared kind for connection reference rules', async () => {
    const resolver = await buildKanbanResolver();
    const result = await resolver.validate({
      elements: [
        ...kanbanScene.elements,
        { tag: 'Flow', id: 'flow-2', from: 'flow-1', to: 'card-b' },
        { tag: 'Flow', id: 'flow-3', from: 'card-a', to: 'nobody' },
      ],
    });

    expect(result.errors.map((e) => e.code)).toEqual([
      ERROR_CODE.REF_TO_CONNECTION,
      ERROR_CODE.MISSING_REF,
    ]);
  });

  it('resolves a connection without an authored id to a concrete internal identity', async () => {
    const resolver = await buildKanbanResolver();
    const result = await resolver.resolve({
      elements: [
        { tag: 'Card', id: 'a', x: 0, y: 0, title: 'a' },
        { tag: 'Card', id: 'b', x: 200, y: 0, title: 'b' },
        { tag: 'Flow', from: 'a', to: 'b' },
      ],
    });

    expect(result.ok, JSON.stringify(result.errors)).toBe(true);
    const flow = result.connections?.find((element) => element.tag === 'Flow');
    expect(flow?.id).toEqual(expect.any(String));
    expect(flow?.id).not.toHaveLength(0);
  });

  it('respects authored isContainer on tags that never declared the property', async () => {
    const resolver = await buildKanbanResolver();
    const optedIn = await resolver.resolve({
      elements: [
        { tag: 'Card', id: 'box', x: 0, y: 0, title: 'box', isContainer: true },
        { tag: 'Card', id: 'child', x: 10, y: 10, title: 'child', containerId: 'box' },
      ],
    });

    expect(optedIn.ok, JSON.stringify(optedIn.errors)).toBe(true);
    expect(optedIn.entities?.find((el) => el.id === 'box')?.isContainer).toBe(true);

    const optedOut = await resolver.validate({
      elements: [
        { tag: 'Column', id: 'col', x: 0, y: 0, heading: 'h', isContainer: false },
        { tag: 'Card', id: 'child', x: 10, y: 10, title: 'child', containerId: 'col' },
      ],
    });

    expect(optedOut.errors.map((e) => e.code)).toEqual([ERROR_CODE.NOT_CONTAINER]);
  });

  it('applies the engine guards to custom props', async () => {
    const resolver = await buildKanbanResolver();
    const result = await resolver.validate({
      elements: [
        { tag: 'Sticky', id: 'x', x: 0, y: 0 },
        { tag: 'Card', id: 'bad-enum', x: 0, y: 0, title: 't', priority: 'urgent' },
        { tag: 'Column', id: 'bad-color', x: 0, y: 0, heading: 'h', tint: 'red; }' },
      ],
    });

    expect(result.errors.map((e) => e.code)).toEqual([
      ERROR_CODE.UNKNOWN_TAG,
      ERROR_CODE.SCHEMA,
      ERROR_CODE.INVALID_COLOR,
    ]);
  });
});
