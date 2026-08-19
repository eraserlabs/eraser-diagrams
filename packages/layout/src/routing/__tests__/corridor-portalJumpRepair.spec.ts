import type { LayoutEntity } from '../../types.js';
import { sceneRouteRequests } from '../routingTestUtils.js';
import { repairPortalJump } from '../corridor/portalJumpRepair.js';
import { compareRoutingQualityCosts } from '../corridor/qualityCost.js';
import { realizeRoutes } from '../corridor/realize.js';
import { buildCorridorWorld } from '../corridor/worldConstruction.js';
import { topologySignature } from '../corridor/selectedPortalRepair.js';
import { searchRoutes } from '../corridor/topology.js';

describe('routing corridor portal-jump repair', () => {
  it('composes multiple route changes into one improving batch', () => {
    // Scene: two swapped routes around an off-center middle block. Each demanded route gets a
    // hidden-portal candidate, both compose into one jump, and the batch lands whole.
    //
    // Exercise a batch where multiple route candidates compose cleanly and land together.
    const { layoutManager, requests } = sceneRouteRequests(
      [
        syntheticEntity('a1', 0, 0, 120, 60),
        syntheticEntity('a2', 0, 180, 120, 60),
        syntheticEntity('t1', 420, 20, 120, 60),
        syntheticEntity('t2', 420, 200, 120, 60),
        syntheticEntity('mid', 190, 126, 140, 90),
      ],
      [
        { id: 'r1', from: 'a1', to: 't2' },
        { id: 'r2', from: 'a2', to: 't1' },
      ],
    );
    const world = buildCorridorWorld(layoutManager, requests);
    const search = searchRoutes(world, requests);
    expect(search.every((result) => !result.fallback)).toBe(true);
    const topologies = search.map((result) => result.route);
    const initial = realizeRoutes(world, topologies);
    const result = repairPortalJump(world, requests, topologies, initial, {});

    const changedRouteIndexes = result.topologies.flatMap((route, routeIndex) =>
      topologySignature([route]) === topologySignature([topologies[routeIndex]])
        ? []
        : [routeIndex],
    );
    expect(changedRouteIndexes).toEqual([0, 1]);
    expect(result.routes.map((route) => route.points())).not.toEqual(
      initial.routes.map((route) => route.points()),
    );
    expect(compareRoutingQualityCosts(result.quality.cost, initial.quality.cost)).toBeLessThan(0);
  });
});

function syntheticEntity(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
): LayoutEntity {
  return { id, x, y, width, height } as LayoutEntity;
}
