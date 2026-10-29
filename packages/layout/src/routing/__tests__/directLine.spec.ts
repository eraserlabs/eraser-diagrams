/**
 * Straight and arc connectors as pure geometry (directLine.ts): where a line with no path attaches,
 * how a bound end glides with its box (focus binding) or holds its place on it (an arc's fixed
 * anchor), and where the label goes.
 */
import {
  bindingOf,
  centreSegment,
  crossings,
  directLabel,
  type DirectBox,
  type DirectLine,
  focusOf,
  followBoxes,
  onOutline,
  ontoOutline,
  snapToFocus,
} from '../directLine.js';

const box = (
  _id: string,
  x: number,
  y: number,
  width = 100,
  height = 60,
  shape?: string,
): DirectBox => ({
  x,
  y,
  width,
  height,
  ...(shape ? { shape } : {}),
});

const line = (
  points: [number, number][],
  extra: Partial<DirectLine> = {},
  style: 'straight' | 'arc' = 'straight',
): DirectLine => ({
  from: 'a',
  to: 'b',
  points,
  style,
  ...extra,
});

const close = (p: readonly number[], q: readonly number[]) => {
  expect(p[0]).toBeCloseTo(q[0], 4);
  expect(p[1]).toBeCloseTo(q[1], 4);
};

describe('a straight line with no path yet runs centre to centre ', () => {
  it('each end where the line between the centres leaves its box', () => {
    const [s, e] = centreSegment(box('a', 0, 0), box('b', 300, 0));
    close(s, [100, 30]);
    close(e, [300, 30]);
    const [ds, de] = centreSegment(box('a', 0, 0, 100, 100), box('b', 300, 300, 100, 100));
    close(ds, [100, 100]);
    close(de, [300, 300]);
  });

  it('an ellipse is left where its drawn outline is, not its box', () => {
    const [s] = centreSegment(box('a', 0, 0, 100, 100, 'ellipse'), box('b', 300, 300, 100, 100));
    // 45° from the centre of a circle of radius 50
    expect(Math.hypot(s[0] - 50, s[1] - 50)).toBeCloseTo(50, 0);
    expect(s[0]).toBeLessThan(100);
  });
});

describe('a focus binding', () => {
  it('read from where the end is, gives the end back while nothing moves', () => {
    for (const shape of [undefined, 'ellipse', 'diamond']) {
      const b = box('b', 300, 0, 100, 60, shape);
      const adjacent: [number, number] = [0, 10];
      // where the line from the adjacent point toward a point on the box first crosses its outline
      const edge = crossings(b, adjacent, [350, 40])[0];
      const focus = focusOf(b, adjacent, edge);
      expect(Math.abs(focus.focus)).toBeLessThanOrEqual(1);
      close(snapToFocus(b, focus, adjacent)!, edge);
    }
  });

  it('a box moved: the end glides along its outline, the line still aimed as it was across the box', () => {
    const a = box('a', 0, 0);
    const b = box('b', 300, 0);
    const l = line([
      [100, 20],
      [300, 40],
    ]);
    const binding = bindingOf(l, (id) => (id === 'a' ? a : b));
    // nothing moved: the same ends
    const same = followBoxes(l, binding, (id) => (id === 'a' ? a : b));
    close(same[0], [100, 20]);
    close(same[1], [300, 40]);
    // b goes down 100: the start snaps against the end where it was, then
    // the end against the new start: the end slides down b's face at once
    const moved = box('b', 300, 100);
    const [s, e] = followBoxes(l, binding, (id) => (id === 'a' ? a : moved));
    close(s, [100, 20]);
    expect(e[0]).toBeCloseTo(300, 4);
    expect(e[1]).toBeGreaterThanOrEqual(100);
    expect(e[1]).toBeLessThanOrEqual(160);
    // the next step of the drag reads the line where the last left it: the start turns toward the end, on a's face
    const [s2, e2] = followBoxes({ ...l, points: [s, e] }, binding, (id) =>
      id === 'a' ? a : box('b', 300, 110),
    );
    expect(s2[0]).toBeCloseTo(100, 4);
    expect(s2[1]).toBeGreaterThan(20);
    expect(e2[0]).toBeCloseTo(300, 4);
  });

  it('a free end stays where it is; the bound end turns toward it', () => {
    const a = box('a', 0, 0);
    const l = line(
      [
        [100, 30],
        [300, 30],
      ],
      { to: '' },
    );
    const binding = bindingOf(l, () => a);
    const [s, e] = followBoxes(l, binding, () => box('a', 0, 100));
    close(e, [300, 30]);
    expect(s[0]).toBeCloseTo(100, 4);
    expect(s[1]).toBeGreaterThanOrEqual(100);
    expect(s[1]).toBeLessThanOrEqual(160);
  });
});

describe("an arc's ends keep their fixed anchors", () => {
  it('the same fraction across and down the box, wherever the box goes', () => {
    const a = box('a', 0, 0);
    const b = box('b', 300, 0);
    const l = line(
      [
        [100, 15],
        [300, 45],
      ],
      { bend: 40 },
      'arc',
    );
    const binding = bindingOf(l, (id) => (id === 'a' ? a : b));
    const [s, e] = followBoxes(l, binding, (id) => (id === 'a' ? a : box('b', 350, 120)));
    close(s, [100, 15]);
    close(e, [350, 165]);
  });
});

describe('an end on its outline', () => {
  it('an end left deep inside its box goes where the line leaves the box; one on the outline stays', () => {
    const b = box('b', 0, 0);
    close(onOutline(b, [50, 30], [300, 30]), [100, 30]);
    close(onOutline(b, [100, 10], [300, 30]), [100, 10]);
  });

  it("an end on an ellipse's box corner comes in to the ellipse, toward its centre", () => {
    const e = box('e', 0, 0, 100, 100, 'ellipse');
    const p = ontoOutline(e, [100, 0]);
    expect(Math.hypot(p[0] - 50, p[1] - 50)).toBeCloseTo(50, 0);
    close(ontoOutline(box('r', 0, 0), [100, 20]), [100, 20]);
  });
});

describe('the label of a straight or arc line', () => {
  const size = { width: 40, height: 16 };

  it("a straight line's label centres on its middle; an arc's on its apex", () => {
    const straight = line(
      [
        [0, 0],
        [200, 0],
      ],
    );
    expect(directLabel(straight, size)).toEqual({ x: 80, y: -8, ...size });
    const arc = line(
      [
        [0, 0],
        [200, 0],
      ],
      { bend: 50 },
      'arc',
    );
    const box = directLabel(arc, size)!;
    // the apex is 50 off the chord's middle, on the side the bend's sign picks
    expect(box.x).toBeCloseTo(80, 4);
    expect(Math.abs(box.y + 8)).toBeCloseTo(50, 4);
  });

  it('a manual label keeps its place along the line, its offset off it, when the line moves', () => {
    const was = line([
      [0, 0],
      [200, 0],
    ]);
    const moved = line([
      [0, 100],
      [200, 100],
    ]);
    const box = directLabel(moved, size, {
      on: was,
      box: { x: 10, y: -30, width: 40, height: 16 },
      lineOffset: 24,
    })!;
    expect(box.x).toBeCloseTo(10, 0);
    expect(box.y).toBeLessThan(100 - 16);
  });
});

describe('an outline descriptor', () => {
  it('an ellipse outline is left where the ellipse is, like the named ellipse shape', () => {
    const fromOutline = centreSegment(
      { x: 0, y: 0, width: 100, height: 100, outline: { kind: 'ellipse' } },
      box('b', 300, 300, 100, 100),
    );
    const fromShape = centreSegment(
      box('a', 0, 0, 100, 100, 'ellipse'),
      box('b', 300, 300, 100, 100),
    );
    close(fromOutline[0], fromShape[0]);
  });

  it('a polygon outline scales its 0-100 vertices to the box', () => {
    const diamond: DirectBox = {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      outline: {
        kind: 'polygon',
        vertices: [
          [50, 0],
          [100, 50],
          [50, 100],
          [0, 50],
        ],
      },
    };
    const [s] = centreSegment(diamond, box('b', 300, 300, 100, 100));
    close(s, centreSegment(box('a', 0, 0, 100, 100, 'diamond'), box('b', 300, 300, 100, 100))[0]);
    expect(s[0] + s[1]).toBeCloseTo(150, 4);
  });
});
