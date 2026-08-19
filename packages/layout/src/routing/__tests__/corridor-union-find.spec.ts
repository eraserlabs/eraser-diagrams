import { createUnionFind } from '../corridor/unionFind.js';

describe('routing corridor union-find', () => {
  it('supports explicit directed and minimum-root union policies', () => {
    const unionFind = createUnionFind();
    unionFind.reset(5);

    expect(unionFind.unionInto(3, 1)).toBe(3);
    expect(unionFind.unionInto(1, 4)).toBe(3);
    expect(unionFind.find(4)).toBe(3);

    expect(unionFind.unionMin(2, 4)).toBe(2);
    expect(unionFind.find(1)).toBe(2);
    expect(unionFind.find(3)).toBe(2);
  });

  it('resets and grows the reusable parent buffer', () => {
    const unionFind = createUnionFind();
    unionFind.reset(4);
    unionFind.unionMin(3, 2);
    expect(unionFind.find(3)).toBe(2);

    unionFind.reset(4);
    expect([0, 1, 2, 3].map(unionFind.find)).toEqual([0, 1, 2, 3]);
  });
});
