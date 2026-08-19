import { describe, expect, it } from 'vitest';
import { assignMissingConnectionIds } from '../src/pipeline/identity.js';
import type { PipelineElement } from '../src/pipeline/element.js';

describe('connection identity stage', () => {
  it('distinguishes parallel edges and probes around every explicit id', () => {
    const reserved = '@connection:Wire:a:b:1';
    const items: PipelineElement[] = [
      { index: 0, path: '/0', tag: 'Node', kind: 'entity', element: { id: reserved } },
      { index: 1, path: '/1', tag: 'Wire', kind: 'connection', element: { from: 'a', to: 'b' } },
      { index: 2, path: '/2', tag: 'Wire', kind: 'connection', element: { from: 'a', to: 'b' } },
    ];

    assignMissingConnectionIds(items);

    expect(items.map(({ element }) => element.id)).toEqual([
      reserved,
      '@connection:Wire:a:b:1~2',
      '@connection:Wire:a:b:2',
    ]);
  });

  it('encodes identity parts and leaves authored ids unchanged', () => {
    const items: PipelineElement[] = [
      {
        index: 0,
        path: '/0',
        tag: 'Fancy Wire',
        kind: 'connection',
        element: { id: 'authored', from: 'a/b', to: 'c:d' },
      },
      {
        index: 1,
        path: '/1',
        tag: 'Fancy Wire',
        kind: 'connection',
        element: { from: 'a/b', to: 'c:d' },
      },
    ];

    assignMissingConnectionIds(items);

    expect(items[0]!.element.id).toBe('authored');
    expect(items[1]!.element.id).toBe('@connection:Fancy%20Wire:a%2Fb:c%3Ad:1');
  });
});
