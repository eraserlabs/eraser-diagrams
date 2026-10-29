import { defaultBendForChord, getArcApex, getArcPathD, getArcPolyline } from '@eraserlabs/layout';
import type { ResolvedConnection, ResolvedEntity } from '@eraserlabs/protocol';
import { describe, expect, it } from 'vitest';
import type { Box } from '../src/index.js';
import { routeScene } from '../src/browser/route.js';

/**
 * Arc connections: layout places the two ends and the label, render draws the curve on the circle
 * the ends and the bend define.
 */
const NO_INTRINSICS = new Map<string, Box>();
const NO_TEXT = new Map<string, Box[]>();

function node(id: string, x: number, y: number, width = 100, height = 60): ResolvedEntity {
  return { tag: 'Box', id, x, y, width, height, props: {} };
}

function wire(id: string, props: Record<string, unknown>): ResolvedConnection {
  return { tag: 'Wire', id, x: 0, y: 0, props: { from: 'a', to: 'b', ...props } };
}

const nodes = [node('a', 0, 0), node('b', 300, 0)];
const authored = [
  { x: 100, y: 30 },
  { x: 300, y: 30 },
];

describe('routeScene with connectorStyle: arc', () => {
  it('draws an SVG arc command on the circle the ends and the bend define', () => {
    const layout = routeScene(
      nodes,
      [wire('w', { connectorStyle: 'arc', bend: 50, points: authored })],
      NO_INTRINSICS,
      NO_TEXT,
    );
    const geometry = layout.connections['w']!;
    expect(geometry.d).toBe(getArcPathD([100, 30], [300, 30], 50));
    expect(geometry.d).toMatch(/^M 100 30 A /);
  });

  it('puts the sampled curve in points, so consumers of points follow the curve', () => {
    const layout = routeScene(
      nodes,
      [wire('w', { connectorStyle: 'arc', bend: 50, points: authored })],
      NO_INTRINSICS,
      NO_TEXT,
    );
    expect(layout.connections['w']!.points).toEqual(getArcPolyline([100, 30], [300, 30], 50));
    expect(layout.connections['w']!.points.length).toBeGreaterThan(2);
  });

  it('draws a bend under 8 px as a straight segment', () => {
    const layout = routeScene(
      nodes,
      [wire('w', { connectorStyle: 'arc', bend: 5, points: authored })],
      NO_INTRINSICS,
      NO_TEXT,
    );
    expect(layout.connections['w']!.points).toEqual([
      [100, 30],
      [300, 30],
    ]);
    expect(layout.connections['w']!.d).not.toContain('A');
  });

  it('uses the default bow for the chord when the arc has no bend', () => {
    const layout = routeScene(
      nodes,
      [wire('w', { connectorStyle: 'arc', points: authored })],
      NO_INTRINSICS,
      NO_TEXT,
    );
    const bend = defaultBendForChord([100, 30], [300, 30]);
    expect(layout.connections['w']!.d).toBe(getArcPathD([100, 30], [300, 30], bend));
  });

  it('centres the label on the apex', () => {
    const layout = routeScene(
      nodes,
      [wire('w', { connectorStyle: 'arc', bend: 50, points: authored })],
      NO_INTRINSICS,
      new Map([['w', [{ x: 0, y: 0, width: 40, height: 16 }]]]),
    );
    const [ax, ay] = getArcApex([100, 30], [300, 30], 50);
    expect(layout.connections['w']!.label.x).toBeCloseTo(ax, 6);
    expect(layout.connections['w']!.label.y).toBeCloseTo(ay, 6);
  });

  it('puts the label of an arc with no bend on the apex of the curve it draws', () => {
    const layout = routeScene(
      nodes,
      [wire('w', { connectorStyle: 'arc', points: authored })],
      NO_INTRINSICS,
      new Map([['w', [{ x: 0, y: 0, width: 40, height: 16 }]]]),
    );
    const [ax, ay] = getArcApex([100, 30], [300, 30], defaultBendForChord([100, 30], [300, 30]));
    expect(layout.connections['w']!.label.x).toBeCloseTo(ax, 6);
    expect(layout.connections['w']!.label.y).toBeCloseTo(ay, 6);
  });
});
