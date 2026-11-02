import { describe, expect, it } from 'vitest';
import { LayoutManager } from '../../LayoutManager.js';
import { leaf, sceneRouteRequests } from '../routingTestUtils.js';
import { repairProductionRoutes } from '../corridor/productionRepair.js';
import { compareRoutingQualityCosts } from '../corridor/qualityCost.js';
import { realizeRoutes } from '../corridor/realize.js';
import { buildCorridorWorld } from '../corridor/worldConstruction.js';
import { searchRoutes } from '../corridor/topology.js';

describe('routing corridor repair geometry', () => {
  it('clears title hits while preserving authored ports and replayable realization policies', () => {
    const requests = [
      {
        requestIndex: 0,
        from: { entityIndex: 0, face: 'right' as const, authoredTrack: 40 },
        to: { entityIndex: 1, face: 'left' as const, authoredTrack: 200 },
      },
    ];
    const world = {
      ...buildCorridorWorld(
        new LayoutManager({
          entities: [leaf('a', 0, 0, 80, 80), leaf('b', 320, 160, 80, 80)],
          connections: [],
        }),
        requests,
      ),
      groupTitleAvoidance: {
        titles: [{ x: 195, y: 100, width: 10, height: 40 }],
        intersectionCost: 100,
        overlapCostPerPx: 1,
      },
    };
    const topologies = searchRoutes(world, requests).map((result) => result.route);
    const initial = realizeRoutes(world, topologies);
    expect(initial.quality.events.some((event) => event.kind === 'group-title')).toBe(true);
    const options = {
      timeBudgetMs: Infinity,
      adoptedRouteIndexes: new Set<number>(),
    };
    const result = repairProductionRoutes(world, requests, topologies, initial, options);
    expect(result.quality.events.some((event) => event.kind === 'group-title')).toBe(false);
    expect(result.routes[0].ports()).toEqual(initial.routes[0].ports());
    expect(compareRoutingQualityCosts(result.quality.cost, initial.quality.cost)).toBeLessThan(0);
    const replay = realizeRoutes(world, result.topologies, result.policies);
    expect(replay.routes[0].points()).toEqual(result.routes[0].points());
  });

  it('can salvage a worse candidate through a coupled track correction within the same budget', () => {
    const { layoutManager, requests } = crossedScene();
    const world = {
      ...buildCorridorWorld(layoutManager, requests),
      groupTitleAvoidance: {
        titles: [{ x: 110, y: 50, width: 20, height: 20 }],
        intersectionCost: 100,
        overlapCostPerPx: 1,
      },
    };
    const topologies = searchRoutes(world, requests).map((result) => result.route);
    const initial = realizeRoutes(world, topologies);
    const options = { timeBudgetMs: Infinity, adoptedRouteIndexes: new Set<number>() };
    const result = repairProductionRoutes(world, requests, topologies, initial, options);
    const diagnostics = result.diagnostics.quality;
    let incumbentCost = initial.quality.cost;
    let salvaged = false;
    for (const candidate of diagnostics.candidates) {
      if (candidate.status !== 'accepted') {
        continue;
      }
      if (candidate.refinementKey) {
        expect(compareRoutingQualityCosts(candidate.cost!, incumbentCost)).toBeLessThan(0);
        if (compareRoutingQualityCosts(candidate.rawCost!, incumbentCost) >= 0) {
          salvaged = true;
        }
      }
      incumbentCost = candidate.cost!;
    }
    expect(salvaged).toBe(true);
    expect(diagnostics.acceptedRefinements).toBeGreaterThan(0);
    expect(
      diagnostics.candidates.some(
        (candidate) =>
          candidate.status === 'accepted' &&
          candidate.refinementEvaluations > 0 &&
          !candidate.refinementKey,
      ),
    ).toBe(true); // Failed refinements must not hide a safe raw improvement.
    expect(result.quality.cost.invalid).toBe(0);
    expect(result.quality.cost.cap).toBe(0);
    expect(result.quality.events.some((event) => event.kind === 'group-title')).toBe(false);
    expect(
      realizeRoutes(world, result.topologies, result.policies).routes.map((r) => r.points()),
    ).toEqual(result.routes.map((route) => route.points()));

    const expired = repairProductionRoutes(world, requests, topologies, initial, {
      ...options,
      timeBudgetMs: 0,
    });
    expect(expired.diagnostics.quality.evaluations).toBe(0);
    expect(expired.diagnostics.quality.refinementEvaluations).toBe(0);
    expect(expired.routes.map((route) => route.points())).toEqual(
      initial.routes.map((route) => route.points()),
    );
  });
});

function crossedScene() {
  return sceneRouteRequests(
    [
      leaf('nw', 6, 2, 100, 50),
      leaf('ne', 163, 17, 100, 50),
      leaf('sw', 2, 97, 100, 50),
      leaf('se', 153, 102, 100, 50),
    ],
    [
      { id: 'r0', from: 'nw', to: 'ne' },
      { id: 'r1', from: 'se', to: 'nw' },
      { id: 'r2', from: 'nw', to: 'sw' },
      { id: 'r3', from: 'sw', to: 'ne' },
      { id: 'r4', from: 'se', to: 'nw' },
      { id: 'r5', from: 'sw', to: 'se' },
    ],
  );
}
