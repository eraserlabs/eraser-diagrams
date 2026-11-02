import { isPointEndpoint, type RouteSearchRequest } from './contract.js';
import { unexpectedCrossings } from './crossingClassification.js';
import { mechanicalRepairProposals } from './mechanicalRepair.js';
import { addQualityDemand, makeRouteDemandDrafts } from './portalDemands.js';
import {
  compareRoutingQualityCosts,
  routingQualityTier,
  ROUTING_QUALITY_COSTS,
  type RoutingQualityCost,
} from './qualityCost.js';
import {
  replaceRepairRoutes,
  type RepairContext,
  type RepairProposal,
  type RepairState,
} from './repairProposal.js';
import type { RealizedRouteBatch } from './realize.js';
import { Route, type VisitBoundary } from './route.js';
import { continuationBendPenalty, requestEndpointCorridorIndexes } from './topology.js';
import type { CorridorWorld } from './world.js';

const EPSILON = 1e-6;
const MAX_PORTALS_PER_ROUTE = 4;
const MAX_CORRIDORS_PER_ROUTE = 2;

interface SelectedPortalRouteDemand {
  readonly routeIndex: number;
  readonly portals: readonly [number, RoutingQualityCost][];
  readonly corridors: readonly [number, RoutingQualityCost][];
  readonly preservedCorridorIndexes: readonly number[];
}

type AttributedSearchOperation =
  | {
      readonly kind: 'portal';
      readonly portalIndex: number;
      readonly requiredCorridorIndex?: number;
    }
  | { readonly kind: 'corridor'; readonly corridorIndex: number; readonly cost: number };

interface AttributedSearchWork {
  readonly demand: SelectedPortalRouteDemand;
  readonly operation: AttributedSearchOperation;
  readonly cost: RoutingQualityCost;
}

/** Fixed-face track and topology alternatives; no private acceptance loop. */
export function collectRouteProposals(context: RepairContext): RepairProposal[] {
  const { world, batch, topologies, requests, search, mode, protectedRouteIndexes } = context;
  const demands = collectRouteDemands(world, batch, mode, protectedRouteIndexes);
  const operations: AttributedSearchWork[] = [];
  for (const demand of demands) {
    for (const [portalIndex, cost] of demand.portals) {
      for (const requiredCorridorIndex of [...demand.preservedCorridorIndexes, undefined]) {
        operations.push({
          demand,
          cost,
          operation: { kind: 'portal', portalIndex, requiredCorridorIndex },
        });
      }
    }
    for (const [corridorIndex, cost] of demand.corridors) {
      operations.push({
        demand,
        cost,
        operation: {
          kind: 'corridor',
          corridorIndex,
          cost: cost.invalid + cost.cap + cost.scalar,
        },
      });
    }
  }
  const pricedPortals = new Map<number, ReadonlySet<number>>();
  return [
    ...(mode === 'quality' ? mechanicalRepairProposals(context) : []),
    ...operations.flatMap(({ demand, operation, cost }): RepairProposal[] => {
      const { routeIndex } = demand;
      const incumbent = topologies[routeIndex];
      const build = (preservePins: boolean): RepairState | undefined => {
        const request = requests[routeIndex];
        let result = search.search(
          request,
          operation.kind === 'portal'
            ? {
                hiddenPortalIndexes: new Set([operation.portalIndex]),
                requiredCorridorIndex: operation.requiredCorridorIndex,
                preferCenteredTerminalAttachments: false,
              }
            : {
                corridorEntryPenalties: new Map([[operation.corridorIndex, operation.cost]]),
                preferCenteredTerminalAttachments: false,
              },
        );
        if (
          operation.kind === 'portal' &&
          !result.fallback &&
          mode === 'quality' &&
          (result.cost?.portalPenalty ?? 0) > EPSILON
        ) {
          let priced = pricedPortals.get(routeIndex);
          if (!priced) {
            priced = pricedContinuationPortalIndexes(world, request);
            pricedPortals.set(routeIndex, priced);
          }
          const alternative = search.search(request, {
            hiddenPortalIndexes: new Set([...priced, operation.portalIndex]),
            requiredCorridorIndex: operation.requiredCorridorIndex,
            preferCenteredTerminalAttachments: false,
          });
          if (!alternative.fallback) {
            result = alternative;
          }
        }
        if (result.fallback) {
          return undefined;
        }
        const replacement = preservePins
          ? new Route(result.route.requestIndex, incumbent.from, incumbent.to, result.route.visits)
          : result.route;
        return replaceRepairRoutes(context, new Map([[routeIndex, replacement]]));
      };
      const proposal: RepairProposal = {
        kind: operation.kind,
        key: `${routeIndex}:${JSON.stringify(operation)}`,
        routeIndexes: [routeIndex],
        cost,
        build: () => build(false),
      };
      // Re-search must not silently discard successful face placement. Keep an
      // unpinned alternative as well: the new topology may need different ports.
      return [incumbent.from, incumbent.to].some(
        (endpoint) => !isPointEndpoint(endpoint) && endpoint.repairPinTrack !== undefined,
      )
        ? [
            { ...proposal, key: `${proposal.key}:preserve-pins`, build: () => build(true) },
            proposal,
          ]
        : [proposal];
    }),
  ];
}

/** Continuation portals the route-relative bend rule prices for this request. */
function pricedContinuationPortalIndexes(
  world: CorridorWorld,
  request: RouteSearchRequest,
): Set<number> {
  const endpointCorridorIndexes = requestEndpointCorridorIndexes(world, request);
  const result = new Set<number>();
  for (const portal of world.indexer.portals) {
    if (
      portal.kind === 'continue' &&
      continuationBendPenalty(world, endpointCorridorIndexes, portal) > 0
    ) {
      result.add(portal.index);
    }
  }
  return result;
}

export function topologySignature(routes: readonly Route[]): string {
  return JSON.stringify(
    routes.map((route) => [
      route.requestIndex,
      route.from,
      route.to,
      route.visits.map((visit) => [
        visit.corridorIndex,
        boundaryKey(visit.entry),
        boundaryKey(visit.exit),
        visit.feasibleTrack[0],
        visit.feasibleTrack[1],
      ]),
    ]),
  );
}

function boundaryKey(boundary: VisitBoundary | undefined): string {
  if (!boundary) {
    return 'missing';
  }
  return boundary.kind === 'terminal'
    ? `terminal:${boundary.attachmentIndex}`
    : `portal:${boundary.portalIndex}:${boundary.mode}`;
}

function collectRouteDemands(
  world: CorridorWorld,
  batch: RealizedRouteBatch,
  mode: RepairContext['mode'],
  protectedRouteIndexes: ReadonlySet<number> | undefined,
): SelectedPortalRouteDemand[] {
  const drafts = makeRouteDemandDrafts(batch.routes);
  const preservedCorridorsByRoute = new Map<number, Set<number>>();
  if (mode === 'quality') {
    for (const crossing of unexpectedCrossings(
      world,
      batch.routes,
      batch.geometryQuality.crossings,
    )) {
      addQualityDemand(drafts, batch.routes, {
        kind: 'crossing',
        cost: ROUTING_QUALITY_COSTS.crossing,
        routeIndexes: [crossing.a.routeIndex, crossing.b.routeIndex],
        visits: [crossing.a, crossing.b],
      });
    }
    for (let routeIndex = 0; routeIndex < batch.routes.length; routeIndex += 1) {
      const route = batch.routes[routeIndex];
      for (let visitIndex = 0; visitIndex < route.visits.length; visitIndex += 1) {
        const visit = route.visits[visitIndex];
        if (
          visit.entry.kind === 'portal' &&
          visit.entry.mode === 'turn' &&
          visit.exit.kind === 'portal' &&
          visit.exit.mode === 'turn' &&
          visit.entry.portalIndex === visit.exit.portalIndex
        ) {
          addQualityDemand(drafts, batch.routes, {
            kind: 'tiny-kink',
            cost: 0,
            routeIndexes: [routeIndex],
            visits: [{ routeIndex, visitIndex }],
          });
        }
      }
    }
  }
  for (const event of batch.quality.events) {
    if (
      event.kind === 'crossing' ||
      (mode === 'caps' && routingQualityTier(event.kind) === 'scalar')
    ) {
      continue;
    }
    addQualityDemand(drafts, batch.routes, event);
    if (event.kind === 'near-face-turn') {
      for (const visitRef of event.visits ?? []) {
        const route = batch.routes[visitRef.routeIndex];
        const visit = route?.visits[visitRef.visitIndex];
        if (!route || !visit) {
          continue;
        }
        const spans = world.indexer.spans;
        const mouthConstrained =
          visit.feasibleTrack[0] > spans.crossStarts[visit.corridorIndex] + EPSILON ||
          visit.feasibleTrack[1] < spans.crossEnds[visit.corridorIndex] - EPSILON;
        if (!mouthConstrained) {
          continue;
        }
        const corridorIndexes =
          preservedCorridorsByRoute.get(visitRef.routeIndex) ?? new Set<number>();
        corridorIndexes.add(visit.corridorIndex);
        preservedCorridorsByRoute.set(visitRef.routeIndex, corridorIndexes);
      }
    }
    if (event.kind !== 'wall-hug') {
      continue;
    }
    for (const visitRef of event.visits ?? []) {
      const route = batch.routes[visitRef.routeIndex];
      const visit = route?.visits[visitRef.visitIndex];
      if (!route || !visit || visit.feasibleTrack[1] - visit.feasibleTrack[0] > EPSILON) {
        continue;
      }
      const corridorCenter = world.indexer.spans.crossCenter(visit.corridorIndex);
      if (Math.abs(route.nominalTrackOf(visitRef.visitIndex) - corridorCenter) <= EPSILON) {
        continue;
      }
      const corridorIndexes = preservedCorridorsByRoute.get(visitRef.routeIndex) ?? new Set();
      corridorIndexes.add(visit.corridorIndex);
      preservedCorridorsByRoute.set(visitRef.routeIndex, corridorIndexes);
    }
  }
  return drafts
    .filter(
      (draft) =>
        !protectedRouteIndexes?.has(draft.routeIndex) &&
        (draft.portalDemands.size > 0 || draft.corridorDemands.size > 0),
    )
    .map((draft) => ({
      routeIndex: draft.routeIndex,
      preservedCorridorIndexes: [...(preservedCorridorsByRoute.get(draft.routeIndex) ?? [])].sort(
        (left, right) => left - right,
      ),
      portals: [...draft.portalDemands]
        .sort((left, right) => compareRoutingQualityCosts(right[1], left[1]) || left[0] - right[0])
        .slice(0, MAX_PORTALS_PER_ROUTE),
      corridors: [...draft.corridorDemands]
        .filter(([, cost]) => cost.invalid + cost.cap + cost.scalar > EPSILON)
        .sort((left, right) => compareRoutingQualityCosts(right[1], left[1]) || left[0] - right[0])
        .slice(0, MAX_CORRIDORS_PER_ROUTE),
    }));
}
