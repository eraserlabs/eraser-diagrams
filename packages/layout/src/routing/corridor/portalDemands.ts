import { compareNumber } from './geometry.js';
import { ROUTING_QUALITY_COSTS, type RoutingQualityEvent } from './qualityCost.js';
import type { Route } from './route.js';

const EPSILON = 1e-6;

/** Convert quality events into the route and corridor demands used by portal repair. */
export interface CorridorDemand {
  readonly corridorIndex: number;
  readonly eventCount: number;
  readonly cost: number;
}

export interface RouteDemandDraft {
  readonly routeIndex: number;
  readonly requestIndex: number;
  crossingEventCount: number;
  topologyQualityEventCount: number;
  wallTouchEventCount: number;
  wallHugEventCount: number;
  terminalDirectionEventCount: number;
  nearFaceTurnEventCount: number;
  portCenteringEventCount: number;
  qualityCost: number;
  readonly partners: Set<number>;
  readonly portalEventCounts: Map<number, number>;
  readonly corridorDemands: Map<number, CorridorDemand>;
}

export function makeRouteDemandDrafts(routes: readonly Route[]): RouteDemandDraft[] {
  return routes.map((route, routeIndex) => ({
    routeIndex,
    requestIndex: route.requestIndex,
    crossingEventCount: 0,
    topologyQualityEventCount: 0,
    wallTouchEventCount: 0,
    wallHugEventCount: 0,
    terminalDirectionEventCount: 0,
    nearFaceTurnEventCount: 0,
    portCenteringEventCount: 0,
    qualityCost: 0,
    partners: new Set<number>(),
    portalEventCounts: new Map<number, number>(),
    corridorDemands: new Map<number, CorridorDemand>(),
  }));
}

export function addEndpointQualityDemand(
  drafts: readonly RouteDemandDraft[],
  routes: readonly Route[],
  event: RoutingQualityEvent,
): void {
  if (
    event.kind !== 'terminal-direction' &&
    event.kind !== 'near-face-turn' &&
    event.kind !== 'port-centering'
  ) {
    return;
  }
  for (const routeIndex of event.routeIndexes) {
    const draft = drafts[routeIndex];
    const route = routes[routeIndex];
    if (!draft || !route) {
      continue;
    }
    if (event.kind === 'terminal-direction') {
      draft.terminalDirectionEventCount += 1;
    } else if (event.kind === 'near-face-turn') {
      draft.nearFaceTurnEventCount += 1;
    } else {
      draft.portCenteringEventCount += 1;
    }
    draft.qualityCost += event.cost;
    for (const visit of event.visits ?? []) {
      if (visit.routeIndex === routeIndex) {
        addVisitPortals(draft.portalEventCounts, route, visit.visitIndex);
      }
    }
  }
}

export function addWallQualityDemand(
  drafts: readonly RouteDemandDraft[],
  routes: readonly Route[],
  event: RoutingQualityEvent,
): void {
  if (event.kind !== 'wall-touch' && event.kind !== 'wall-hug' && event.kind !== 'near-face-turn') {
    return;
  }
  for (const routeIndex of event.routeIndexes) {
    const draft = drafts[routeIndex];
    const route = routes[routeIndex];
    if (!draft || !route) {
      continue;
    }
    if (event.kind === 'wall-touch') {
      draft.wallTouchEventCount += 1;
    } else if (event.kind === 'wall-hug') {
      draft.wallHugEventCount += 1;
    } else {
      draft.nearFaceTurnEventCount += 1;
    }
    draft.qualityCost += event.cost;
    for (const visit of event.visits ?? []) {
      if (visit.routeIndex === routeIndex) {
        addVisitPortals(draft.portalEventCounts, route, visit.visitIndex);
      }
    }
  }
}

export function addCrossingDemand(
  drafts: readonly RouteDemandDraft[],
  routes: readonly Route[],
  routeIndex: number,
  visitIndex: number,
  partnerRouteIndex: number,
): void {
  const draft = drafts[routeIndex];
  draft.crossingEventCount += 1;
  draft.partners.add(partnerRouteIndex);
  const route = routes[routeIndex];
  addVisitPortals(draft.portalEventCounts, route, visitIndex);
  const visit = route.visits[visitIndex];
  if (visit) {
    addCorridorDemand(draft, visit.corridorIndex, ROUTING_QUALITY_COSTS.crossing);
  }
}

export function addAttributedCorridorDemands(
  drafts: readonly RouteDemandDraft[],
  routes: readonly Route[],
  event: RoutingQualityEvent,
): void {
  const seen = new Set<string>();
  for (const visitRef of event.visits ?? []) {
    const draft = drafts[visitRef.routeIndex];
    const visit = routes[visitRef.routeIndex]?.visits[visitRef.visitIndex];
    if (!draft || !visit) {
      continue;
    }
    const key = `${visitRef.routeIndex}:${visit.corridorIndex}`;
    if (!seen.has(key)) {
      seen.add(key);
      addCorridorDemand(draft, visit.corridorIndex, event.cost);
    }
  }
}

function addCorridorDemand(draft: RouteDemandDraft, corridorIndex: number, cost: number): void {
  const demand = draft.corridorDemands.get(corridorIndex);
  draft.corridorDemands.set(corridorIndex, {
    corridorIndex,
    eventCount: (demand?.eventCount ?? 0) + 1,
    cost: (demand?.cost ?? 0) + cost,
  });
}

export function addVisitPortals(
  counts: Map<number, number>,
  route: Route,
  visitIndex: number,
): void {
  const visit = route.visits[visitIndex];
  if (!visit) {
    return;
  }
  const portalIndexes = new Set<number>();
  for (const boundary of [visit.entry, visit.exit]) {
    if (boundary.kind === 'portal') {
      portalIndexes.add(boundary.portalIndex);
    }
  }
  for (const portalIndex of portalIndexes) {
    counts.set(portalIndex, (counts.get(portalIndex) ?? 0) + 1);
  }
}

export function compareRouteDemands(left: RouteDemandDraft, right: RouteDemandDraft): number {
  return (
    right.wallTouchEventCount - left.wallTouchEventCount ||
    right.terminalDirectionEventCount - left.terminalDirectionEventCount ||
    compareNumber(right.qualityCost, left.qualityCost, EPSILON) ||
    right.wallHugEventCount - left.wallHugEventCount ||
    right.nearFaceTurnEventCount - left.nearFaceTurnEventCount ||
    right.portCenteringEventCount - left.portCenteringEventCount ||
    Number(right.topologyQualityEventCount > 0) - Number(left.topologyQualityEventCount > 0) ||
    right.topologyQualityEventCount - left.topologyQualityEventCount ||
    right.crossingEventCount - left.crossingEventCount ||
    right.partners.size - left.partners.size ||
    left.requestIndex - right.requestIndex ||
    left.routeIndex - right.routeIndex
  );
}
