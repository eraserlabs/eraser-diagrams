import { boundaryTravelCoordinate } from './geometry.js';
import { Route } from './route.js';
import { disjointSweepOrder, walkChirality } from './disjointSweep.js';
import type { CorridorWorld } from './world.js';

const EPSILON = 1e-6;
type OrderDecisionReason = 'disjoint-feasible-tracks' | 'span-containment' | 'request-order';

export interface OrderedVisitRef {
  readonly routeIndex: number;
  readonly visitIndex: number;
  readonly order: number;
}

export interface CorridorOrderGroup {
  readonly corridorIndex: number;
  readonly members: readonly OrderedVisitRef[];
}

export interface OrderingResult {
  readonly groups: readonly CorridorOrderGroup[];
}

interface VisitRef {
  readonly routeIndex: number;
  readonly requestIndex: number;
  readonly visitIndex: number;
}

interface PairDecision {
  readonly order: -1 | 1;
  readonly reason: OrderDecisionReason;
  /** Endpoint-derived (pin-rule) evidence -- real geometry, but the weakest class. */
  readonly weak?: boolean;
}

/** Assign one compact order index to every non-fallback corridor visit. */
export function orderRoutes(world: CorridorWorld, routes: readonly Route[]): OrderingResult {
  for (const route of routes) {
    if (route.hasRealization()) {
      throw new Error(`route ${route.requestIndex}: ordering requires a clear realization`);
    }
  }

  const refsByCorridor = buildVisitRefs(world, routes);
  const straightChains = buildStraightChains(routes);
  /*
   * Chain-pair rooting. A continue-straight chain holds one track through every corridor it
   * spans (spacing merges it into a single variable), so a pair of chains must get ONE relative
   * order -- per-corridor sweeps rooted at their own visits can legitimately disagree, and any
   * disagreement inside a chain pair is unsatisfiable downstream. Root every comparison of a
   * chain pair at the corridor where the two chains FIRST MEET along the first route's travel:
   * consistent across the pair by construction, and local to where the contention begins.
   */
  const pairRootCache = new Map<string, readonly [number, number]>();
  const pairRoot = (refA: VisitRef, refB: VisitRef): readonly [number, number] => {
    const idsA = straightChains.idsByRoute[refA.routeIndex];
    const idsB = straightChains.idsByRoute[refB.routeIndex];
    const chainA = idsA[refA.visitIndex];
    const chainB = idsB[refB.visitIndex];
    const key = `${chainA}:${chainB}`;
    const cached = pairRootCache.get(key);
    if (cached) {
      return cached;
    }
    let root: readonly [number, number] = [refA.visitIndex, refB.visitIndex];
    outer: for (let i = 0; i < routes[refA.routeIndex].visits.length; i += 1) {
      if (idsA[i] !== chainA) {
        continue;
      }
      const corridorIndex = routes[refA.routeIndex].visits[i].corridorIndex;
      for (let j = 0; j < routes[refB.routeIndex].visits.length; j += 1) {
        if (idsB[j] !== chainB) {
          continue;
        }
        if (routes[refB.routeIndex].visits[j].corridorIndex === corridorIndex) {
          root = [i, j];
          break outer;
        }
      }
    }
    pairRootCache.set(key, root);
    return root;
  };
  const orderByRoute = routes.map((route) => new Int32Array(route.visits.length));
  const groups: CorridorOrderGroup[] = [];

  for (let corridorIndex = 0; corridorIndex < refsByCorridor.length; corridorIndex += 1) {
    const refs = refsByCorridor[corridorIndex];
    if (!refs || refs.length === 0) {
      continue;
    }
    refs.sort(compareStableRefs);

    const cellCount = refs.length * refs.length;
    const pairOrders = new Int8Array(cellCount);
    const hardOrders = new Int8Array(cellCount);
    const contendingOrders = new Int8Array(cellCount);
    const travelRuns: [number, number][] = new Array(refs.length);
    const corridor = world.indexer.corridors[corridorIndex];
    for (let refIndex = 0; refIndex < refs.length; refIndex += 1) {
      const ref = refs[refIndex];
      const visit = routes[ref.routeIndex].visits[ref.visitIndex];
      const entry = boundaryTravelCoordinate(world, corridor, visit.entry);
      const exit = boundaryTravelCoordinate(world, corridor, visit.exit);
      travelRuns[refIndex] = [Math.min(entry, exit), Math.max(entry, exit)];
    }
    for (let left = 0; left < refs.length; left += 1) {
      for (let right = left + 1; right < refs.length; right += 1) {
        const [rootLeft, rootRight] = pairRoot(refs[left], refs[right]);
        const decision = compareVisitPair(
          world,
          routes,
          { ...refs[left], visitIndex: rootLeft },
          { ...refs[right], visitIndex: rootRight },
        );
        const forwardCell = left * refs.length + right;
        const reverseCell = right * refs.length + left;
        setPair(pairOrders, forwardCell, reverseCell, decision.order);
        /*
         * A request-order decision between visits that never share travel is fabricated
         * bookkeeping: the rank is total, so some order must exist, but the routes never run
         * side by side here and the order carries no geometric meaning. Such votes must not
         * count as ranking wins. Weak endpoint-derived sweep votes between never-contending
         * visits are the same class: counting their endpoint order as a win could overwhelm
         * the required votes from genuinely contending visits. Contending pairs stay either
         * way because their order is the only fact the pair has.
         */
        const contending =
          Math.min(travelRuns[left][1], travelRuns[right][1]) -
            Math.max(travelRuns[left][0], travelRuns[right][0]) >
          EPSILON;
        if ((decision.reason !== 'request-order' && decision.weak !== true) || contending) {
          setPair(contendingOrders, forwardCell, reverseCell, decision.order);
        }
        // Only disjoint feasible tracks are geometrically inviolable. Every other decision
        // is a preference: it ranks, but the group rank may override it.
        if (decision.reason === 'disjoint-feasible-tracks') {
          setPair(hardOrders, forwardCell, reverseCell, decision.order);
        }
      }
    }

    const ranked = rankGroup(refs, pairOrders, hardOrders, contendingOrders);
    const members = ranked.refIndexes.map((refIndex, order) => {
      const ref = refs[refIndex];
      orderByRoute[ref.routeIndex][ref.visitIndex] = order;
      return {
        routeIndex: ref.routeIndex,
        visitIndex: ref.visitIndex,
        order,
      };
    });
    groups.push({ corridorIndex, members });
  }

  for (let routeIndex = 0; routeIndex < routes.length; routeIndex += 1) {
    const route = routes[routeIndex];
    if (route.visits.length === 0) {
      continue;
    }
    route.beginRealization();
    route.setOrder(orderByRoute[routeIndex]);
  }

  return { groups };
}

/** Write one pair order into both mirrored cells of a square order matrix. */
function setPair(matrix: Int8Array, forwardCell: number, reverseCell: number, order: number): void {
  matrix[forwardCell] = order;
  matrix[reverseCell] = -order;
}

function buildVisitRefs(world: CorridorWorld, routes: readonly Route[]) {
  const refsByCorridor: (VisitRef[] | undefined)[] = new Array(world.indexer.corridors.length);
  for (let routeIndex = 0; routeIndex < routes.length; routeIndex += 1) {
    const route = routes[routeIndex];
    for (let visitIndex = 0; visitIndex < route.visits.length; visitIndex += 1) {
      const visit = route.visits[visitIndex];
      if (!world.indexer.corridors[visit.corridorIndex]) {
        throw new Error(`route ${route.requestIndex}: visit ${visitIndex} corridor missing`);
      }
      const ref = { routeIndex, requestIndex: route.requestIndex, visitIndex };
      const bucket = refsByCorridor[visit.corridorIndex] ?? [];
      bucket.push(ref);
      refsByCorridor[visit.corridorIndex] = bucket;
    }
  }
  return refsByCorridor;
}

function buildStraightChains(routes: readonly Route[]) {
  let nextChainId = 0;
  const idsByRoute = routes.map((route) => {
    const ids = new Int32Array(route.visits.length);
    for (let visitIndex = 0; visitIndex < route.visits.length; visitIndex += 1) {
      const entry = route.visits[visitIndex].entry;
      if (visitIndex > 0 && entry.kind === 'portal' && entry.mode === 'continue-straight') {
        ids[visitIndex] = ids[visitIndex - 1];
      } else {
        ids[visitIndex] = nextChainId;
        nextChainId += 1;
      }
    }
    return ids;
  });
  return { idsByRoute };
}

function compareVisitPair(
  world: CorridorWorld,
  routes: readonly Route[],
  refA: VisitRef,
  refB: VisitRef,
): PairDecision {
  const routeA = routes[refA.routeIndex];
  const routeB = routes[refB.routeIndex];
  const sweep = disjointSweepOrder(world, routeA, refA.visitIndex, routeB, refB.visitIndex);
  const strong = sweep.order !== 0 && !sweep.weak && sweep.reason !== 'span';
  if (strong) {
    return {
      order: sweep.order,
      // Only STRICT separation is inviolable. Bands that merely touch are a strong preference:
      // spacing may still need to merge a continuation chain across that boundary.
      reason: sweep.reason === 'disjoint' ? 'disjoint-feasible-tracks' : 'span-containment',
    };
  }
  /*
   * Turn linkage. When this corridor's own evidence is endpoint-derived (pin rules), span, or
   * nothing, the pair may still be strongly separated in another corridor it shares -- and a
   * strong relation there maps onto this corridor's track order through the accumulated turn
   * chirality, the same factor as the sweep's frame sign. Recomputed per pair from geometry,
   * never memoized: a first-writer-wins cache would let an unrelated corridor's processing
   * order pick which relation propagates.
   */
  if (refA.routeIndex !== refB.routeIndex) {
    const linked = linkedTurnOrder(world, routeA, refA.visitIndex, routeB, refB.visitIndex);
    if (linked !== 0) {
      return { order: linked, reason: 'span-containment' };
    }
    if (sweep.order !== 0) {
      return { order: sweep.order, reason: 'span-containment', weak: sweep.weak === true };
    }
    /*
     * Perfect twins tie everywhere, so the request tiebreak must be applied ONCE -- at the
     * corridor where the routes first meet -- and carried through the turns by chirality.
     * Applying it per corridor provably picks the crossing arrangement for anti-parallel
     * twins: the same "A first" at both horizontal ends forces A's vertical to cross B's.
     */
    const rootVisitA = routeA.visits.findIndex((visit) =>
      routeB.visits.some((other) => other.corridorIndex === visit.corridorIndex),
    );
    if (rootVisitA >= 0) {
      const factor = walkChirality(world, routeA, rootVisitA, refA.visitIndex);
      return { order: signed(stablePairOrder(refA, refB) * factor), reason: 'request-order' };
    }
  } else if (sweep.order !== 0) {
    return { order: sweep.order, reason: 'span-containment', weak: sweep.weak === true };
  }
  return { order: stablePairOrder(refA, refB), reason: 'request-order' };
}

/**
 * The pair's strong relation in the nearest other shared corridor, mapped through the turn
 * chirality between there and `visitA`'s corridor. A's visits are scanned outward from the
 * rooted visit; B's correspondent in a corridor is the visit whose travel run strictly
 * overlaps A's run there -- boundary touches are excluded, so an anti-parallel twin's
 * far-end band (which merely abuts) cannot masquerade as the correspondent.
 */
function linkedTurnOrder(
  world: CorridorWorld,
  routeA: Route,
  visitA: number,
  routeB: Route,
  visitB: number,
): -1 | 1 | 0 {
  const runOf = (route: Route, visitIndex: number): readonly [number, number] => {
    const visit = route.visits[visitIndex];
    const corridor = world.indexer.corridors[visit.corridorIndex];
    const entry = boundaryTravelCoordinate(world, corridor, visit.entry);
    const exit = boundaryTravelCoordinate(world, corridor, visit.exit);
    return [Math.min(entry, exit), Math.max(entry, exit)];
  };
  for (let distance = 0; distance < routeA.visits.length; distance += 1) {
    const candidates = distance === 0 ? [visitA] : [visitA - distance, visitA + distance];
    for (const index of candidates) {
      if (index < 0 || index >= routeA.visits.length) {
        continue;
      }
      const corridorIndex = routeA.visits[index].corridorIndex;
      const [aLow, aHigh] = runOf(routeA, index);
      let mappedOrder: -1 | 1 | 0 = 0;
      let contradictory = false;
      for (let other = 0; other < routeB.visits.length; other += 1) {
        if (index === visitA && other === visitB) {
          continue;
        }
        if (routeB.visits[other].corridorIndex !== corridorIndex) {
          continue;
        }
        const [bLow, bHigh] = runOf(routeB, other);
        if (Math.min(aHigh, bHigh) - Math.max(aLow, bLow) <= EPSILON) {
          continue;
        }
        const neighbor = disjointSweepOrder(world, routeA, index, routeB, other);
        if (neighbor.order === 0 || neighbor.weak || neighbor.reason === 'span') {
          continue;
        }
        const mapped = signed(neighbor.order * walkChirality(world, routeA, visitA, index));
        if (mappedOrder === 0) {
          mappedOrder = mapped;
        } else if (mappedOrder !== mapped) {
          contradictory = true;
        }
      }
      if (mappedOrder !== 0 && !contradictory) {
        return mappedOrder;
      }
    }
  }
  return 0;
}

function rankGroup(
  refs: readonly VisitRef[],
  pairOrders: Int8Array,
  hardOrders: Int8Array,
  contendingOrders: Int8Array,
) {
  const indegree = new Int32Array(refs.length);
  for (let left = 0; left < refs.length; left += 1) {
    for (let right = left + 1; right < refs.length; right += 1) {
      const order = hardOrders[left * refs.length + right];
      if (order === 0) {
        continue;
      }
      const before = order < 0 ? left : right;
      const after = before === left ? right : left;
      indegree[after] += 1;
    }
  }

  const remaining = new Uint8Array(refs.length);
  remaining.fill(1);
  const refIndexes: number[] = [];
  while (refIndexes.length < refs.length) {
    let selected = -1;
    let selectedWins = -1;
    let selectedTiebreakWins = -1;
    for (let index = 0; index < refs.length; index += 1) {
      if (remaining[index] !== 1 || indegree[index] !== 0) {
        continue;
      }
      // Contending victories select; fabricated orders between never-contending visits only
      // split ties -- they exist for rank totality and carry no information about tracks.
      let wins = 0;
      let tiebreakWins = 0;
      for (let other = 0; other < refs.length; other += 1) {
        if (remaining[other] !== 1 || other === index) {
          continue;
        }
        if (contendingOrders[index * refs.length + other] < 0) {
          wins += 1;
        }
        if (pairOrders[index * refs.length + other] < 0) {
          tiebreakWins += 1;
        }
      }
      if (
        wins > selectedWins ||
        (wins === selectedWins &&
          (tiebreakWins > selectedTiebreakWins ||
            (tiebreakWins === selectedTiebreakWins &&
              (selected === -1 || compareStableRefs(refs[index], refs[selected]) < 0))))
      ) {
        selected = index;
        selectedWins = wins;
        selectedTiebreakWins = tiebreakWins;
      }
    }
    if (selected === -1) {
      for (let index = 0; index < refs.length; index += 1) {
        if (
          remaining[index] === 1 &&
          (selected === -1 || compareStableRefs(refs[index], refs[selected]) < 0)
        ) {
          selected = index;
        }
      }
    }
    remaining[selected] = 0;
    refIndexes.push(selected);
    for (let after = 0; after < refs.length; after += 1) {
      if (hardOrders[selected * refs.length + after] < 0) {
        indegree[after] -= 1;
      }
    }
  }
  return { refIndexes };
}

function stablePairOrder(left: VisitRef, right: VisitRef): -1 | 1 {
  return compareStableRefs(left, right) <= 0 ? -1 : 1;
}

function compareStableRefs(left: VisitRef, right: VisitRef): number {
  return (
    left.requestIndex - right.requestIndex ||
    left.routeIndex - right.routeIndex ||
    left.visitIndex - right.visitIndex
  );
}

function signed(value: number): -1 | 1 {
  return value <= 0 ? -1 : 1;
}
