import type { Direction } from '../../types.js';

export const ROUTING_QUALITY_COSTS = {
  crossing: 225,
  nearFaceTurn: 200,
  backtrackPer24Px: 200,
  portCentering: 175,
  symmetry: 125,
  tinyKink: 100,
  spacingDeficitPer24Px: 100,
  wallHugPer24Px: 50,
  firstOrdinaryBend: 48,
  additionalOrdinaryBend: 24,
  pathPerPx: 1,
  invalidGeometry: 1,
  lineMerge: 1,
  wallTouch: 1,
  terminalDirection: 1,
} as const;

export function ordinaryBendCost(bendCount: number): number {
  return bendCount <= 0
    ? 0
    : ROUTING_QUALITY_COSTS.firstOrdinaryBend +
        (bendCount - 1) * ROUTING_QUALITY_COSTS.additionalOrdinaryBend;
}

export type RoutingQualityStage = 'topology' | 'spacing' | 'text' | 'emission' | 'repair';
export type RoutingQualityTier = 'invalid' | 'cap' | 'scalar';
export type RoutingQualityEventKind =
  | 'backtrack'
  | 'crossing'
  | 'face-fan-symmetry'
  | 'line-merge'
  | 'missing-spacing-contention'
  | 'near-face-turn'
  | 'port-centering'
  | 'sibling-symmetry'
  | 'spacing-deficit'
  | 'terminal-direction'
  | 'tiny-kink'
  | 'wall-hug'
  | 'wall-touch';

const QUALITY_TIER_BY_KIND: Readonly<Record<RoutingQualityEventKind, RoutingQualityTier>> = {
  backtrack: 'scalar',
  crossing: 'scalar',
  'face-fan-symmetry': 'scalar',
  'line-merge': 'cap',
  'missing-spacing-contention': 'invalid',
  'near-face-turn': 'scalar',
  'port-centering': 'scalar',
  'sibling-symmetry': 'scalar',
  'spacing-deficit': 'scalar',
  'terminal-direction': 'cap',
  'tiny-kink': 'scalar',
  'wall-hug': 'scalar',
  'wall-touch': 'cap',
};

export interface RoutingQualityVisitRef {
  readonly routeIndex: number;
  readonly visitIndex: number;
}

export interface RoutingQualityEvent {
  readonly kind: RoutingQualityEventKind;
  readonly cost: number;
  readonly routeIndexes: readonly number[];
  readonly corridorIndexes?: readonly number[];
  readonly visits?: readonly RoutingQualityVisitRef[];
}

export interface TerminalDirectionQualityEvent extends RoutingQualityEvent {
  readonly kind: 'terminal-direction';
  readonly visits: readonly [RoutingQualityVisitRef];
  readonly corridorIndexes: readonly [number];
}

export interface SpacingDeficitQualityEvent extends RoutingQualityEvent {
  readonly kind: 'spacing-deficit';
  readonly corridorIndexes: readonly [number];
  readonly visits: readonly RoutingQualityVisitRef[];
}

/** A realized contention omitted by the provisional spacing model; certification must remove it. */
export interface MissingSpacingContentionQualityEvent extends RoutingQualityEvent {
  readonly kind: 'missing-spacing-contention';
  readonly corridorIndexes: readonly [number];
  readonly visits: readonly [RoutingQualityVisitRef, RoutingQualityVisitRef];
}

export interface LineMergeQualityEvent extends RoutingQualityEvent {
  readonly kind: 'line-merge';
  readonly corridorIndexes: readonly number[];
  readonly visits: readonly RoutingQualityVisitRef[];
}

/**
 * Slot cost of a face's endpoint arrangement: the face sliced into one equal slot per
 * endpoint, each endpoint charged convexly (the port-centering shape) for its distance from
 * its slot center under order-preserving assignment. Subsumes the group distance-from-center
 * concept — with one endpoint it degenerates to the classic singleton centering charge — and
 * prices clustering: a port at face center beside one 8px off is worse than two straddling
 * the center at 4px each.
 */
export interface FaceFanSymmetryQualityEvent extends RoutingQualityEvent {
  readonly kind: 'face-fan-symmetry';
  readonly corridorIndexes: readonly number[];
  readonly visits: readonly RoutingQualityVisitRef[];
}

export interface SiblingSymmetryQualityEvent extends RoutingQualityEvent {
  readonly kind: 'sibling-symmetry';
  readonly corridorIndexes: readonly number[];
  readonly visits: readonly RoutingQualityVisitRef[];
}

export interface NearFaceTurnQualityEvent extends RoutingQualityEvent {
  readonly kind: 'near-face-turn';
  readonly visits: readonly RoutingQualityVisitRef[];
  readonly corridorIndexes: readonly number[];
}

export interface WallTouchQualityEvent extends RoutingQualityEvent {
  readonly kind: 'wall-touch';
  readonly routeIndex: number;
  readonly bendPointIndex: number;
  readonly entityIndex: number;
  readonly face: Direction;
  readonly visits: readonly RoutingQualityVisitRef[];
  readonly corridorIndexes: readonly number[];
}

/** One thin anti-parallel doubling of one route back over its own travel span. */
export interface BacktrackQualityEvent extends RoutingQualityEvent {
  readonly kind: 'backtrack';
  readonly corridorIndexes: readonly number[];
  readonly visits: readonly RoutingQualityVisitRef[];
}

export interface WallHugQualityEvent extends RoutingQualityEvent {
  readonly kind: 'wall-hug';
  readonly corridorIndexes: readonly [number];
  readonly visits: readonly [RoutingQualityVisitRef];
}

export interface RoutingQualityCost {
  readonly invalid: number;
  readonly cap: number;
  readonly scalar: number;
}

export interface RoutingQualityScalarCosts {
  readonly ordinaryBends: number;
  readonly pathLength: number;
  readonly spacingDesire: number;
}

export interface RoutingQualitySourceSnapshot {
  readonly source: string;
  readonly stage: RoutingQualityStage;
  readonly events: readonly RoutingQualityEvent[];
  readonly scalarCosts?: RoutingQualityScalarCosts;
}

export interface RoutingQualitySnapshot {
  readonly sources: readonly RoutingQualitySourceSnapshot[];
  readonly events: readonly RoutingQualityEvent[];
  readonly scalarCosts: RoutingQualityScalarCosts;
  readonly cost: RoutingQualityCost;
}

const ZERO_COST: RoutingQualityCost = { invalid: 0, cap: 0, scalar: 0 };
const SPACING_DESIRE_COST_PER_OBJECTIVE_UNIT = 0.001;

interface RoutingQualitySource {
  readonly stage: RoutingQualityStage;
  readonly events: readonly RoutingQualityEvent[];
  readonly scalarCosts?: RoutingQualityScalarCosts;
}

/** Progressive, attributed costs. Sources let a phase replace provisional facts without duplication. */
export class RoutingQualityLedger {
  private readonly sources = new Map<string, RoutingQualitySource>();

  replaceSource(
    source: string,
    stage: RoutingQualityStage,
    events: readonly RoutingQualityEvent[],
    scalarCosts?: RoutingQualityScalarCosts,
  ): void {
    for (const event of events) {
      assertEvent(event);
    }
    if (events.length === 0 && scalarCostTotal(scalarCosts) === 0) {
      this.sources.delete(source);
      return;
    }
    this.sources.set(source, {
      stage,
      events: [...events],
      ...(scalarCosts ? { scalarCosts: { ...scalarCosts } } : {}),
    });
  }

  removeStage(stage: RoutingQualityStage): void {
    for (const [source, value] of this.sources) {
      if (value.stage === stage) {
        this.sources.delete(source);
      }
    }
  }

  snapshot(): RoutingQualitySnapshot {
    const sources: RoutingQualitySourceSnapshot[] = [];
    const events: RoutingQualityEvent[] = [];
    let ordinaryBends = 0;
    let pathLength = 0;
    let spacingDesire = 0;
    let invalid = 0;
    let cap = 0;
    let scalar = 0;
    for (const [sourceName, source] of this.sources) {
      const sourceEvents: RoutingQualityEvent[] = [];
      for (const event of source.events) {
        events.push(event);
        sourceEvents.push(event);
        const tier = routingQualityTier(event.kind);
        if (tier === 'invalid') {
          invalid += event.cost;
        } else if (tier === 'cap') {
          cap += event.cost;
        } else {
          scalar += event.cost;
        }
      }
      const sourceScalarCosts = source.scalarCosts;
      ordinaryBends += sourceScalarCosts?.ordinaryBends ?? 0;
      pathLength += sourceScalarCosts?.pathLength ?? 0;
      spacingDesire += sourceScalarCosts?.spacingDesire ?? 0;
      if (sourceEvents.length > 0 || scalarCostTotal(sourceScalarCosts) > 0) {
        sources.push({
          source: sourceName,
          stage: source.stage,
          events: sourceEvents,
          ...(sourceScalarCosts ? { scalarCosts: sourceScalarCosts } : {}),
        });
      }
    }
    const scalarCosts = { ordinaryBends, pathLength, spacingDesire };
    scalar += scalarCostTotal(scalarCosts);
    return {
      sources,
      events,
      scalarCosts,
      cost: events.length === 0 && scalar === 0 ? ZERO_COST : { invalid, cap, scalar },
    };
  }
}

export function routingQualityCost(
  events: readonly RoutingQualityEvent[],
  scalarCosts?: RoutingQualityScalarCosts,
): RoutingQualityCost {
  if (events.length === 0 && scalarCostTotal(scalarCosts) === 0) {
    return ZERO_COST;
  }
  let invalid = 0;
  let cap = 0;
  let scalar = scalarCostTotal(scalarCosts);
  for (const event of events) {
    const tier = routingQualityTier(event.kind);
    if (tier === 'invalid') {
      invalid += event.cost;
    } else if (tier === 'cap') {
      cap += event.cost;
    } else {
      scalar += event.cost;
    }
  }
  return { invalid, cap, scalar };
}

export function routingQualityTier(kind: RoutingQualityEventKind): RoutingQualityTier {
  return QUALITY_TIER_BY_KIND[kind];
}

function scalarCostTotal(costs?: RoutingQualityScalarCosts): number {
  return (
    (costs?.ordinaryBends ?? 0) +
    (costs?.pathLength ?? 0) +
    (costs?.spacingDesire ?? 0) * SPACING_DESIRE_COST_PER_OBJECTIVE_UNIT
  );
}

/** Negative means the candidate is better. Invalid and cap costs dominate every scalar saving. */
export function compareRoutingQualityCosts(
  candidate: RoutingQualityCost,
  incumbent: RoutingQualityCost,
): number {
  return (
    candidate.invalid - incumbent.invalid ||
    candidate.cap - incumbent.cap ||
    candidate.scalar - incumbent.scalar
  );
}

/** Count quality events of one kind. */
export function qualityEventCount(events: readonly RoutingQualityEvent[], kind: string): number {
  let count = 0;
  for (const event of events) {
    if (event.kind === kind) {
      count += 1;
    }
  }
  return count;
}

export function spacingDeficitCost(
  requiredGap: number,
  achievedGap: number,
  sharedTravelLength: number,
): number {
  if (requiredGap <= 0 || sharedTravelLength <= 0) {
    return 0;
  }
  const deficitRatio = Math.max(0, (requiredGap - Math.max(0, achievedGap)) / requiredGap);
  return (
    ROUTING_QUALITY_COSTS.spacingDeficitPer24Px *
    (sharedTravelLength / 24) *
    deficitRatio *
    deficitRatio
  );
}

export function wallHugCost(distance: number, overlap: number, clearance: number): number {
  if (distance < 0 || overlap <= 0 || clearance <= 0 || distance >= clearance) {
    return 0;
  }
  const pressure = (clearance - distance) / clearance;
  return ROUTING_QUALITY_COSTS.wallHugPer24Px * (overlap / 24) * pressure * pressure;
}

export function nearFaceTurnCost(penalty: number): number {
  return ROUTING_QUALITY_COSTS.nearFaceTurn * Math.max(0, penalty);
}

/** A doubling shorter than one grid unit is free however tight it is. */
const BACKTRACK_OVERLAP_FLOOR_PX = 24;
/** A loop whose lanes are three grid units apart is a detour, not a doubling. */
const BACKTRACK_FREE_SEPARATION_PX = 72;

/**
 * Scalar price of one anti-parallel doubling: the overlap exceeding both the
 * cross-separation and one grid unit, in 24px units. Wide loops (d >= 72) are
 * free regardless of length.
 *
 * The free-separation threshold keeps structurally necessary wide returns out
 * of the repair objective while charging narrow returns enough to outweigh
 * cosmetic terminal improvements. A fixed three-grid-unit boundary also
 * avoids giving repair a relative threshold that it can park just beneath.
 */
export function backtrackCost(overlap: number, separation: number): number {
  if (separation >= BACKTRACK_FREE_SEPARATION_PX) {
    return 0;
  }
  const chargeable = overlap - Math.max(separation, BACKTRACK_OVERLAP_FLOOR_PX);
  return chargeable <= 0 ? 0 : ROUTING_QUALITY_COSTS.backtrackPer24Px * (chargeable / 24);
}

function assertEvent(event: RoutingQualityEvent): void {
  if (!Number.isFinite(event.cost) || event.cost < 0) {
    throw new Error(`routing quality: ${event.kind} has invalid cost ${event.cost}`);
  }
}
