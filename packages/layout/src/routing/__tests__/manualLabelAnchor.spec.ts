import type { Point } from '../types.js';
import {
  LABEL_END_CAP_PX,
  anchorFromStored,
  deriveAnchorFromDrop,
  resolveManualLabel,
  type ManualLabelAnchor,
} from '../manualLabelAnchor.js';

const DIMS = { width: 20, height: 10 };

// Straight horizontal, length 100. cap = min(40, 50) = 40 ⇒ head [0,40], mid (40,60), tail [60,100].
const H100: Point[] = [
  [0, 0],
  [100, 0],
];
const H200: Point[] = [
  [0, 0],
  [200, 0],
];

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;
const centerNear = (c: Readonly<Point>, x: number, y: number, eps = 1e-6) =>
  near(c[0], x, eps) && near(c[1], y, eps);

describe('deriveAnchorFromDrop — 3-slice classification', () => {
  it('a drop inside the start cap is head-anchored (px from the start)', () => {
    const a = deriveAnchorFromDrop(H100, [20, 0], DIMS, 0)!;
    expect(a.mode).toBe('head');
    expect(a.value).toBe(20);
  });

  it('a drop inside the end cap is tail-anchored (px from the end)', () => {
    const a = deriveAnchorFromDrop(H100, [80, 0], DIMS, 0)!;
    expect(a.mode).toBe('tail');
    expect(a.value).toBe(20); // 100 − 80
  });

  it('a drop in the middle band is mid-anchored (fraction of the band)', () => {
    const a = deriveAnchorFromDrop(H100, [50, 0], DIMS, 0)!;
    expect(a.mode).toBe('mid');
    expect(near(a.value, 0.5)).toBe(true); // (50−40)/(100−80)
  });

  it('drops carry the perpendicular offset through unchanged (drag is along-line only)', () => {
    const a = deriveAnchorFromDrop(H100, [20, 999], DIMS, 12)!;
    expect(a.mode).toBe('head');
    expect(a.value).toBe(20); // perpendicular (the 999) discarded
    expect(a.offset).toBe(12);
  });

  it('the head/mid boundary is continuous (head value=cap ≡ mid value=0)', () => {
    const head = deriveAnchorFromDrop(H100, [LABEL_END_CAP_PX, 0], DIMS, 0)!;
    expect(head.mode).toBe('head');
    const asHead = resolveManualLabel(H100, head, DIMS)!;
    const asMid = resolveManualLabel(H100, { mode: 'mid', value: 0, offset: 0 }, DIMS)!;
    expect(centerNear(asHead.center, asMid.center[0], asMid.center[1])).toBe(true);
  });

  it('returns null for a degenerate route', () => {
    expect(deriveAnchorFromDrop([[0, 0]], [0, 0], DIMS, 0)).toBeNull();
  });
});

describe('resolveManualLabel — sticky caps vs proportional middle on stretch', () => {
  it('a head label keeps a FIXED px distance from the start when the line stretches', () => {
    const a: ManualLabelAnchor = { mode: 'head', value: 20, offset: 0 };
    expect(centerNear(resolveManualLabel(H100, a, DIMS)!.center, 20, 0)).toBe(true);
    expect(centerNear(resolveManualLabel(H200, a, DIMS)!.center, 20, 0)).toBe(true); // unchanged
  });

  it('a tail label keeps a FIXED px distance from the end when the line stretches', () => {
    const a: ManualLabelAnchor = { mode: 'tail', value: 20, offset: 0 };
    expect(centerNear(resolveManualLabel(H100, a, DIMS)!.center, 80, 0)).toBe(true);
    expect(centerNear(resolveManualLabel(H200, a, DIMS)!.center, 180, 0)).toBe(true); // 20 from end
  });

  it('a mid label scales PROPORTIONALLY with the line', () => {
    const a: ManualLabelAnchor = { mode: 'mid', value: 0.5, offset: 0 };
    expect(centerNear(resolveManualLabel(H100, a, DIMS)!.center, 50, 0)).toBe(true);
    expect(centerNear(resolveManualLabel(H200, a, DIMS)!.center, 100, 0)).toBe(true);
  });

  it('resolve never changes the latched mode', () => {
    const a: ManualLabelAnchor = { mode: 'head', value: 20, offset: 0 };
    expect(resolveManualLabel(H200, a, DIMS)!.anchor.mode).toBe('head');
  });
});

describe('resolveManualLabel — split / merge produces no jump', () => {
  // Reported bug: a label near the middle of a straight line, after the line splits into a Z, must
  // NOT snap backward to the midpoint of a short stub (the old per-segment fraction model did).
  it('a head label is IMMOVABLE when a bend is added far from it (3→4 split)', () => {
    const a = deriveAnchorFromDrop(H100, [20, 0], DIMS, 0)!; // head, 20px from start
    const split: Point[] = [
      [0, 0],
      [100, 0],
      [100, 100],
      [200, 100],
    ];
    // The far split changed total length but not the first 20px — the label does not move at all.
    expect(centerNear(resolveManualLabel(split, a, DIMS)!.center, 20, 0)).toBe(true);
  });

  it('a mid label slides to the new path middle, not backward to a stub (no backward jump)', () => {
    const straight: Point[] = [
      [0, 0],
      [150, 0],
    ];
    const a = deriveAnchorFromDrop(straight, [75, 0], DIMS, 0)!; // mid, fraction 0.5
    const split: Point[] = [
      [0, 0],
      [50, 0],
      [50, 30],
      [200, 30],
    ];
    const res = resolveManualLabel(split, a, DIMS)!;
    // It tracks the proportional middle of the now-longer path — forward on the long run, NOT the
    // [25,0] stub-midpoint the old fraction-of-owner model produced.
    expect(res.center[0]).toBeGreaterThan(50);
    expect(centerNear(res.center, 25, 0)).toBe(false);
  });

  it('a merge (4→3) keeps a tail label fixed px from the end', () => {
    const fourSeg: Point[] = [
      [0, 0],
      [80, 0],
      [80, 60],
      [160, 60],
      [160, 100],
    ];
    const a = anchorFromStored(fourSeg, [160, 90], 0)!; // 10px (arc) from the end → tail
    expect(a.mode).toBe('tail');
    const merged: Point[] = [
      [0, 0],
      [80, 0],
      [80, 100],
      [200, 100],
    ];
    const res = resolveManualLabel(merged, a, DIMS)!;
    // Still `value` px of arc from the terminal end, wherever that now lands.
    const endRun = res.center[0]; // on the final horizontal run at y=100
    expect(res.center[1]).toBe(100);
    expect(near(200 - endRun, a.value)).toBe(true);
  });
});

describe('resolveManualLabel — perpendicular offset', () => {
  it('positive offset on a horizontal segment lifts the center UP (canonical normal)', () => {
    const a: ManualLabelAnchor = { mode: 'head', value: 20, offset: 12 };
    expect(centerNear(resolveManualLabel(H100, a, DIMS)!.center, 20, -12)).toBe(true); // 12 ≥ 5+4
  });

  it('positive offset on a vertical segment moves the center RIGHT (canonical normal)', () => {
    const V100: Point[] = [
      [0, 0],
      [0, 100],
    ];
    const a: ManualLabelAnchor = { mode: 'head', value: 20, offset: 24 };
    // dims {20,10}: vertical clearance = width/2 (10) + gap (4) = 14; offset 24 ≥ 14 ⇒ applied exactly.
    expect(centerNear(resolveManualLabel(V100, a, DIMS)!.center, 24, 20)).toBe(true);
  });

  it('a wide label on a vertical segment is cleared so it does not straddle the line', () => {
    const V100: Point[] = [
      [0, 0],
      [0, 100],
    ];
    const wide = { width: 80, height: 14 }; // half-width 40
    const a: ManualLabelAnchor = { mode: 'mid', value: 0.5, offset: 24 };
    const res = resolveManualLabel(V100, a, wide)!;
    // clearance = 40 + 4 = 44 > nominal 24 ⇒ center pushed to x=44; left edge 4 clears the line.
    expect(res.center[0]).toBe(44);
    expect(res.center[0] - wide.width / 2).toBeGreaterThan(0);
  });
});

describe('resolveManualLabel — orientation + degenerate', () => {
  const L_SHAPE: Point[] = [
    [0, 0],
    [100, 0],
    [100, 100],
  ];

  it('reports the orientation of the segment under the resolved arc-position', () => {
    const onH: ManualLabelAnchor = { mode: 'head', value: 50, offset: 0 };
    expect(resolveManualLabel(L_SHAPE, onH, DIMS)!.orient).toBe('h');
    const onV: ManualLabelAnchor = { mode: 'tail', value: 50, offset: 0 };
    expect(resolveManualLabel(L_SHAPE, onV, DIMS)!.orient).toBe('v');
  });

  it('classifies a diagonal segment as free', () => {
    const diag: Point[] = [
      [0, 0],
      [100, 100],
    ];
    const a = deriveAnchorFromDrop(diag, [50, 50], DIMS, 0)!;
    expect(resolveManualLabel(diag, a, DIMS)!.orient).toBe('free');
  });

  it('a line shorter than both caps collapses all modes toward the center (graceful)', () => {
    const short: Point[] = [
      [0, 0],
      [40, 0],
    ]; // L=40 ⇒ cap=20, caps meet at the midpoint
    const head: ManualLabelAnchor = { mode: 'head', value: 999, offset: 0 };
    const tail: ManualLabelAnchor = { mode: 'tail', value: 999, offset: 0 };
    expect(centerNear(resolveManualLabel(short, head, DIMS)!.center, 20, 0)).toBe(true);
    expect(centerNear(resolveManualLabel(short, tail, DIMS)!.center, 20, 0)).toBe(true);
  });
});
