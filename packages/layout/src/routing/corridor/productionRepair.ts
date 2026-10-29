import type { RouteSearchRequest } from './contract.js';
import { collectFaceProposals } from './fanSpreadRepair.js';
import { leafCutKeys, leafRects } from './leafCuts.js';
import { mechanicalRepairProposals } from './mechanicalRepair.js';
import { collectSpacingProposals } from './mergedSpacingRepair.js';
import { collectEndpointProposals } from './portalJumpRepair.js';
import { compareRoutingQualityCosts, type RoutingQualityCost } from './qualityCost.js';
import { realizeRoutes, reuseOptions, type RealizedRouteBatch } from './realize.js';
import { violatesRepairIdentity } from './repairAcceptance.js';
import type { RepairContext, RepairProposal, RepairState } from './repairProposal.js';
import { createRepairSearch, type RepairSearch } from './repairSearch.js';
import type { Route } from './route.js';
import { collectRouteProposals, topologySignature } from './selectedPortalRepair.js';
import type { CorridorWorld } from './world.js';

const MAX_MECHANICAL_TRIALS = 4;

interface RepairCandidateEvidence {
  readonly passIndex: number;
  readonly kind: RepairProposal['kind'];
  readonly key: string;
  readonly routeIndexes: readonly number[];
  status:
    | 'unavailable'
    | 'duplicate'
    | 'realization-rejection'
    | 'identity-rejection'
    | 'quality-rejection'
    | 'eligible'
    | 'accepted';
  cost?: RoutingQualityCost;
  rawCost?: RoutingQualityCost;
  refinementEvaluations: number;
  refinementKey?: string;
}

interface RepairMetrics {
  acceptedPasses: number;
  evaluations: number;
  refinementEvaluations: number;
  refinedCandidates: number;
  acceptedRefinements: number;
  stoppedBy: 'fixed-point' | 'time-budget';
  readonly candidates: RepairCandidateEvidence[];
}

export interface ProductionRepairDiagnostics {
  readonly budget: { readonly timeBudgetMs: number; readonly exhausted: boolean };
  readonly search: Readonly<RepairSearch['metrics']>;
  readonly quality: RepairMetrics;
  readonly caps: RepairMetrics;
}

export interface ProductionRepairResult extends RealizedRouteBatch, RepairState {
  readonly diagnostics: ProductionRepairDiagnostics;
}

export interface ProductionRepairOptions {
  /** Cooperative deadline; a single search or realization remains atomic. */
  readonly timeBudgetMs: number;
  readonly adoptedRouteIndexes: ReadonlySet<number>;
}

interface EvaluatedCandidate {
  state: RepairState;
  batch: RealizedRouteBatch;
  cuts: ReadonlySet<number>;
  evidence: RepairCandidateEvidence;
}

/** One proposal/evaluation/acceptance loop, with a small severe-defect-only tail. */
export function repairProductionRoutes(
  world: CorridorWorld,
  requests: readonly RouteSearchRequest[],
  initialTopologies: readonly Route[],
  initial: RealizedRouteBatch,
  { timeBudgetMs, adoptedRouteIndexes }: ProductionRepairOptions,
): ProductionRepairResult {
  if (Number.isNaN(timeBudgetMs) || timeBudgetMs < 0) {
    throw new Error(`timeBudgetMs must be a non-negative number, got ${timeBudgetMs}`);
  }
  const startedAt = performance.now();
  const search = createRepairSearch(world);
  const leaves = leafRects(world);
  const cutsFor = (batch: RealizedRouteBatch) =>
    leafCutKeys(batch.routes, batch.geometryQuality.index, leaves, world.entities.length);
  let batch = initial;
  let cuts: ReadonlySet<number> = cutsFor(initial);
  let state: RepairState = {
    topologies: initialTopologies,
    policies: { independentContinuations: [] },
  };
  const modes = ['quality', 'caps'] as const;
  const metrics = modes.map((): RepairMetrics => ({
    acceptedPasses: 0,
    evaluations: 0,
    refinementEvaluations: 0,
    refinedCandidates: 0,
    acceptedRefinements: 0,
    stoppedBy: 'fixed-point',
    candidates: [],
  }));
  const attempts = new Map<string, number>();

  for (const [modeIndex, mode] of modes.entries()) {
    const current = metrics[modeIndex];
    const deadline = startedAt + timeBudgetMs * (mode === 'quality' ? 0.9 : 1);
    while (true) {
      if (performance.now() >= deadline) {
        current.stoppedBy = 'time-budget';
        break;
      }
      const context: RepairContext = {
        ...state,
        world,
        requests,
        batch,
        search,
        protectedRouteIndexes: adoptedRouteIndexes,
        mode,
      };
      const proposals = rankedProposals(
        [
          ...collectRouteProposals(context),
          ...collectEndpointProposals(context),
          ...collectFaceProposals(context),
          ...collectSpacingProposals(context),
        ],
        attempts,
      );
      // Dedup within this incumbent. A changed neighbor can make an old proposal useful.
      const seen = new Set([stateSignature(state)]);
      let best: EvaluatedCandidate | undefined;
      let done = false;
      let cursor = 0;
      while (!done) {
        // Compare the highest-attributed opportunities before committing. Widen
        // while untried opportunities could beat its gain, or until proposals are
        // exhausted if nothing improves.
        for (let slot = 0; slot < 12; slot += 1) {
          if (performance.now() >= deadline) {
            current.stoppedBy = 'time-budget';
            done = true;
            break;
          }
          const proposal = proposals[cursor++];
          if (!proposal) {
            done = true;
            break;
          }
          attempts.set(proposal.key, (attempts.get(proposal.key) ?? 0) + 1);
          const evidence: RepairCandidateEvidence = {
            passIndex: current.acceptedPasses,
            kind: proposal.kind,
            key: proposal.key,
            routeIndexes: proposal.routeIndexes,
            status: 'unavailable',
            refinementEvaluations: 0,
          };
          current.candidates.push(evidence);
          const rawState = proposal.build();
          if (!rawState) {
            continue;
          }
          const signature = stateSignature(rawState);
          if (seen.has(signature)) {
            evidence.status = 'duplicate';
            continue;
          }
          seen.add(signature);
          current.evaluations += 1;
          let raw: RealizedRouteBatch;
          try {
            raw = realizeRoutes(world, rawState.topologies, {
              continuationCutSelection: 'best',
              ...reuseOptions(batch, { incrementalSpacing: true }),
              ...rawState.policies,
            });
          } catch {
            evidence.status = 'realization-rejection';
            continue;
          }
          evidence.rawCost = evidence.cost = raw.quality.cost;
          // A candidate may be worthwhile only after a small mechanical correction.
          // Include coupled spacing changes, but leave inherited defects elsewhere alone.
          const refinements = mechanicalRepairProposals(
            { ...context, ...rawState, batch: raw },
            (index) => !samePoints(raw.routes[index], batch.routes[index]),
          );
          let candidateState = rawState;
          let candidate = raw;
          let refinementKey: string | undefined;
          let candidateBest: EvaluatedCandidate | undefined;
          for (let trial = 0; trial <= MAX_MECHANICAL_TRIALS; trial += 1) {
            if (trial > 0) {
              const next = refinements.next();
              if (next.done) {
                break;
              }
              if (performance.now() >= deadline) {
                current.stoppedBy = 'time-budget';
                done = true;
                break;
              }
              const refinedState = next.value.build();
              if (!refinedState) {
                continue;
              }
              const refinedSignature = stateSignature(refinedState);
              if (seen.has(refinedSignature)) {
                continue;
              }
              seen.add(refinedSignature);
              current.evaluations += 1;
              current.refinementEvaluations += 1;
              evidence.refinementEvaluations += 1;
              try {
                candidate = realizeRoutes(world, refinedState.topologies, {
                  continuationCutSelection: 'best',
                  ...reuseOptions(raw, { incrementalSpacing: true }),
                  ...refinedState.policies,
                });
              } catch {
                continue;
              }
              candidateState = refinedState;
              refinementKey = next.value.key;
            }
            if (
              compareRoutingQualityCosts(candidate.quality.cost, batch.quality.cost) >= 0 ||
              (mode === 'caps' &&
                candidate.quality.cost.invalid >= batch.quality.cost.invalid &&
                candidate.quality.cost.cap >= batch.quality.cost.cap)
            ) {
              if (!candidateBest) {
                evidence.status = 'quality-rejection';
              }
              continue;
            }
            const candidateCuts = cutsFor(candidate);
            if (
              violatesRepairIdentity(candidate.routes, candidateCuts, cuts) ||
              [...adoptedRouteIndexes].some(
                (index) => !samePoints(batch.routes[index], candidate.routes[index]),
              )
            ) {
              if (!candidateBest) {
                evidence.status = 'identity-rejection';
              }
              continue;
            }
            if (
              !candidateBest ||
              compareRoutingQualityCosts(candidate.quality.cost, candidateBest.batch.quality.cost) <
                0
            ) {
              candidateBest = {
                state: candidateState,
                batch: candidate,
                cuts: candidateCuts,
                evidence,
              };
              evidence.status = 'eligible';
              evidence.cost = candidate.quality.cost;
              evidence.refinementKey = refinementKey;
            }
          }
          if (evidence.refinementKey) {
            current.refinedCandidates += 1;
          }
          if (
            candidateBest &&
            (!best ||
              compareRoutingQualityCosts(
                candidateBest.batch.quality.cost,
                best.batch.quality.cost,
              ) < 0)
          ) {
            best = candidateBest;
          }
        }
        if (best) {
          // Attributed defect cost is an opportunity estimate, not a strict gain bound.
          const gain = {
            invalid: batch.quality.cost.invalid - best.batch.quality.cost.invalid,
            cap: batch.quality.cost.cap - best.batch.quality.cost.cap,
            scalar: batch.quality.cost.scalar - best.batch.quality.cost.scalar,
          };
          if (
            !proposals.some(
              (proposal, index) =>
                index >= cursor && compareRoutingQualityCosts(proposal.cost, gain) > 0,
            )
          ) {
            break;
          }
        }
      }
      if (!best) {
        break;
      }
      best.evidence.status = 'accepted';
      state = best.state;
      batch = best.batch;
      cuts = best.cuts;
      current.acceptedPasses += 1;
      current.acceptedRefinements += Number(best.evidence.refinementKey !== undefined);
      if (current.stoppedBy !== 'fixed-point') {
        break;
      }
    }
  }
  return {
    ...batch,
    ...state,
    diagnostics: {
      budget: { timeBudgetMs, exhausted: performance.now() >= startedAt + timeBudgetMs },
      search: search.metrics,
      quality: metrics[0],
      caps: metrics[1],
    },
  };
}

/** Prioritize the largest current defect opportunity; retries break equal-cost ties. */
function rankedProposals(
  proposals: RepairProposal[],
  attempts: ReadonlyMap<string, number>,
): RepairProposal[] {
  return proposals.sort(
    (a, b) =>
      compareRoutingQualityCosts(b.cost, a.cost) ||
      (attempts.get(a.key) ?? 0) - (attempts.get(b.key) ?? 0),
  );
}

function stateSignature({ topologies, policies }: RepairState): string {
  return `${topologySignature(topologies)}|${JSON.stringify({
    ...policies,
    independentContinuations: [...policies.independentContinuations].sort(
      (a, b) => a.routeIndex - b.routeIndex || a.afterVisitIndex - b.afterVisitIndex,
    ),
    turnRetrackCorridors: [...(policies.turnRetrackCorridors ?? [])].sort((a, b) => a - b),
  })}`;
}

function samePoints(left: Route, right: Route): boolean {
  const a = left.points();
  const b = right.points();
  return a.length === b.length && a.every((point, i) => point.x === b[i].x && point.y === b[i].y);
}
