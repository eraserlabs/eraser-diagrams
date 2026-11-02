import { intersectSpans } from '../../rangeUtils.js';
import type { AxisSpan } from '../../types.js';
import type { Corridor, PortalRef } from '../corridor/contract.js';
import { orderRoutes } from '../corridor/ordering.js';
import { Route, type CorridorVisit } from '../corridor/route.js';
import { spaceRoutes } from '../corridor/spacing.js';
import { manualCorridorWorld } from '../routingTestUtils.js';

const BOUNDS = { x: -20, y: -20, width: 960, height: 300 };

function uTurn(split: boolean, reverse: boolean) {
  const entities = [
    { id: 'from', x: 100, y: 0, width: 60, height: 60 },
    { id: 'to', x: 300, y: 90, width: 60, height: 60 },
  ];
  const corridors: Corridor[] = [
    { index: 0, axis: 'x', rect: { x: 160, y: 0, width: 320, height: 60 } },
    { index: 1, axis: 'x', rect: { x: 360, y: 90, width: 120, height: 60 } },
    ...(split
      ? [
          { index: 2, axis: 'y' as const, rect: { x: 160, y: 0, width: 420, height: 60 } },
          { index: 3, axis: 'y' as const, rect: { x: 20, y: 60, width: 560, height: 30 } },
          { index: 4, axis: 'y' as const, rect: { x: 360, y: 90, width: 220, height: 60 } },
        ]
      : [{ index: 2, axis: 'y' as const, rect: { x: 360, y: 0, width: 220, height: 150 } }]),
  ];
  const portals: PortalRef[] = [
    {
      index: 0,
      kind: 'turn',
      xCorridorIndex: 0,
      yCorridorIndex: 2,
      rect: { x: split ? 160 : 360, y: 0, width: split ? 320 : 120, height: 60 },
    },
    {
      index: 1,
      kind: 'turn',
      xCorridorIndex: 1,
      yCorridorIndex: split ? 4 : 2,
      rect: { x: 360, y: 90, width: 120, height: 60 },
    },
  ];
  const crossbarVisits: CorridorVisit[] = corridors.slice(2).map((corridor, index, run) => {
    if (index + 1 < run.length) {
      portals.push({
        index: index + 2,
        kind: 'continue',
        axis: 'y',
        negativeCorridorIndex: corridor.index,
        positiveCorridorIndex: corridor.index + 1,
        planeCoordinate: corridor.rect.y + corridor.rect.height,
        crossSpan: index === 0 ? [160, 580] : [360, 580],
      });
    }
    return {
      corridorIndex: corridor.index,
      entry:
        index === 0
          ? { kind: 'portal', portalIndex: 0, mode: 'turn' }
          : { kind: 'portal', portalIndex: index + 1, mode: 'continue-straight' },
      exit:
        index + 1 === run.length
          ? { kind: 'portal', portalIndex: 1, mode: 'turn' }
          : { kind: 'portal', portalIndex: index + 2, mode: 'continue-straight' },
      feasibleTrack: index === 1 ? [20, 580] : [360, 480],
    };
  });
  const visits: CorridorVisit[] = [
    {
      corridorIndex: 0,
      entry: { kind: 'terminal', attachmentIndex: 0 },
      exit: { kind: 'portal', portalIndex: 0, mode: 'turn' },
      feasibleTrack: [0, 60],
    },
    ...crossbarVisits,
    {
      corridorIndex: 1,
      entry: { kind: 'portal', portalIndex: 1, mode: 'turn' },
      exit: { kind: 'terminal', attachmentIndex: 1 },
      feasibleTrack: [90, 150],
    },
  ];
  return {
    world: manualCorridorWorld(
      entities,
      corridors,
      portals,
      [
        { index: 0, entityIndex: 0, face: 'right', corridorIndex: 0, faceSpan: [0, 60] },
        { index: 1, entityIndex: 1, face: 'right', corridorIndex: 1, faceSpan: [90, 150] },
      ],
      BOUNDS,
    ),
    route: new Route(
      0,
      { entityIndex: reverse ? 1 : 0, face: 'right' },
      { entityIndex: reverse ? 0 : 1, face: 'right' },
      reverse
        ? visits.reverse().map((visit) => ({ ...visit, entry: visit.exit, exit: visit.entry }))
        : visits,
    ),
  };
}

function terminalChain(sourceX: number, middleCount = 1) {
  const entities = [
    { id: 'from', x: sourceX, y: 0, width: 240, height: 20 },
    { id: 'to', x: 355, y: 200, width: 240, height: 20 },
  ];
  const spans: AxisSpan[] = [
    [sourceX, sourceX + 240],
    ...Array<AxisSpan>(middleCount).fill([0, 900]),
    [355, 595],
  ];
  const length = 180 / spans.length;
  const corridors: Corridor[] = spans.map(([start, end], index) => ({
    index,
    axis: 'y',
    rect: { x: start, y: 20 + index * length, width: end - start, height: length },
  }));
  const portals: PortalRef[] = spans.slice(1).map((span, index) => ({
    index,
    kind: 'continue',
    axis: 'y',
    negativeCorridorIndex: index,
    positiveCorridorIndex: index + 1,
    planeCoordinate: 20 + (index + 1) * length,
    crossSpan: intersectSpans(spans[index], span, 0)!,
  }));
  return {
    world: manualCorridorWorld(
      entities,
      corridors,
      portals,
      [
        { index: 0, entityIndex: 0, face: 'down', corridorIndex: 0, faceSpan: spans[0] },
        {
          index: 1,
          entityIndex: 1,
          face: 'up',
          corridorIndex: spans.length - 1,
          faceSpan: spans[spans.length - 1],
        },
      ],
      BOUNDS,
    ),
    route: new Route(
      0,
      { entityIndex: 0, face: 'down' },
      { entityIndex: 1, face: 'up' },
      spans.map((span, index) => ({
        corridorIndex: index,
        entry:
          index === 0
            ? { kind: 'terminal', attachmentIndex: 0 }
            : { kind: 'portal', portalIndex: index - 1, mode: 'continue-straight' },
        exit:
          index + 1 === spans.length
            ? { kind: 'terminal', attachmentIndex: 1 }
            : { kind: 'portal', portalIndex: index, mode: 'continue-straight' },
        feasibleTrack: span,
      })),
    ),
  };
}

describe('spacing across straight continuation runs', () => {
  it.each([false, true])(
    'preserves compact U-turn depth across corridor subdivision (reverse=%s)',
    (reverse) => {
      for (const split of [false, true]) {
        const { world, route } = uTurn(split, reverse);
        spaceRoutes(world, [route], orderRoutes(world, [route]));
        expect(
          route.visits.slice(1, -1).map((_, index) => route.nominalTrackOf(index + 1)),
        ).toEqual(Array(split ? 3 : 1).fill(384));
      }
    },
  );

  it.each([1, 2])(
    'offers one terminal re-track across %s intermediate corridors only when enabled',
    (middleCount) => {
      for (const enabled of [false, true]) {
        const { world, route } = terminalChain(578, middleCount);
        const spacing = spaceRoutes(world, [route], orderRoutes(world, [route]), {
          terminalCenterContinuations: enabled,
        });
        const last = route.visits.length - 1;
        expect(
          spacing.continuations.filter((policy) => policy.terminalCenterCandidate),
        ).toMatchObject([{ afterVisitIndex: last }]);
        expect(
          spacing.continuations.filter((policy) => policy.policy === 'independent'),
        ).toMatchObject(
          enabled ? [{ afterVisitIndex: last, reason: 'terminal-center-conflict' }] : [],
        );
        expect(route.boundaryRealizationAfter(last)?.kind).toBe(
          enabled ? 'continue-retrack' : undefined,
        );
        if (enabled) {
          expect(route.nominalTrackOf(0)).toBeGreaterThan(650);
          expect(route.nominalTrackOf(last)).toBeLessThan(500);
        } else {
          expect(route.nominalTrackOf(0)).toBe(route.nominalTrackOf(last));
        }
      }
    },
  );

  it('keeps a wide shared terminal span equal despite conflicting centers', () => {
    const { world, route } = terminalChain(500);
    const spacing = spaceRoutes(world, [route], orderRoutes(world, [route]), {
      terminalCenterContinuations: true,
    });
    expect(
      spacing.continuations.every(
        (policy) => policy.policy === 'equal' && !policy.terminalCenterCandidate,
      ),
    ).toBe(true);
    expect(route.nominalTrackOf(0)).toBe(route.nominalTrackOf(2));
  });
});
