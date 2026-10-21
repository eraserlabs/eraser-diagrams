import { describe, it, expect } from 'vitest';
import { createResolver, ERROR_CODE } from '@eraserlabs/resolve';
import { stockLibrary, stockNormalizers } from '../src/index.js';

describe('stock library partial resolution', () => {
  it('resolves standalone nodes and edges with their original external references', async () => {
    const resolver = await createResolver({ library: stockLibrary, normalizers: stockNormalizers });
    const input = {
      elements: [
        {
          tag: 'Shape',
          id: 'node',
          x: 0,
          y: 0,
          containerId: 'outside',
          texts: [{ text: '**Node**' }],
        },
        { tag: 'Relationship', id: 'edge', from: 'omitted-a', to: 'omitted-b', label: 'calls' },
      ],
    };
    const result = await resolver.resolve(input, { partial: true });
    expect(result.ok).toBe(true);
    expect(result.entities![0]).toMatchObject({ id: 'node', containerId: 'outside' });
    expect(result.connections![0]!.props).toMatchObject({ from: 'omitted-a', to: 'omitted-b' });
    expect((await resolver.validate(input, { partial: true })).ok).toBe(true);
    expect((await resolver.resolve(input)).errors.map((error) => error.code)).toContain(
      ERROR_CODE.MISSING_REF,
    );
  });

  it('rejects knowably invalid references even in a one-element subset', async () => {
    const resolver = await createResolver({ library: stockLibrary, normalizers: stockNormalizers });
    for (const [element, code] of [
      [{ tag: 'Shape', id: 'node', x: 0, y: 0, containerId: 'node' }, ERROR_CODE.CONTAINER_CYCLE],
      [
        { tag: 'Relationship', id: 'edge', from: 'edge', to: 'outside' },
        ERROR_CODE.REF_TO_CONNECTION,
      ],
      [{ tag: 'Relationship', id: 'edge', from: 42, to: 'outside' }, ERROR_CODE.SCHEMA],
    ] as const) {
      const input = { elements: [element] };
      for (const result of [
        await resolver.resolve(input, { partial: true }),
        await resolver.validate(input, { partial: true }),
      ]) {
        expect(result.ok).toBe(false);
        expect(result.errors.map((error) => error.code)).toContain(code);
      }
    }
  });
});
