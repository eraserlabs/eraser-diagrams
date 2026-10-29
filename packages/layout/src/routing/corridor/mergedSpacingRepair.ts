import { continuationKey, continuationKeySet } from './continuations.js';
import {
  compareRoutingQualityCosts,
  routingQualityTier,
  type RoutingQualityCost,
} from './qualityCost.js';
import { addRepairEvent, type RepairContext, type RepairProposal } from './repairProposal.js';
import type { Route } from './route.js';

const MAX_CONTINUATION_CANDIDATES = 8;

/** Release local spacing constraints; the decision loop realizes and compares proposals. */
export function collectSpacingProposals(context: RepairContext): RepairProposal[] {
  const { batch, protectedRouteIndexes } = context;
  const policies = {
    ...context.policies,
    terminalCenterContinuations:
      context.policies.terminalCenterContinuations ??
      (batch.spacing.continuations.some(
        (continuation) =>
          continuation.policy === 'independent' &&
          continuation.reason === 'terminal-center-conflict',
      )
        ? true
        : undefined),
  };
  const activeContinuations = continuationKeySet(policies.independentContinuations);
  const continuations = new Map<string, RepairProposal>();
  const corridorCosts = new Map<number, RoutingQualityCost>();
  const combinedRetrackCost = { invalid: 0, cap: 0, scalar: 0 };
  for (const event of batch.quality.events) {
    if (context.mode === 'caps' && routingQualityTier(event.kind) === 'scalar') {
      continue;
    }
    if (
      (event.kind === 'line-merge' || event.kind === 'group-title') &&
      event.routeIndexes.some((routeIndex) => !protectedRouteIndexes.has(routeIndex))
    ) {
      let retracks = false;
      for (const corridorIndex of event.corridorIndexes ?? []) {
        if (!policies.turnRetrackCorridors?.has(corridorIndex)) {
          const cost = corridorCosts.get(corridorIndex) ?? { invalid: 0, cap: 0, scalar: 0 };
          addRepairEvent(cost, event);
          corridorCosts.set(corridorIndex, cost);
          retracks = true;
        }
      }
      if (retracks) {
        addRepairEvent(combinedRetrackCost, event);
      }
    }
    const eventContinuations = new Set<string>();
    for (const { routeIndex, visitIndex } of event.visits ?? []) {
      const route = batch.routes[routeIndex];
      // Spacing repair should not trade a straight line for better-centered ports.
      if (protectedRouteIndexes.has(routeIndex) || isStraight(route)) {
        continue;
      }
      for (const afterVisitIndex of [visitIndex, visitIndex + 1]) {
        const entry = route.visits[afterVisitIndex]?.entry;
        const key = continuationKey(routeIndex, afterVisitIndex);
        if (
          entry?.kind !== 'portal' ||
          entry.mode !== 'continue-straight' ||
          activeContinuations.has(key) ||
          eventContinuations.has(key)
        ) {
          continue;
        }
        eventContinuations.add(key);
        const existing = continuations.get(key);
        const cost = existing?.cost ?? { invalid: 0, cap: 0, scalar: 0 };
        addRepairEvent(cost, event);
        if (existing) {
          continue;
        }
        continuations.set(key, {
          kind: 'spacing',
          key: `continuation:${key}`,
          routeIndexes: [routeIndex],
          cost,
          build: () => ({
            topologies: context.topologies,
            policies: {
              ...policies,
              independentContinuations: [
                ...policies.independentContinuations,
                { routeIndex, afterVisitIndex },
              ],
            },
          }),
        });
      }
    }
  }
  const proposals = [...continuations.values()]
    .sort(
      (left, right) =>
        compareRoutingQualityCosts(right.cost, left.cost) || left.key.localeCompare(right.key),
    )
    .slice(0, MAX_CONTINUATION_CANDIDATES);
  const corridors = [...corridorCosts.keys()].sort((left, right) => left - right);
  const corridorSets = [
    ...corridors.map((index) => [index]),
    ...(corridors.length > 1 ? [corridors] : []),
  ];
  for (const selected of corridorSets) {
    const routeIndexes = batch.routes.flatMap((route, index) =>
      !protectedRouteIndexes.has(index) &&
      route.visits.some((visit) => selected.includes(visit.corridorIndex))
        ? [index]
        : [],
    );
    if (routeIndexes.length === 0) {
      continue;
    }
    proposals.push({
      kind: 'spacing',
      key: `turn-retrack:${selected.join(',')}`,
      routeIndexes,
      cost: selected.length === 1 ? corridorCosts.get(selected[0])! : combinedRetrackCost,
      build: () => {
        const turnRetrackCorridors = new Set([
          ...(policies.turnRetrackCorridors ?? []),
          ...selected,
        ]);
        return {
          topologies: context.topologies,
          policies: {
            ...policies,
            turnRetrackCorridors,
            continuationTrackClearance:
              policies.continuationTrackClearance || turnRetrackCorridors.size > 1,
          },
        };
      },
    });
  }
  return proposals;
}

function isStraight(route: Route): boolean {
  const points = route.points();
  return (
    points.every((point) => point.x === points[0].x) ||
    points.every((point) => point.y === points[0].y)
  );
}
