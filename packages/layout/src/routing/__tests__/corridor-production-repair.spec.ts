import { LayoutManager } from '../../LayoutManager.js';
import {
  LayoutConnectionTextPlacementSource,
  type LayoutConnection,
  type LayoutEntity,
} from '../../types.js';
import { collectFaceProposals } from '../corridor/fanSpreadRepair.js';
import { repairProductionRoutes } from '../corridor/productionRepair.js';
import { compareRoutingQualityCosts } from '../corridor/qualityCost.js';
import type { RepairContext } from '../corridor/repairProposal.js';
import { createRepairSearch } from '../corridor/repairSearch.js';
import { realizeRoutes } from '../corridor/realize.js';
import { Route } from '../corridor/route.js';
import { MIN_TRACK_SEPARATION_PX } from '../corridor/spacing.js';
import { searchRoute } from '../corridor/topology.js';
import { buildCorridorWorld } from '../corridor/worldConstruction.js';
import { routeConnections } from '../routeConnections.js';

function crowdedFace() {
  const entities: LayoutEntity[] = [
    { id: 'from', x: 0, y: 0, width: 40, height: 200 },
    { id: 'to', x: 400, y: 0, width: 40, height: 200 },
    { id: 'above', x: 200, y: -100, width: 40, height: 40 },
  ];
  const tracks = [10, 20, 190];
  const requests = tracks.map((track, requestIndex) => ({
    requestIndex,
    from: {
      entityIndex: 0,
      face: 'right' as const,
      authoredTrack: requestIndex === 2 ? track : undefined,
    },
    to: {
      entityIndex: 1,
      face: 'left' as const,
      authoredTrack: requestIndex === 2 ? track : undefined,
    },
  }));
  const world = buildCorridorWorld(new LayoutManager({ entities, connections: [] }), requests);
  const topologies = requests.map((request, index) => {
    const track = tracks[index];
    const search = searchRoute(world, {
      ...request,
      from: { ...request.from, authoredTrack: track },
      to: { ...request.to, authoredTrack: track },
    });
    expect(search.fallback).toBe(false);
    return new Route(
      index,
      { ...request.from, repairPinTrack: track },
      { ...request.to, repairPinTrack: track },
      search.route.visits,
    );
  });
  const independentContinuations = topologies.flatMap((route, routeIndex) =>
    route.visits.flatMap((visit, afterVisitIndex) =>
      visit.entry.kind === 'portal' && visit.entry.mode === 'continue-straight'
        ? [{ routeIndex, afterVisitIndex }]
        : [],
    ),
  );
  expect(new Set(independentContinuations.map(({ routeIndex }) => routeIndex))).toEqual(
    new Set([0, 1, 2]),
  );
  const initial = realizeRoutes(world, topologies, { independentContinuations });

  return { world, requests, topologies, initial, independentContinuations };
}

it('drops visit-indexed policies only for face members whose topology changes', () => {
  const { world, requests, topologies, initial, independentContinuations } = crowdedFace();
  const context: RepairContext = {
    world,
    requests,
    topologies,
    batch: initial,
    policies: { independentContinuations },
    search: createRepairSearch(world),
    protectedRouteIndexes: new Set(),
    mode: 'quality',
  };
  const proposal = collectFaceProposals(context)[0];
  const candidate = proposal.build()!;
  expect(candidate.policies.independentContinuations).toEqual(
    independentContinuations.filter(({ routeIndex }) => routeIndex === 2),
  );
});

it('improves the shared objective, preserves authored ports, and replays its accepted policies', () => {
  const { world, requests, topologies } = crowdedFace();
  const initial = realizeRoutes(world, topologies);
  const result = repairProductionRoutes(world, requests, topologies, initial, {
    timeBudgetMs: Infinity,
    adoptedRouteIndexes: new Set(),
  });
  expect(compareRoutingQualityCosts(result.quality.cost, initial.quality.cost)).toBeLessThan(0);
  expect(result.routes[2].ports()).toEqual(initial.routes[2].ports());
  const replay = realizeRoutes(world, result.topologies, {
    continuationCutSelection: 'best',
    ...result.policies,
  });
  expect(replay.routes.map((route) => route.points())).toEqual(
    result.routes.map((route) => route.points()),
  );
  expect(replay.quality.cost).toEqual(result.quality.cost);
});

it('spaces a new line against the stored geometry of an adopted incumbent', () => {
  // Without stored ports, fan spread would rather center both lines in face slots,
  // which it could only do by moving the incumbent off its stored track.
  const existing: LayoutConnection = {
    id: 'existing',
    from: 'a',
    to: 'b',
    x: 80,
    y: 20,
    points: [
      [0, 0],
      [160, 0],
    ],
  };
  const layoutManager = new LayoutManager({
    entities: [
      { id: 'a', x: 0, y: 0, width: 80, height: 40 },
      { id: 'b', x: 240, y: 0, width: 80, height: 40 },
    ],
    connections: [existing],
    primaryDirection: 'right',
  });

  routeConnections({
    layoutManager,
    connectionsToRoute: [{ id: 'second', from: 'a', to: 'b' }],
    repair: { timeBudgetMs: Number.POSITIVE_INFINITY },
  });

  expect(layoutManager.getConnectionById('existing')).toEqual(existing);
  const second = layoutManager.getConnectionById('second')!;
  const tracks = second.points.flatMap(([x, y], index) => {
    const next = second.points[index + 1];
    return next && next[1] === y && next[0] !== x ? [second.y + y] : [];
  });
  expect(tracks.length).toBeGreaterThan(0);
  for (const track of tracks) {
    expect(Math.abs(track - existing.y)).toBeGreaterThanOrEqual(MIN_TRACK_SEPARATION_PX);
  }
});

it('keeps aligned fan-in routes straight across a source container boundary', () => {
  const sources = [98, 225, 351, 478, 604].map((y, index) => ({
    id: `source-${index}`,
    x: 72,
    y,
    width: 228,
    height: 79,
    containerId: 'sources',
  }));
  const layoutManager = new LayoutManager({
    entities: [
      { id: 'sources', x: 26, y: 40, width: 320, height: 712, isContainer: true },
      { id: 'target', x: 554, y: 40, width: 482, height: 712, isContainer: true },
      ...sources,
      { id: 'server', x: 681, y: 224, width: 229, height: 90, containerId: 'target' },
      {
        id: 'inner',
        x: 589,
        y: 500,
        width: 413,
        height: 217,
        isContainer: true,
        containerId: 'target',
      },
      { id: 'database', x: 691, y: 557, width: 208, height: 114, containerId: 'inner' },
    ],
    connections: [],
  });
  const result = routeConnections({
    layoutManager,
    connectionsToRoute: [
      ...sources.map(({ id }, index) => ({
        id,
        from: id,
        to: 'target',
        authoredFromFace: 'right' as const,
        authoredToFace: 'left' as const,
        toArrowhead: true,
        textPlacement: { x: 0, y: 0, width: index < 2 ? 82 : 44, height: 18 },
        textPlacementSource: LayoutConnectionTextPlacementSource.MEASURE,
      })),
      {
        id: 'internal',
        from: 'server',
        to: 'database',
        authoredFromFace: 'down',
        authoredToFace: 'up',
        toArrowhead: true,
      },
    ],
    repair: { timeBudgetMs: Infinity },
  });

  expect(result.fallbacks.size).toBe(0);
  for (const source of sources) {
    const connection = layoutManager.getConnectionById(source.id)!;
    expect(connection.points).toEqual([
      [0, 0],
      [254, 0],
    ]);
    expect(connection.x).toBe(source.x + source.width);
    expect(Math.abs(connection.y - (source.y + source.height / 2))).toBeLessThanOrEqual(1);
  }
});
