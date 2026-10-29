import type { RouteSearchRequest } from './contract.js';
import type { IndependentContinuationBoundary } from './continuations.js';
import {
  routingQualityTier,
  type RoutingQualityCost,
  type RoutingQualityEvent,
} from './qualityCost.js';
import type { RealizeRouteOptions, RealizedRouteBatch } from './realize.js';
import type { RepairSearch } from './repairSearch.js';
import type { Route } from './route.js';
import type { CorridorWorld } from './world.js';

export interface RepairPolicies extends Pick<
  RealizeRouteOptions,
  'turnRetrackCorridors' | 'continuationTrackClearance' | 'terminalCenterContinuations'
> {
  readonly independentContinuations: readonly IndependentContinuationBoundary[];
}

export interface RepairState {
  readonly topologies: readonly Route[];
  readonly policies: RepairPolicies;
}

export interface RepairContext extends RepairState {
  readonly world: CorridorWorld;
  readonly requests: readonly RouteSearchRequest[];
  readonly batch: RealizedRouteBatch;
  readonly search: RepairSearch;
  readonly protectedRouteIndexes: ReadonlySet<number>;
  readonly mode: 'quality' | 'caps';
}

export interface RepairProposal {
  readonly kind: 'track' | 'portal' | 'corridor' | 'endpoint' | 'face' | 'spacing';
  readonly key: string;
  readonly routeIndexes: readonly number[];
  readonly cost: RoutingQualityCost;
  /** Search/build only when scheduled; realization and acceptance belong to the loop. */
  readonly build: () => RepairState | undefined;
}

/** Priority accounts only for events the operation is intended to address. */
export function addRepairEvent(
  cost: { invalid: number; cap: number; scalar: number },
  event: RoutingQualityEvent,
): void {
  cost[routingQualityTier(event.kind)] += event.cost;
}

/** Visit-indexed policies survive track edits, but not a topology replacement. */
export function replaceRepairRoutes(
  state: RepairState,
  replacements: ReadonlyMap<number, Route>,
  resetRouteIndexes: ReadonlySet<number> = new Set(replacements.keys()),
): RepairState {
  return {
    topologies: state.topologies.map((route, index) => replacements.get(index) ?? route),
    policies: {
      ...state.policies,
      independentContinuations: state.policies.independentContinuations.filter(
        (boundary) => !resetRouteIndexes.has(boundary.routeIndex),
      ),
    },
  };
}
