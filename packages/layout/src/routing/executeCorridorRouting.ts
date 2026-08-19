import { TimeTracker } from '@eraserlabs/utils';
import { LayoutManager } from '../LayoutManager.js';
import { adoptRoute } from './corridor/adoptRoutes.js';
import type { LabelPlacementResult } from './corridor/labelPlacement.js';
import { placeLabels } from './corridor/labelPlacement.js';
import {
  repairProductionRoutes,
  type ProductionRepairOptions,
  type ProductionRepairResult,
} from './corridor/productionRepair.js';
import { realizeRoutes, type RealizedRouteBatch } from './corridor/realize.js';
import { buildCorridorWorld } from './corridor/worldConstruction.js';
import type { LabelSpec } from './corridor/text.js';
import { searchRoute, type RouteSearchResult } from './corridor/topology.js';
import type { RouteSearchRequest } from './corridor/contract.js';
import type { CorridorWorld } from './corridor/world.js';

export interface ExecuteCorridorRoutingOptions {
  /** Run the accepted production repair composition after initial realization. */
  readonly repair?: boolean;
  /** Options consumed by the authoritative production repair composition. */
  readonly repairOptions?: ProductionRepairOptions;
  /** Measured labels to place against the final repaired geometry. */
  readonly labelSpecs?: readonly LabelSpec[];
  /** Existing route geometry to adopt at the corresponding request index. */
  readonly adoptedRoutes?: ReadonlyMap<
    number,
    {
      readonly points: readonly (readonly [number, number])[];
      readonly pinTracks?: boolean;
    }
  >;
}

export interface CorridorRoutingTiming {
  readonly world: number;
  readonly search: number;
  readonly realization: number;
  readonly repair: number;
  readonly labels: number;
  readonly total: number;
}

export interface CorridorRoutingResult {
  readonly status: 'completed';
  readonly world: CorridorWorld;
  readonly searchResults: readonly RouteSearchResult[];
  readonly initialTopologies: readonly RouteSearchResult['route'][];
  readonly initialRealization: RealizedRouteBatch;
  readonly realization: RealizedRouteBatch;
  readonly productionRepair?: ProductionRepairResult;
  readonly labels?: LabelPlacementResult;
  readonly timing: CorridorRoutingTiming;
}

export interface CorridorRoutingFallbackResult {
  readonly status: 'fallback';
  readonly world: CorridorWorld;
  readonly searchResults: readonly RouteSearchResult[];
  readonly timing: CorridorRoutingTiming;
}

export type CorridorRoutingExecution = CorridorRoutingResult | CorridorRoutingFallbackResult;

export class CorridorAdoptionError extends Error {
  constructor(readonly routeIndexes: readonly number[]) {
    super(`Could not adopt corridor routes: ${routeIndexes.join(', ')}`);
  }
}

/**
 * Execute the authoritative corridor-routing pipeline. Callers own request
 * construction and committing the returned geometry to their data model.
 */
export function executeCorridorRouting(
  layoutManager: LayoutManager,
  requests: readonly RouteSearchRequest[],
  options: ExecuteCorridorRoutingOptions = {},
): CorridorRoutingExecution | undefined {
  const tracker = new TimeTracker();
  if (requests.length === 0) {
    return undefined;
  }

  const world = buildCorridorWorld(layoutManager, requests);
  tracker.mark('world');
  const guardedTopologyIndexes = new Set<number>();
  const searchResults: RouteSearchResult[] = [];
  const failedAdoptionRouteIndexes: number[] = [];
  for (let routeIndex = 0; routeIndex < requests.length; routeIndex += 1) {
    const request = requests[routeIndex];
    const adopted = options.adoptedRoutes?.get(routeIndex);
    if (adopted === undefined) {
      searchResults.push(searchRoute(world, request));
      continue;
    }
    const route = adoptRoute(world, request, adopted.points, {
      pinTracks: adopted.pinTracks,
    });
    if (route === undefined) {
      failedAdoptionRouteIndexes.push(routeIndex);
      continue;
    }
    guardedTopologyIndexes.add(routeIndex);
    searchResults.push({
      route,
      fallback: false,
      searchPass: 'preferred',
      metrics: {
        expansions: 0,
        maxQueue: 0,
        maxLabelsPerCorridor: 0,
        passCount: 0,
      },
    });
  }
  if (failedAdoptionRouteIndexes.length > 0) {
    throw new CorridorAdoptionError(failedAdoptionRouteIndexes);
  }
  tracker.mark('search');
  const timings = tracker.timings;
  if (searchResults.some((result) => result.fallback)) {
    return {
      status: 'fallback',
      world,
      searchResults,
      timing: {
        world: timings['world'],
        search: timings['search'],
        realization: 0,
        repair: 0,
        labels: 0,
        total: tracker.totalMs(),
      },
    };
  }

  const initialTopologies = searchResults.map((result) => result.route);
  // The fallback scan and the topology projection above are not billed to any phase.
  tracker.reset();
  const initialRealization = realizeRoutes(world, initialTopologies);
  tracker.mark('realization');
  const productionRepair =
    options.repair !== false
      ? repairProductionRoutes(world, requests, initialTopologies, initialRealization, {
          ...options.repairOptions,
          guardedTopologyIndexes: new Set([
            ...(options.repairOptions?.guardedTopologyIndexes ?? []),
            ...guardedTopologyIndexes,
          ]),
        })
      : undefined;
  tracker.mark('repair');
  const realization = productionRepair ?? initialRealization;
  const labels =
    options.labelSpecs && options.labelSpecs.length > 0
      ? placeLabels(world, realization.routes, options.labelSpecs)
      : undefined;
  tracker.mark('labels');

  return {
    status: 'completed',
    world,
    searchResults,
    initialTopologies,
    initialRealization,
    realization,
    ...(productionRepair ? { productionRepair } : {}),
    ...(labels ? { labels } : {}),
    timing: {
      world: timings['world'],
      search: timings['search'],
      realization: timings['realization'],
      repair: timings['repair'],
      labels: timings['labels'],
      total: tracker.totalMs(),
    },
  };
}
