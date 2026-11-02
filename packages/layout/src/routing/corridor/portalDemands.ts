import type { RoutingQualityCost, RoutingQualityEvent } from './qualityCost.js';
import { addRepairEvent } from './repairProposal.js';
import type { Route } from './route.js';

/** Event attribution used to select portal and corridor alternatives for each route. */
export interface RouteDemandDraft {
  readonly routeIndex: number;
  readonly portalDemands: Map<number, RoutingQualityCost>;
  readonly corridorDemands: Map<number, RoutingQualityCost>;
}

export function makeRouteDemandDrafts(routes: readonly Route[]): RouteDemandDraft[] {
  return routes.map((_, routeIndex) => ({
    routeIndex,
    portalDemands: new Map(),
    corridorDemands: new Map(),
  }));
}

/** Attribute each event once per route and each implicated portal/corridor once per event. */
export function addQualityDemand(
  drafts: readonly RouteDemandDraft[],
  routes: readonly Route[],
  event: RoutingQualityEvent,
): void {
  for (const routeIndex of new Set(event.routeIndexes)) {
    const draft = drafts[routeIndex];
    const route = routes[routeIndex];
    if (!draft || !route) {
      continue;
    }
    const portals = new Set<number>();
    const corridors = new Set<number>();
    for (const ref of event.visits ?? []) {
      const visit = ref.routeIndex === routeIndex ? route.visits[ref.visitIndex] : undefined;
      if (!visit) {
        continue;
      }
      corridors.add(visit.corridorIndex);
      for (const boundary of [visit.entry, visit.exit]) {
        if (boundary.kind === 'portal') {
          portals.add(boundary.portalIndex);
        }
      }
    }
    for (const portal of portals) {
      const cost = draft.portalDemands.get(portal) ?? { invalid: 0, cap: 0, scalar: 0 };
      addRepairEvent(cost, event);
      draft.portalDemands.set(portal, cost);
    }
    for (const corridorIndex of corridors) {
      const cost = draft.corridorDemands.get(corridorIndex) ?? { invalid: 0, cap: 0, scalar: 0 };
      addRepairEvent(cost, event);
      draft.corridorDemands.set(corridorIndex, cost);
    }
  }
}
