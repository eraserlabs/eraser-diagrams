import { LayoutManager } from '../LayoutManager.js';
import { buildAlignmentView, type EdgeKind } from '../alignmentUtils.js';
import type { LayoutEntity } from '../types.js';

function entity(
  id: string,
  containerId: string | null,
  x: number,
  y: number,
  width: number,
  height: number,
): LayoutEntity {
  return { id, containerId, x, y, width, height, isContainer: false } as LayoutEntity;
}

function classIds(view: ReturnType<typeof buildAlignmentView>, id: string, kind: EdgeKind) {
  return view.byEntity.get(id)?.[kind]?.ids;
}

describe('buildAlignmentView (level-aware)', () => {
  it('couples same-scope entities on any single shared edge', () => {
    const view = buildAlignmentView([
      entity('a', 'g', 10, 0, 100, 50),
      entity('b', 'g', 10, 80, 60, 50),
    ]);
    expect(classIds(view, 'a', 'left')).toEqual(['a', 'b']);
  });

  it('couples same-scope entities on shared centers', () => {
    const view = buildAlignmentView([
      entity('a', 'g', 0, 0, 100, 50),
      entity('b', 'g', 25, 80, 50, 50),
    ]);
    expect(classIds(view, 'a', 'centerX')).toEqual(['a', 'b']);
  });

  it('rejects a single shared edge across scopes', () => {
    const view = buildAlignmentView([
      // bottoms align at y=100, but nothing else matches — coincidence.
      entity('a', 'aa', 0, 0, 50, 100),
      entity('b', 'bb', 200, 60, 50, 40),
    ]);
    expect(classIds(view, 'a', 'bottom')).toBeUndefined();
    expect(classIds(view, 'b', 'bottom')).toBeUndefined();
  });

  it('couples cross-scope congruent intervals (both edges match the same member)', () => {
    const view = buildAlignmentView([
      entity('a', 'aa', 10, 0, 100, 50),
      entity('b', 'bb', 10, 200, 100, 50),
    ]);
    expect(classIds(view, 'a', 'left')).toEqual(['a', 'b']);
    expect(classIds(view, 'a', 'right')).toEqual(['a', 'b']);
  });

  it('couples a cross-scope spanning entity (edges match different members)', () => {
    // Shape A in group aa spans shapes B + C in group bb on the y axis:
    // A = [10, 110]; B = [10, 55]; C = [65, 110].
    const view = buildAlignmentView([
      entity('A', 'aa', 0, 10, 50, 100),
      entity('B', 'bb', 100, 10, 50, 45),
      entity('C', 'bb', 100, 65, 50, 45),
    ]);
    expect(classIds(view, 'A', 'top')).toEqual(['A', 'B']);
    expect(classIds(view, 'A', 'bottom')).toEqual(['A', 'C']);
  });

  it('does not admit cross-scope start↔end matches (flush adjacency is not alignment)', () => {
    // A's top (100) equals B's bottom (100); A's bottom (200) equals C's top? No —
    // give A edges that only ever match opposite-side edges in bb.
    const view = buildAlignmentView([
      entity('A', 'aa', 0, 100, 50, 100), // y: [100, 200]
      entity('B', 'bb', 100, 60, 50, 40), // y: [60, 100] — bottom = A.top
      entity('C', 'bb', 100, 200, 50, 40), // y: [200, 240] — top = A.bottom
    ]);
    expect(classIds(view, 'A', 'top')).toBeUndefined();
    expect(classIds(view, 'A', 'bottom')).toBeUndefined();
  });

  it('rejects cross-scope center matches', () => {
    const view = buildAlignmentView([
      entity('a', 'aa', 0, 0, 100, 50), // centerX 50
      entity('b', 'bb', 25, 200, 50, 50), // centerX 50
    ]);
    expect(classIds(view, 'a', 'centerX')).toBeUndefined();
  });

  it('keeps unrelated scopes as separate classes at the same edge value', () => {
    // aa has a left-aligned pair at x=10; bb also has one at x=10. Neither
    // entity cross-admits (no end matches across scopes), so the two pairs
    // must remain two separate classes rather than one merged class of four.
    const view = buildAlignmentView([
      entity('a1', 'aa', 10, 0, 100, 50),
      entity('a2', 'aa', 10, 80, 120, 50),
      entity('b1', 'bb', 10, 300, 70, 50),
      entity('b2', 'bb', 10, 380, 90, 50),
    ]);
    expect(classIds(view, 'a1', 'left')).toEqual(['a1', 'a2']);
    expect(classIds(view, 'b1', 'left')).toEqual(['b1', 'b2']);
  });

  it('admits a spanning entity into an existing same-scope class', () => {
    // B1 and B2 are left-aligned siblings in bb; A (scope aa) is congruent
    // with B1 on x — A joins their left class.
    const view = buildAlignmentView([
      entity('A', 'aa', 10, 0, 100, 50),
      entity('B1', 'bb', 10, 200, 100, 50),
      entity('B2', 'bb', 10, 280, 60, 50),
    ]);
    expect(classIds(view, 'A', 'left')).toEqual(['A', 'B1', 'B2']);
  });
});

describe('LayoutManager.alignment', () => {
  it('is empty until explicitly captured and remains stable through mutations', () => {
    const lm = new LayoutManager({
      entities: [entity('a', 'g', 10, 0, 100, 50), entity('b', 'g', 10, 80, 60, 50)],
      connections: [],
      primaryDirection: 'right',
    });

    expect(lm.alignment.isCaptured).toBe(false);
    expect(lm.alignment.classes).toEqual([]);

    lm.alignment.capture();
    expect(lm.alignment.byEntity.get('a')?.left?.ids).toEqual(['a', 'b']);

    lm.updateEntity('b', { deltaX: 40 });
    expect(lm.alignment.byEntity.get('a')?.left?.ids).toEqual(['a', 'b']);

    lm.alignment.capture();
    expect(lm.alignment.byEntity.get('a')?.left).toBeUndefined();
  });

  it('preserves a captured alignment set when forked', () => {
    const lm = new LayoutManager({
      entities: [entity('a', 'g', 10, 0, 100, 50), entity('b', 'g', 10, 80, 60, 50)],
      connections: [],
    });
    lm.alignment.capture();

    const fork = lm.fork();
    expect(fork.alignment.isCaptured).toBe(true);
    expect(fork.alignment.byEntity.get('a')?.left?.ids).toEqual(['a', 'b']);
  });
});
