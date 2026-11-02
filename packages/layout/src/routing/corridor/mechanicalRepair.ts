import type { AxisSpan } from '../../types.js';
import type { GroupTitleQualityEvent } from './groupTitleQuality.js';
import type { RoutingQualityEvent, RoutingQualityEventKind } from './qualityCost.js';
import { replaceRepairRoutes, type RepairContext, type RepairProposal } from './repairProposal.js';
import { Route } from './route.js';

const GROUP_TITLE_TRACK_CLEARANCE = 4;
type MechanicalRepairContext = Pick<
  RepairContext,
  'world' | 'batch' | 'topologies' | 'policies' | 'protectedRouteIndexes'
>;

/** Cheap, topology-preserving proposals triggered by measured geometry defects. */
const MECHANICAL_REPAIRS: Partial<
  Record<
    RoutingQualityEventKind,
    (context: MechanicalRepairContext, event: RoutingQualityEvent) => Generator<RepairProposal>
  >
> = { 'group-title': titleTrackRepairs };

export function* mechanicalRepairProposals(
  context: MechanicalRepairContext,
  routeChanged?: (routeIndex: number) => boolean,
): Generator<RepairProposal> {
  for (const event of context.batch.quality.events) {
    const repair = MECHANICAL_REPAIRS[event.kind];
    if (!repair) {
      continue;
    }
    for (const proposal of repair(context, event)) {
      if (
        proposal.routeIndexes.every(
          (index) =>
            !context.protectedRouteIndexes.has(index) && (!routeChanged || routeChanged(index)),
        )
      ) {
        yield proposal;
      }
    }
  }
}

function* titleTrackRepairs(
  context: MechanicalRepairContext,
  event: RoutingQualityEvent,
): Generator<RepairProposal> {
  const title =
    context.world.groupTitleAvoidance?.titles[(event as GroupTitleQualityEvent).titleIndex];
  if (!title) {
    return;
  }
  for (const { routeIndex, visitIndex } of event.visits ?? []) {
    const visit = context.batch.routes[routeIndex].visits[visitIndex];
    const axis = context.world.indexer.corridors[visit.corridorIndex].axis;
    const start = axis === 'x' ? title.y : title.x;
    const end = start + (axis === 'x' ? title.height : title.width);
    const clearSides: AxisSpan[] = [
      [
        visit.feasibleTrack[0],
        Math.min(visit.feasibleTrack[1], start - GROUP_TITLE_TRACK_CLEARANCE),
      ],
      [Math.max(visit.feasibleTrack[0], end + GROUP_TITLE_TRACK_CLEARANCE), visit.feasibleTrack[1]],
    ];
    for (const feasibleTrack of clearSides) {
      if (feasibleTrack[0] > feasibleTrack[1]) {
        continue;
      }
      yield {
        kind: 'track',
        key: `${routeIndex}:${JSON.stringify({ kind: 'track', visitIndex, feasibleTrack })}`,
        routeIndexes: [routeIndex],
        cost: { invalid: 0, cap: 0, scalar: event.cost },
        build: () => {
          const route = context.topologies[routeIndex];
          const replacement = new Route(
            route.requestIndex,
            route.from,
            route.to,
            route.visits.map((visit, index) =>
              index === visitIndex ? { ...visit, feasibleTrack } : visit,
            ),
          );
          return replaceRepairRoutes(context, new Map([[routeIndex, replacement]]), new Set());
        },
      };
    }
  }
}
