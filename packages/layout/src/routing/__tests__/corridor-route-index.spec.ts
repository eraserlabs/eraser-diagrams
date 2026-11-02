import type { XYPoint } from '../../types.js';
import { collectGeometryQualityEvents } from '../corridor/geometryQuality.js';
import type { LineMergeQualityEvent } from '../corridor/qualityCost.js';
import { Route } from '../corridor/route.js';
import type { IndexedRouteSegment } from '../corridor/routeIndex.js';
import { RouteIndexer } from '../corridor/routeIndex.js';
import { collectGroupTitleQualityEvents } from '../corridor/groupTitleQuality.js';

function emittedRoute(
  requestIndex: number,
  corridorIndex: number,
  nominalTrack: number,
  points: readonly XYPoint[],
  endpoints: Partial<Pick<Route, 'from' | 'to'>> = {},
): Route {
  const route = new Route(
    requestIndex,
    endpoints.from ?? { entityIndex: requestIndex * 2, face: 'right' },
    endpoints.to ?? { entityIndex: requestIndex * 2 + 1, face: 'left' },
    [
      {
        corridorIndex,
        entry: { kind: 'terminal', attachmentIndex: requestIndex * 2 },
        exit: { kind: 'terminal', attachmentIndex: requestIndex * 2 + 1 },
        feasibleTrack: [0, 100],
      },
    ],
  );
  route.beginRealization();
  route.setOrder([0]);
  route.setNominalTracks([nominalTrack]);
  route.setGeometry(
    { from: points[0], to: points[points.length - 1] },
    points,
    new Int32Array(points.length - 1),
  );
  return route;
}

function emittedRouteByVisit(
  requestIndex: number,
  corridorIndexes: readonly number[],
  points: readonly XYPoint[],
): Route {
  const route = new Route(
    requestIndex,
    { entityIndex: requestIndex * 2, face: 'right' },
    { entityIndex: requestIndex * 2 + 1, face: 'left' },
    corridorIndexes.map((corridorIndex, visitIndex) => ({
      corridorIndex,
      entry:
        visitIndex === 0
          ? { kind: 'terminal' as const, attachmentIndex: requestIndex * 2 }
          : {
              kind: 'portal' as const,
              portalIndex: visitIndex - 1,
              mode: 'continue-straight' as const,
            },
      exit:
        visitIndex === corridorIndexes.length - 1
          ? { kind: 'terminal' as const, attachmentIndex: requestIndex * 2 + 1 }
          : {
              kind: 'portal' as const,
              portalIndex: visitIndex,
              mode: 'continue-straight' as const,
            },
      feasibleTrack: [0, 100] as const,
    })),
  );
  route.beginRealization();
  route.setOrder(new Int32Array(corridorIndexes.length));
  route.setNominalTracks(new Float64Array(corridorIndexes.length).fill(10));
  route.setGeometry(
    { from: points[0], to: points[points.length - 1] },
    points,
    Int32Array.from(corridorIndexes, (_, visitIndex) => visitIndex),
  );
  return route;
}

describe('routing corridor RouteIndexer', () => {
  it('prices title ink once per route/title and attributes every crossed corridor', () => {
    const route = emittedRouteByVisit(
      0,
      [4, 5],
      [
        { x: 0, y: 10 },
        { x: 20, y: 10 },
        { x: 40, y: 10 },
      ],
    );
    const boundary = emittedRoute(1, 4, 5, [
      { x: 0, y: 5 },
      { x: 40, y: 5 },
    ]);
    const clear = emittedRoute(2, 4, 20, [
      { x: 0, y: 20 },
      { x: 40, y: 20 },
    ]);
    const indexer = new RouteIndexer([route, boundary, clear]);
    const events = collectGroupTitleQualityEvents(
      {
        titles: [{ x: 10, y: 5, width: 20, height: 10 }],
        intersectionCost: 100,
        overlapCostPerPx: 2,
      },
      indexer,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'group-title',
      overlapLength: 20,
      cost: 140,
      routeIndexes: [0],
    });
    expect(events[0].corridorIndexes?.slice().sort()).toEqual([4, 5]);
    expect(events[0].visits?.slice().sort((a, b) => a.visitIndex - b.visitIndex)).toEqual([
      { routeIndex: 0, visitIndex: 0 },
      { routeIndex: 0, visitIndex: 1 },
    ]);
    expect(
      collectGroupTitleQualityEvents(
        {
          titles: [{ x: 10, y: 5, width: 20, height: 10 }],
          intersectionCost: 0,
          overlapCostPerPx: 0,
        },
        indexer,
      ),
    ).toEqual([]);
  });

  it.each<[number, number, boolean, number]>([
    [0, 7, false, 0],
    [2, 7, false, 1],
    [0, 8, false, 1],
    [0, 7, true, 1],
  ])(
    'allows only grouped terminal overlap (entity %i, group %i, bent %s)',
    (entityIndex, portGroup, bent, merges) => {
      const left = emittedRoute(
        0,
        0,
        0,
        [
          { x: 0, y: 0 },
          { x: 40, y: 0 },
          ...(bent
            ? [
                { x: 40, y: 40 },
                { x: 100, y: 40 },
              ]
            : []),
        ],
        { from: { entityIndex: 0, face: 'right', portGroup: 7 } },
      );
      const right = emittedRoute(
        1,
        0,
        0,
        [
          { x: 0, y: 0 },
          { x: 60, y: 0 },
          ...(bent
            ? [
                { x: 60, y: 40 },
                { x: 100, y: 40 },
              ]
            : []),
        ],
        { from: { entityIndex, face: 'right', portGroup } },
      );
      expect(
        collectGeometryQualityEvents([left, right]).events.filter(
          (event) => event.kind === 'line-merge',
        ),
      ).toHaveLength(merges);
    },
  );

  it('requires non-fallback routes to be fully emitted', () => {
    const route = new Route(
      0,
      { entityIndex: 0, face: 'right' },
      { entityIndex: 1, face: 'left' },
      [
        {
          corridorIndex: 0,
          entry: { kind: 'terminal', attachmentIndex: 0 },
          exit: { kind: 'terminal', attachmentIndex: 1 },
          feasibleTrack: [0, 100],
        },
      ],
    );

    expect(() => new RouteIndexer([route])).toThrow('requires an active realization');
  });

  it('bulk-indexes canonical segments and their route, visit, and corridor ownership', () => {
    const horizontal = emittedRoute(0, 7, 10, [
      { x: 0, y: 10 },
      { x: 20, y: 10 },
    ]);
    const vertical = emittedRoute(1, 8, 10, [
      { x: 10, y: 0 },
      { x: 10, y: 20 },
    ]);
    const parallel = emittedRoute(2, 9, 30, [
      { x: 5, y: 30 },
      { x: 15, y: 30 },
    ]);
    const endpointTouch = emittedRoute(3, 10, 20, [
      { x: 20, y: 10 },
      { x: 20, y: 20 },
    ]);
    const fallback = new Route(
      4,
      { entityIndex: 8, face: 'right' },
      { entityIndex: 9, face: 'left' },
      [],
    );

    const index = new RouteIndexer([horizontal, vertical, parallel, endpointTouch, fallback]);

    expect(index.segmentsForRoute(0)[0]).toMatchObject({
      routeIndex: 0,
      segmentIndex: 0,
      visitIndex: 0,
      corridorIndex: 7,
      axis: 'x',
      travel: [0, 20],
      track: 10,
    });
    expect(index.segmentsForRoute(1)).toHaveLength(1);
    expect(index.segmentsForCorridor(9).map((segment) => segment.routeIndex)).toEqual([2]);
    expect(
      index
        .segmentsInRect({ x: 9, y: 9, width: 2, height: 2 })
        .map((segment) => segment.routeIndex),
    ).toEqual([0, 1]);
  });

  it('reports only open-interior crossings in deterministic segment order', () => {
    const routes = [
      emittedRoute(0, 0, 10, [
        { x: 0, y: 10 },
        { x: 20, y: 10 },
      ]),
      emittedRoute(1, 1, 10, [
        { x: 10, y: 0 },
        { x: 10, y: 20 },
      ]),
      emittedRoute(2, 2, 20, [
        { x: 20, y: 10 },
        { x: 20, y: 20 },
      ]),
    ];

    const crossings = new RouteIndexer(routes).properCrossings();

    expect(crossings).toHaveLength(1);
    expect([crossings[0].a.routeIndex, crossings[0].b.routeIndex]).toEqual([0, 1]);
  });

  it('counts an invisible visit boundary as visual-run interior exactly once', () => {
    const horizontal = emittedRouteByVisit(
      0,
      [7, 8],
      [
        { x: 0, y: 10 },
        { x: 10, y: 10 },
        { x: 20, y: 10 },
      ],
    );
    const vertical = emittedRoute(1, 9, 10, [
      { x: 10, y: 0 },
      { x: 10, y: 20 },
    ]);

    const crossings = new RouteIndexer([horizontal, vertical]).properCrossings();

    expect(crossings).toHaveLength(1);
    expect(crossings[0].a).toMatchObject({ routeIndex: 0, segmentIndex: 0, visitIndex: 0 });
  });

  it('does not promote a bend vertex to visual-run interior', () => {
    const bent = emittedRouteByVisit(
      0,
      [7, 8],
      [
        { x: 0, y: 10 },
        { x: 10, y: 10 },
        { x: 10, y: 20 },
      ],
    );
    const vertical = emittedRoute(1, 9, 10, [
      { x: 10, y: 0 },
      { x: 10, y: 30 },
    ]);

    expect(new RouteIndexer([bent, vertical]).properCrossings()).toEqual([]);
  });

  it('attributes close parallel emitted runs to both owning visits', () => {
    const left = emittedRouteByVisit(
      0,
      [7, 8],
      [
        { x: 0, y: 10 },
        { x: 10, y: 10 },
        { x: 20, y: 10 },
      ],
    );
    const right = emittedRoute(1, 9, 11, [
      { x: 5, y: 11 },
      { x: 15, y: 11 },
    ]);

    const overlaps: [IndexedRouteSegment, IndexedRouteSegment][] = [];
    new RouteIndexer([left, right]).forEachParallelOverlap(1, (segment, candidate) => {
      overlaps.push([segment, candidate]);
    });

    expect(overlaps).toMatchObject([
      [
        { routeIndex: 0, visitIndex: 0, corridorIndex: 7 },
        { routeIndex: 1, visitIndex: 0, corridorIndex: 9 },
      ],
      [
        { routeIndex: 0, visitIndex: 1, corridorIndex: 8 },
        { routeIndex: 1, visitIndex: 0, corridorIndex: 9 },
      ],
    ]);

    const lineMerges = collectGeometryQualityEvents([left, right]).events.filter(
      (event): event is LineMergeQualityEvent => event.kind === 'line-merge',
    );
    expect(lineMerges.map((event) => event.corridorIndexes)).toEqual([
      [7, 9],
      [8, 9],
    ]);
    expect(lineMerges.map((event) => event.visits)).toEqual([
      [
        { routeIndex: 0, visitIndex: 0 },
        { routeIndex: 1, visitIndex: 0 },
      ],
      [
        { routeIndex: 0, visitIndex: 1 },
        { routeIndex: 1, visitIndex: 0 },
      ],
    ]);
  });

  it('visits every dirty-clean overlap and deduplicates dirty-dirty pairs', () => {
    const routes = [10, 11, 10].map((track, routeIndex) =>
      emittedRoute(routeIndex, routeIndex, track, [
        { x: 0, y: track },
        { x: 20, y: track },
      ]),
    );
    const index = new RouteIndexer(routes);
    const visitPairs = (dirtyRouteIndexes: ReadonlySet<number>): string[] => {
      const pairs: string[] = [];
      index.forEachParallelOverlapForRoutes(1, dirtyRouteIndexes, (segment, candidate) => {
        pairs.push(
          [segment.routeIndex, candidate.routeIndex].sort((left, right) => left - right).join(':'),
        );
      });
      return pairs.sort();
    };

    expect(visitPairs(new Set([2]))).toEqual(['0:2', '1:2']);
    expect(visitPairs(new Set([0, 2]))).toEqual(['0:1', '0:2', '1:2']);
  });
});
