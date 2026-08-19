import { makeConnectionMapping } from '../layoutManagerUtils.js';
import { LayoutConnection } from '../types.js';

describe('makeConnectionMapping', () => {
  it('skips empty (free) endpoints so they are not registered as entity keys', () => {
    const connections = [
      { id: 'c1', from: 'a', to: 'b', x: 0, y: 0, points: [] },
      { id: 'c2', from: 'a', to: '', x: 0, y: 0, points: [] },
      { id: 'c3', from: '', to: '', x: 0, y: 0, points: [] },
    ] as LayoutConnection[];

    const mapping = makeConnectionMapping(connections);

    // Bound endpoints register; a one-bound connection registers only under its
    // bound entity; a fully free connection registers nowhere.
    expect(mapping['a']).toEqual(['c1', 'c2']);
    expect(mapping['b']).toEqual(['c1']);
    expect(mapping['']).toBeUndefined();
  });
});
