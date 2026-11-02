import { TimeTracker } from '@eraserlabs/utils';
import { LayoutManager } from '../LayoutManager.js';
import { adoptRoute } from './corridor/adoptRoutes.js';
import {
  guideFamilyRoutes,
  type FamilyGuidanceOptions,
  type FamilyGuidanceTrace,
} from './corridor/familyGuidance.js';
import { withGroupTitleAvoidance, type GroupTitleOptions } from './corridor/groupTitleQuality.js';
import { placeLabels, type LabelPlacementResult } from './corridor/labelPlacement.js';
import {
  repairProductionRoutes,
  type ProductionRepairDiagnostics,
} from './corridor/productionRepair.js';
import { realizeRoutes, type RealizedRouteBatch } from './corridor/realize.js';
import { CorridorRouteError } from './corridor/route.js';
import { buildCorridorWorld } from './corridor/worldConstruction.js';
import type { LabelSpec } from './corridor/text.js';
import { searchRoute, type RouteSearchResult } from './corridor/topology.js';
import type { RouteSearchRequest } from './corridor/contract.js';
import type { CorridorWorld } from './corridor/world.js';

export interface CorridorRoutingRequest extends RouteSearchRequest {
  /** Exact incumbent geometry: participate without moving or changing topology. */
  readonly adoptedPoints?: readonly (readonly [number, number])[];
  readonly labelSize?: LabelSpec['size'];
}

/** Production repair after spacing: off, or on within a cooperative wall-clock budget. */
export type RepairPolicy = false | { readonly timeBudgetMs: number };

export interface CorridorRoutingResult {
  readonly status: 'completed';
  readonly world: CorridorWorld;
  /** Original requestIndex for each dense output slot, after adoption and recovery. */
  readonly activeRequestIndexes: readonly number[];
  readonly failedRequestIndexes: readonly number[];
  readonly searchResults: readonly RouteSearchResult[];
  readonly realization: RealizedRouteBatch;
  readonly repairDiagnostics?: ProductionRepairDiagnostics;
  readonly familyGuidance?: { readonly traces: readonly FamilyGuidanceTrace[]; reverted?: string };
  readonly labels?: LabelPlacementResult;
  readonly timing: Readonly<Record<string, number>>;
}

interface CorridorRoutingFailure {
  readonly status: 'fallback';
  readonly failedRequestIndexes: readonly number[];
  readonly timing: Readonly<Record<string, number>>;
}

/**
 * Solve a batch, dropping attributed route failures and retrying peers. This is
 * the only owner of dense solver indexes. Failed incumbent adoptions are omitted,
 * never rerouted; incumbents alone are never solved. Callers provide fallback
 * geometry for failed selections.
 */
export function executeCorridorRouting(
  layoutManager: LayoutManager,
  requests: readonly CorridorRoutingRequest[],
  {
    repair,
    groupTitleAvoidance = { corridorPenalty: 0, intersectionCost: 100, overlapCostPerPx: 1 },
    familyGuidance = { penalty: 2, localRadius: 200 },
  }: {
    readonly repair: RepairPolicy;
    /** Exact title costs by default; false disables them for comparisons. */
    readonly groupTitleAvoidance?: GroupTitleOptions | false;
    /** Gentle local same-face fan guidance; false disables it for comparisons. */
    readonly familyGuidance?: FamilyGuidanceOptions | false;
  },
): CorridorRoutingResult | CorridorRoutingFailure {
  const tracker = new TimeTracker();
  const failedRequestIndexes: number[] = [];
  let active = [...requests];

  while (active.some((request) => request.adoptedPoints === undefined)) {
    const world = withGroupTitleAvoidance(
      buildCorridorWorld(layoutManager, active),
      groupTitleAvoidance || undefined,
    );
    tracker.mark('world');
    const participating: CorridorRoutingRequest[] = [];
    const adoptedRouteIndexes = new Set<number>();
    const searchResults: RouteSearchResult[] = [];
    for (const input of active) {
      const request = { ...input, requestIndex: participating.length };
      let result: RouteSearchResult;
      if (input.adoptedPoints) {
        const route = adoptRoute(world, request, input.adoptedPoints, { pinTracks: true });
        if (!route) {
          continue;
        }
        adoptedRouteIndexes.add(request.requestIndex);
        result = {
          route,
          fallback: false,
          searchPass: 'preferred',
          metrics: { expansions: 0, maxQueue: 0, maxLabelsPerCorridor: 0, passCount: 0 },
        };
      } else {
        result = searchRoute(world, request);
      }
      participating.push(input);
      searchResults.push(result);
    }
    active = participating;
    tracker.mark('search');

    let failed = searchResults.flatMap((result, index) => (result.fallback ? [index] : []));
    if (failed.length === 0) {
      try {
        const denseRequests = active.map((request, requestIndex) => ({ ...request, requestIndex }));
        const guided = familyGuidance
          ? guideFamilyRoutes(
              world,
              denseRequests,
              searchResults,
              adoptedRouteIndexes,
              familyGuidance,
            )
          : undefined;
        if (guided) {
          tracker.mark('familyGuidance');
        }
        let selectedResults = guided?.searchResults ?? searchResults;
        const guidanceDiagnostics: CorridorRoutingResult['familyGuidance'] = guided
          ? { traces: guided.traces }
          : undefined;
        const realizeAndRepair = (results: readonly RouteSearchResult[]) => {
          const topologies = results.map((result) => result.route);
          const initial = realizeRoutes(world, topologies);
          tracker.mark('realization');
          const repaired =
            repair === false
              ? undefined
              : repairProductionRoutes(world, denseRequests, topologies, initial, {
                  timeBudgetMs: repair.timeBudgetMs,
                  adoptedRouteIndexes,
                });
          tracker.mark('repair');
          return { realization: repaired ?? initial, repairDiagnostics: repaired?.diagnostics };
        };
        let solved: ReturnType<typeof realizeAndRepair>;
        try {
          solved = realizeAndRepair(selectedResults);
        } catch (error) {
          if (
            !(error instanceof CorridorRouteError) ||
            !guided?.traces.some((trace) => trace.accepted)
          ) {
            throw error;
          }
          // A soft topology preference must not make ordinary routable lines disappear.
          guidanceDiagnostics!.reverted = error.message;
          selectedResults = searchResults;
          solved = realizeAndRepair(selectedResults);
        }
        const { realization, repairDiagnostics } = solved;
        const labelSpecs = active.flatMap((request, routeIndex): LabelSpec[] =>
          request.labelSize ? [{ routeIndex, size: request.labelSize }] : [],
        );
        const labels =
          labelSpecs.length > 0 ? placeLabels(world, realization.routes, labelSpecs) : undefined;
        tracker.mark('labels');
        return {
          status: 'completed',
          world,
          activeRequestIndexes: active.map((request) => request.requestIndex),
          failedRequestIndexes,
          searchResults: selectedResults,
          realization,
          repairDiagnostics,
          ...(guidanceDiagnostics ? { familyGuidance: guidanceDiagnostics } : {}),
          labels,
          timing: { ...tracker.timings, total: tracker.totalMs() },
        };
      } catch (error) {
        if (!(error instanceof CorridorRouteError)) {
          throw error;
        }
        if (process.env.NODE_ENV !== 'production') {
          console.error('Corridor routes failed; dropping them from the batch', error);
        }
        failed = [...new Set(error.routeIndexes)];
        if (
          failed.length === 0 ||
          failed.some((index) => !Number.isInteger(index) || index < 0 || index >= active.length)
        ) {
          throw error;
        }
      }
    }
    const failedIndexes = new Set(failed);
    for (const index of failed) {
      failedRequestIndexes.push(active[index].requestIndex);
    }
    active = active.filter((_, index) => !failedIndexes.has(index));
  }

  return {
    status: 'fallback',
    failedRequestIndexes,
    timing: { ...tracker.timings, total: tracker.totalMs() },
  };
}
