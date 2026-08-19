/**
 * Travel-aligned disjointness sweep — the candidate replacement for the divergence walk.
 *
 * The old walk advanced both routes one visit at a time, which assumes they are partitioned
 * into the same number of corridors between the shared corridor and the point they part. They
 * are not: corridors are cut at geometry boundaries, so two routes running side by side get
 * chopped differently and the lockstep comparison drifts onto unrelated visits.
 *
 * Instead, sweep a scan line along the shared corridor's TRAVEL axis, outward from the shared
 * corridor, and ask at each position: where can each route be on the CROSS axis? The first
 * position where those two bands are strictly disjoint tells us which route rides the higher
 * track, and that is the only geometric fact ordering actually needs.
 *
 * A visit parallel to the shared corridor contributes its `feasibleTrack` over its travel run.
 * A visit perpendicular to it sits at a single travel coordinate and sweeps a range of cross
 * coordinates, so it contributes that range at that instant — which is exactly what "this route
 * departs to a region entirely above/below you" means.
 */
import type { Route } from './route.js';
import type { CorridorWorld } from './world.js';
import { boundaryTravelCoordinate, endpointPoint } from './geometry.js';

const EPSILON = 1e-6;

/** Where a route may sit on the cross axis, over one span of the travel axis. */
interface Occupancy {
  readonly travelStart: number;
  readonly travelEnd: number;
  readonly crossLow: number;
  readonly crossHigh: number;
  /**
   * Frame sign accumulated over the turns between the shared visit and this one. A separation
   * seen here is only meaningful in the shared corridor's frame after multiplying by this sign:
   * each turn maps "ascending tracks" to "ascending tracks" or inverts it, by the chirality of
   * the turn. Preserved when walkDir x turnDir = -1, inverted when +1, so per axis change the
   * sign multiplies by -(dirBefore x dirAfter).
   */
  readonly sign: 1 | -1;
  /** Terminal pin: the route's endpoint, not a corridor occupancy. */
  readonly pin?: boolean;
  /** Perpendicular occupancy immediately adjacent to the shared visit. */
  readonly adjacentPerp?: boolean;
  /**
   * Parallel band of the rooted chain: the shared visit itself and every parallel visit before
   * the walk first turns. These are feasible windows in the shared corridor's own frame (sign is
   * +1 by construction), so ANY occupancy strictly beside one sits on that side physically --
   * the other route's body is literally above or below the whole window, no sign mapping needed.
   */
  readonly sharedChain?: boolean;
}

export interface SweepResult {
  readonly order: -1 | 1 | 0;
  /** 'disjoint' when a strictly separated band decided it; 'span' for the soft fallback. */
  readonly reason: 'disjoint' | 'touching' | 'peel' | 'span' | 'tied';
  readonly side?: 'forward' | 'backward';
  /** Travel coordinate at which the bands first separated. */
  readonly at?: number;
  /**
   * Endpoint-derived, not band-derived: the pin rules infer order from where the routes END,
   * which is the weakest evidence class. A caller holding a weak result may prefer the pair's
   * strong relation in another corridor mapped through the turns (turn linkage).
   */
  readonly weak?: boolean;
}

/**
 * Project a route's visits onto the shared corridor's axes, ordered outward from `fromVisit`.
 * `step` is +1 to sweep toward later visits, -1 toward earlier ones.
 */
function occupancies(
  world: CorridorWorld,
  route: Route,
  fromVisit: number,
  step: 1 | -1,
  sharedAxis: 'x' | 'y',
): Occupancy[] {
  const out: Occupancy[] = [];
  let sign: 1 | -1 = 1;
  let prevAxis: 'x' | 'y' | undefined;
  let prevDir = 0;
  for (let index = fromVisit; index >= 0 && index < route.visits.length; index += step) {
    const visit = route.visits[index];
    // An excursion leg -- a visit whose flanking visits are the same corridor -- says nothing
    // about the route's track: the route leaves and comes straight back. Including it as a
    // decision surface would let a temporary poke read as a lasting relative position. Its
    // two turns cancel in the sign algebra, so skipping the leg drops no frame information.
    const before = route.visits[index - step];
    const after = route.visits[index + step];
    if (index !== fromVisit && before && after && before.corridorIndex === after.corridorIndex) {
      continue;
    }
    const corridor = world.indexer.corridors[visit.corridorIndex];
    const entry = boundaryTravelCoordinate(world, corridor, visit.entry);
    const exit = boundaryTravelCoordinate(world, corridor, visit.exit);
    const runLow = Math.min(entry, exit);
    const runHigh = Math.max(entry, exit);
    // Direction this WALK moves through the corridor (route direction, flipped when stepping
    // backward). Chirality needs it on both sides of every turn.
    const rawDir = routeTravelDirection(world, route, index);
    const dir = step === 1 ? rawDir : -rawDir;
    if (prevAxis !== undefined && corridor.axis !== prevAxis && prevDir !== 0 && dir !== 0) {
      sign = (sign * -(prevDir * dir)) as 1 | -1;
    }
    prevAxis = corridor.axis;
    if (dir !== 0) {
      prevDir = dir;
    }
    if (corridor.axis === sharedAxis) {
      // Parallel: runs along the travel axis, constrained on the cross axis.
      out.push({
        travelStart: runLow,
        travelEnd: runHigh,
        crossLow: visit.feasibleTrack[0],
        crossHigh: visit.feasibleTrack[1],
        sign,
        sharedChain: out.every((occupancy) => occupancy.sharedChain),
      });
      continue;
    }
    /*
     * Perpendicular: sits at one travel coordinate and sweeps a cross range. The coordinate is
     * the visit's own chain-pinned window midpoint -- its feasible track lives on the shared
     * frame's TRAVEL axis precisely because the corridor is perpendicular. A large corridor's
     * rectangle center may be far from the route's constrained window and would manufacture
     * co-locations or separations far from the route's body.
     */
    const perpWindow = chainFeasibleBand(world, route, index);
    const at = (perpWindow[0] + perpWindow[1]) / 2;
    out.push({
      travelStart: at,
      travelEnd: at,
      crossLow: runLow,
      crossHigh: runHigh,
      sign,
      adjacentPerp: out.length === 1,
    });
  }
  // The route ends here. Pin its terminal port at its true position: cross for band comparisons,
  // travel for the turn-order rule when the cross coordinates tie.
  const terminal = step === 1 ? route.to : route.from;
  const point = endpointPoint(world.entities, terminal);
  const cross = sharedAxis === 'x' ? point.y : point.x;
  const travel = sharedAxis === 'x' ? point.x : point.y;
  out.push({
    travelStart: travel,
    travelEnd: travel,
    crossLow: cross,
    crossHigh: cross,
    sign,
    pin: true,
  });
  return out;
}

/**
 * A route departing perpendicular out of the shared corridor, past a route still riding it,
 * must sit on the side it exits toward: its crossing ray starts at its own track, so any
 * continuer ordered on the exit side of the departer would be cut by it. The signal is the exit
 * ray leaving the continuer's band on exactly one side. Only the perp adjacent to the shared
 * visit speaks about shared tracks directly, and only in the unturned frame.
 */
function departureOrder(
  a: Occupancy,
  b: Occupancy,
  aList: readonly Occupancy[],
  bList: readonly Occupancy[],
): -1 | 1 | 0 {
  const raySide = (perp: Occupancy, band: Occupancy): -1 | 1 | 0 => {
    const exitsHigh = perp.crossHigh > band.crossHigh + EPSILON;
    const exitsLow = perp.crossLow < band.crossLow - EPSILON;
    if (exitsHigh === exitsLow) {
      return 0;
    }
    return exitsHigh ? 1 : -1;
  };
  const oneSided = (
    perp: Occupancy,
    band: Occupancy,
    bandList: readonly Occupancy[],
    perpList: readonly Occupancy[],
  ): -1 | 1 | 0 => {
    if (!perp.adjacentPerp || perp.sign !== 1 || band.sign !== 1 || band.pin || band.adjacentPerp) {
      return 0;
    }
    const side = raySide(perp, band);
    if (side === 0) {
      return 0;
    }
    /*
     * Same companion doctrine as the far-vs-window veto, but only for SIMULTANEOUS exits.
     * A ray meeting the other route's still-live band normally means the ray's owner peels
     * first, and the departer takes its exit side. But when the band-owner departs through
     * its own adjacent ray at the same travel coordinate toward the same side, neither
     * peels first: the pairing is a tiebreak artifact and the mutual threat orders nothing.
     */
    const mirrorRay = bandList.find((occupancy) => occupancy.adjacentPerp);
    const window = perpList[0];
    if (
      mirrorRay &&
      mirrorRay.sign === 1 &&
      window &&
      Math.abs(mirrorRay.travelStart - perp.travelStart) <= EPSILON &&
      raySide(mirrorRay, window) === side
    ) {
      return 0;
    }
    return side;
  };
  const aSide = oneSided(a, b, bList, aList);
  if (aSide !== 0) {
    return aSide;
  }
  return -oneSided(b, a, aList, bList) as -1 | 1 | 0;
}

/**
 * Bands that merely touch are separated, not overlapping: an interval ending at 455 and one
 * starting at 455 share a single coordinate, and two lines cannot merge onto it. Identical bands
 * are the one case that stays undecided.
 */
function disjointOrder(left: Occupancy, right: Occupancy): { order: -1 | 1 | 0; strict: boolean } {
  if (
    Math.abs(left.crossLow - right.crossLow) <= EPSILON &&
    Math.abs(left.crossHigh - right.crossHigh) <= EPSILON
  ) {
    return { order: 0, strict: false };
  }
  if (left.crossHigh <= right.crossLow + EPSILON) {
    return { order: -1, strict: left.crossHigh < right.crossLow - EPSILON };
  }
  if (right.crossHigh <= left.crossLow + EPSILON) {
    return { order: 1, strict: right.crossHigh < left.crossLow - EPSILON };
  }
  return { order: 0, strict: false };
}

/**
 * Soft fallback for bands that never separate: when one route's allowed span strictly contains
 * the other's, the narrower route is the constrained one, so order by which side of the wider
 * band its centre falls.
 */
function spanOrder(left: Occupancy, right: Occupancy): -1 | 1 | 0 {
  const leftInRight =
    left.crossLow >= right.crossLow - EPSILON && left.crossHigh <= right.crossHigh + EPSILON;
  const rightInLeft =
    right.crossLow >= left.crossLow - EPSILON && right.crossHigh <= left.crossHigh + EPSILON;
  if (!leftInRight && !rightInLeft) {
    return 0;
  }
  const leftCentre = (left.crossLow + left.crossHigh) / 2;
  const rightCentre = (right.crossLow + right.crossHigh) / 2;
  if (Math.abs(leftCentre - rightCentre) <= EPSILON) {
    return 0;
  }
  return leftCentre < rightCentre ? -1 : 1;
}

/**
 * True when some far (non-chain, non-pin) occupancy of `list` sits on `side` of a co-located
 * shared-chain window in `windows`. Used to veto companion pairs: when BOTH routes' bodies
 * leave to the same side of each other's windows, "you are beside my window" holds
 * symmetrically and orders nothing -- the pair separates by peel or pins instead.
 */
function hasFarOnSide(
  list: readonly Occupancy[],
  windows: readonly Occupancy[],
  side: -1 | 1,
): boolean {
  return list.some(
    (far) =>
      !far.sharedChain &&
      !far.pin &&
      windows.some(
        (window) =>
          far.travelStart <= window.travelEnd + EPSILON &&
          window.travelStart <= far.travelEnd + EPSILON &&
          disjointOrder(far, window).order === side,
      ),
  );
}

/** Sweep one direction, returning the first strictly-disjoint separation found. */
function sweepDirection(
  world: CorridorWorld,
  routeA: Route,
  visitA: number,
  routeB: Route,
  visitB: number,
  step: 1 | -1,
  stepB: 1 | -1,
  sharedAxis: 'x' | 'y',
  sharedDir: 1 | -1,
): SweepResult | undefined {
  const left = occupancies(world, routeA, visitA, step, sharedAxis);
  const right = occupancies(world, routeB, visitB, stepB, sharedAxis);
  let indexLeft = 0;
  let indexRight = 0;
  let softest: SweepResult | undefined;
  while (indexLeft < left.length && indexRight < right.length) {
    const a = left[indexLeft];
    const b = right[indexRight];
    // Bands constrain each other only where both routes are actually present: their travel
    // ranges must overlap (inclusive -- a turn at the boundary still contends). Comparing
    // occupancies from different travel positions produced degenerate answers, e.g. a terminal
    // pin against a far-away final approach that happens to end at the pin's coordinate.
    const coLocated =
      a.travelStart <= b.travelEnd + EPSILON &&
      b.travelStart <= a.travelEnd + EPSILON &&
      // A pin only compares with a pin. A port abutting the corridor's band edge says nothing
      // about order because both routes may end at ports on that edge; the pin rules below
      // handle a pin pair with actual endpoint information.
      a.pin === b.pin;
    const separation = coLocated ? disjointOrder(a, b) : { order: 0 as const, strict: false };
    /*
     * A shared-chain band is a literal feasible window in the shared frame, so a separation
     * against it reads sign-free: whatever side the other occupancy sits on, that route's body
     * is physically on that side of the window and its connector must land there. Far-vs-far
     * separations have both tracks elsewhere and only speak after mapping through the turns,
     * so they stay gated on matching signs and multiply the accumulated sign back in.
     */
    const literalSeparation = a.sharedChain || b.sharedChain;
    /*
     * A far-vs-window separation is one route's body sitting beside the other's feasible
     * window. That inference is only sound one-sided: if the window-owner's own body also
     * leaves to that same side of the far-owner's windows, both routes are companions on that
     * side and the claim cancels -- suppress it and let peel or the pins order the pair.
     */
    const companionVeto =
      separation.order !== 0 &&
      literalSeparation &&
      a.sharedChain !== b.sharedChain &&
      hasFarOnSide(
        a.sharedChain ? left : right,
        a.sharedChain ? right.filter((o) => o.sharedChain) : left.filter((o) => o.sharedChain),
        (a.sharedChain ? -separation.order : separation.order) as -1 | 1,
      );
    if (separation.order !== 0 && !companionVeto && (literalSeparation || a.sign === b.sign)) {
      /*
       * Only the shared visit's own bands are physically inviolable -- they are the corridor's
       * actual feasible windows. Every later separation is an inference mapped back through
       * turns; correct as a preference, but emitting it hard can contradict the real bands and
       * hand spacing an unsatisfiable rank.
       */
      const inviolable = indexLeft === 0 && indexRight === 0 && separation.strict;
      const result: SweepResult = {
        order: (separation.order * (literalSeparation ? 1 : a.sign)) as -1 | 1,
        reason: inviolable ? 'disjoint' : 'touching',
        side: step === 1 ? 'forward' : 'backward',
        at:
          step === 1 ? Math.max(a.travelStart, b.travelStart) : Math.min(a.travelEnd, b.travelEnd),
      };
      // Nearest separation wins, but a departure ray outranks a mere abutment at the same
      // frontier: the ray is a physical crossing threat, the abutment is often a shared edge.
      if (!separation.strict) {
        const departure = coLocated ? departureOrder(a, b, left, right) : 0;
        if (departure !== 0) {
          return {
            order: departure,
            reason: 'peel',
            side: step === 1 ? 'forward' : 'backward',
          };
        }
      }
      return result;
    }
    if (coLocated && a.sign === b.sign) {
      const departure = departureOrder(a, b, left, right);
      if (departure !== 0) {
        return {
          order: departure,
          reason: 'peel',
          side: step === 1 ? 'forward' : 'backward',
        };
      }
    }
    if (!softest && coLocated && a.sign === b.sign) {
      const soft = spanOrder(a, b);
      if (soft !== 0) {
        softest = {
          order: (soft * a.sign) as -1 | 1,
          reason: 'span',
          side: step === 1 ? 'forward' : 'backward',
        };
      }
    }
    if (
      a.pin &&
      b.pin &&
      a.sign === b.sign &&
      Math.abs(a.crossLow - b.crossLow) <= EPSILON &&
      Math.abs(a.travelStart - b.travelStart) > EPSILON
    ) {
      /*
       * Both routes end at the same cross coordinate -- a fan into one column of targets. The
       * routes separate along TRAVEL instead, and each turn between here and the endpoints maps
       * travel order to cross order with the accumulated sign: the route ending earlier along
       * the walk peeled off earlier, and belongs nearest the side the turns carried it to.
       */
      const earlierFirst: -1 | 1 = (
        sharedDir === 1 ? a.travelStart < b.travelStart : a.travelStart > b.travelStart
      )
        ? -1
        : 1;
      // earlierFirst already consumed the travel direction; the accumulated sign's first
      // transition folds it in again. Multiply it back out: the factor is sign x sharedDir.
      return {
        order: (earlierFirst * a.sign * sharedDir) as -1 | 1,
        reason: 'peel',
        side: step === 1 ? 'forward' : 'backward',
        weak: true,
      };
    }
    /*
     * Advance whichever occupancy the walk leaves first. The walk's travel direction is
     * sharedDir -- NOT the step sign: stepping backward through a corridor traversed
     * right-to-left RETRACES toward increasing coordinates. Measuring ends in the step frame
     * retired azure-app avail's band [95..235] at 95 while the other route's decisive
     * occupancies at 165..400 sat inside it, so the comparison never ran.
     */
    const walkEnd = (o: Occupancy) => (sharedDir === 1 ? o.travelEnd : -o.travelStart);
    const aEnd = walkEnd(a);
    const bEnd = walkEnd(b);
    if (Math.abs(aEnd - bEnd) <= EPSILON) {
      /*
       * A genuine end tie retires the shorter occupancy first: a point that ends where a run
       * ends is spent, while the run still extends and its remaining span is what the other
       * walk's successors land inside. Successor begins are no tiebreak -- routes
       * zigzag, so a successor can begin behind the walk and the metric turns to noise.
       * Equal extents (lockstep twins) advance together, as does double exhaustion.
       */
      const aExtent = a.travelEnd - a.travelStart;
      const bExtent = b.travelEnd - b.travelStart;
      if (aExtent <= bExtent + EPSILON) {
        indexLeft += 1;
      }
      if (bExtent <= aExtent + EPSILON) {
        indexRight += 1;
      }
    } else if (aEnd < bEnd) {
      indexLeft += 1;
    } else {
      indexRight += 1;
    }
  }
  /*
   * The frontier merge ends when either list exhausts, so with staggered path lengths the two
   * terminal pins are never frontier-paired -- one route is still mid-corridor when the other's
   * pin arrives. Endpoints are points, not bands, so compare them directly: cross separation
   * decides with the frame sign; equal cross falls back to travel order with the sign, which is
   * the turn-order rule.
   */
  const pinA = left[left.length - 1];
  const pinB = right[right.length - 1];
  if (pinA.pin && pinB.pin && pinA.sign === pinB.sign) {
    const crossDelta = pinA.crossLow - pinB.crossLow;
    if (Math.abs(crossDelta) > EPSILON) {
      return {
        order: ((crossDelta < 0 ? -1 : 1) * pinA.sign) as -1 | 1,
        reason: 'touching',
        side: step === 1 ? 'forward' : 'backward',
        weak: true,
      };
    }
    if (Math.abs(pinA.travelStart - pinB.travelStart) > EPSILON) {
      const earlierFirst: -1 | 1 = (
        sharedDir === 1 ? pinA.travelStart < pinB.travelStart : pinA.travelStart > pinB.travelStart
      )
        ? -1
        : 1;
      // Same double-count correction as the in-loop site: sign x sharedDir.
      return {
        order: (earlierFirst * pinA.sign * sharedDir) as -1 | 1,
        reason: 'peel',
        side: step === 1 ? 'forward' : 'backward',
        weak: true,
      };
    }
  }
  return softest;
}

/** True when `visitIndex` continues the previous visit's straight chain (one spacing variable). */
function continuesStraight(route: Route, visitIndex: number): boolean {
  const entry = route.visits[visitIndex]?.entry;
  return entry !== undefined && entry.kind === 'portal' && entry.mode === 'continue-straight';
}

/** True when the straight chain through `index` starts at the route's first visit. */
function chainReachesStart(route: Route, index: number): boolean {
  let cursor = index;
  while (cursor > 0 && continuesStraight(route, cursor)) {
    cursor -= 1;
  }
  return cursor === 0;
}

/** True when the straight chain through `index` ends at the route's last visit. */
function chainReachesEnd(route: Route, index: number): boolean {
  let cursor = index;
  while (cursor < route.visits.length - 1 && continuesStraight(route, cursor + 1)) {
    cursor += 1;
  }
  return cursor === route.visits.length - 1;
}

/**
 * Travel direction of the route through visit `index`, in the visit's own corridor's frame.
 * Portal coordinates degenerate when both flanking visits sit in the same corridor (a pocket
 * hosting approach and departure collapses both portals to one coordinate) -- recover from the
 * flanking chains' windows, which lie on this corridor's travel axis precisely because the
 * neighbours are perpendicular. When those windows are symmetric too, fall back to the
 * route's pinned endpoints: a terminal-anchored chain must attach at the committed port.
 */
function routeTravelDirection(world: CorridorWorld, route: Route, index: number): -1 | 0 | 1 {
  const visit = route.visits[index];
  const corridor = world.indexer.corridors[visit.corridorIndex];
  const entry = boundaryTravelCoordinate(world, corridor, visit.entry);
  const exit = boundaryTravelCoordinate(world, corridor, visit.exit);
  if (Math.abs(exit - entry) > EPSILON) {
    return exit > entry ? 1 : -1;
  }
  if (index <= 0 || index >= route.visits.length - 1) {
    return 0;
  }
  const chainBefore = chainFeasibleBand(world, route, index - 1);
  const chainAfter = chainFeasibleBand(world, route, index + 1);
  let before = (chainBefore[0] + chainBefore[1]) / 2;
  let after = (chainAfter[0] + chainAfter[1]) / 2;
  if (Math.abs(after - before) <= EPSILON) {
    const travelOf = (point: { x: number; y: number }): number =>
      corridor.axis === 'x' ? point.x : point.y;
    if (chainReachesStart(route, index - 1)) {
      before = travelOf(endpointPoint(world.entities, route.from));
    }
    if (chainReachesEnd(route, index + 1)) {
      after = travelOf(endpointPoint(world.entities, route.to));
    }
  }
  return after > before + EPSILON ? 1 : after < before - EPSILON ? -1 : 0;
}

/**
 * Intersected feasible window of the continue-straight chain through `visitIndex`. The chain
 * holds ONE track through every corridor it spans (spacing merges it into a single variable),
 * so its allowed window is the intersection of its visits' bands. A narrow corridor anywhere
 * along the chain pinches the whole chain, revealing separations that no single-corridor band
 * comparison can.
 */
export function chainFeasibleBand(
  world: CorridorWorld,
  route: Route,
  visitIndex: number,
): readonly [number, number] {
  // A chain lives on ONE axis: a continue-straight entry across an axis change (degenerate
  // poke corridors) would intersect bands from perpendicular frames, which is meaningless.
  const axis = world.indexer.corridors[route.visits[visitIndex].corridorIndex].axis;
  const sameAxis = (index: number): boolean =>
    world.indexer.corridors[route.visits[index].corridorIndex].axis === axis;
  let low = route.visits[visitIndex].feasibleTrack[0];
  let high = route.visits[visitIndex].feasibleTrack[1];
  for (
    let index = visitIndex;
    index > 0 && continuesStraight(route, index) && sameAxis(index - 1);
    index -= 1
  ) {
    low = Math.max(low, route.visits[index - 1].feasibleTrack[0]);
    high = Math.min(high, route.visits[index - 1].feasibleTrack[1]);
  }
  for (
    let index = visitIndex + 1;
    index < route.visits.length && continuesStraight(route, index) && sameAxis(index);
    index += 1
  ) {
    low = Math.max(low, route.visits[index].feasibleTrack[0]);
    high = Math.min(high, route.visits[index].feasibleTrack[1]);
  }
  return [low, high];
}

/**
 * Accumulated turn chirality along `route` from `fromVisit` to `toVisit`: the product of
 * -(dirBefore x dirAfter) over every axis change between them -- the factor that maps "A
 * precedes B" in one corridor's track order to the other's. Symmetric in direction: walking
 * the segment backward flips both directions at every turn, leaving the product unchanged.
 */
export function walkChirality(
  world: CorridorWorld,
  route: Route,
  fromVisit: number,
  toVisit: number,
): 1 | -1 {
  const step: 1 | -1 = toVisit >= fromVisit ? 1 : -1;
  let sign: 1 | -1 = 1;
  let prevAxis: 'x' | 'y' | undefined;
  let prevDir = 0;
  for (let index = fromVisit; step === 1 ? index <= toVisit : index >= toVisit; index += step) {
    const visit = route.visits[index];
    const corridor = world.indexer.corridors[visit.corridorIndex];
    const rawDir = routeTravelDirection(world, route, index);
    const dir = step === 1 ? rawDir : -rawDir;
    if (prevAxis !== undefined && corridor.axis !== prevAxis && prevDir !== 0 && dir !== 0) {
      sign = (sign * -(prevDir * dir)) as 1 | -1;
    }
    prevAxis = corridor.axis;
    if (dir !== 0) {
      prevDir = dir;
    }
  }
  return sign;
}

/**
 * Order two visits of a shared corridor by the first travel position at which their reachable
 * cross bands are strictly disjoint. Forward is tried first, then backward.
 */
export function disjointSweepOrder(
  world: CorridorWorld,
  routeA: Route,
  visitA: number,
  routeB: Route,
  visitB: number,
): SweepResult {
  const shared = world.indexer.corridors[routeA.visits[visitA].corridorIndex];
  const sharedAxis = shared.axis;
  /*
   * Visits that never share travel cannot compete for a track, so it is tempting to emit no
   * order for them. That is a trap: a corridor's rank is a TOTAL order, so withholding a
   * constraint does not leave the pair unordered -- it hands them to the stable tiebreak, which
   * is request index and knows nothing about geometry. We therefore always emit the best answer
   * the sweep found, contending or not.
   */
  /*
   * Establish a shared frame before sweeping. Routes are authored in whichever direction the
   * user drew them, so stepping +1 through one route's visits can mean "toward the shared
   * corridor" for one and "away from it" for the other. Comparing an outbound path against an
   * inbound one comes out as a constant, not a comparison. Align on the direction each route
   * actually travels through the shared corridor, and flip B's step when they oppose.
   */
  const travelSignAt = (route: Route, visitIndex: number): 1 | -1 =>
    routeTravelDirection(world, route, visitIndex) >= 0 ? 1 : -1;
  const orientationB: 1 | -1 =
    travelSignAt(routeA, visitA) === travelSignAt(routeB, visitB) ? 1 : -1;
  const sharedDir: 1 | -1 = routeTravelDirection(world, routeA, visitA) >= 0 ? 1 : -1;
  /*
   * Chain windows first: a continue-straight chain holds one track everywhere it runs, so two
   * chains with strictly separated windows are ordered by construction -- the only truly
   * inviolable fact beyond the root bands themselves (which the chain window contains).
   * Abutting chain windows are strong evidence too, but the walks may know better, so they
   * only decide after the walks' band evidence has had its chance.
   */
  const chainA = chainFeasibleBand(world, routeA, visitA);
  const chainB = chainFeasibleBand(world, routeB, visitB);
  const chainSeparation =
    chainA[0] <= chainA[1] + EPSILON && chainB[0] <= chainB[1] + EPSILON
      ? disjointOrder(
          { travelStart: 0, travelEnd: 0, crossLow: chainA[0], crossHigh: chainA[1], sign: 1 },
          { travelStart: 0, travelEnd: 0, crossLow: chainB[0], crossHigh: chainB[1], sign: 1 },
        )
      : { order: 0 as const, strict: false };
  if (chainSeparation.order !== 0 && chainSeparation.strict) {
    return { order: chainSeparation.order, reason: 'disjoint' };
  }
  const decisive = (result: SweepResult | undefined): boolean =>
    result !== undefined &&
    (result.reason === 'disjoint' || result.reason === 'peel' || result.reason === 'touching');
  const forward = sweepDirection(
    world,
    routeA,
    visitA,
    routeB,
    visitB,
    1,
    orientationB,
    sharedAxis,
    sharedDir,
  );
  // Forward-nearest beats strictness because it reflects the first geometric interaction;
  // a later strict separation must not override an earlier abutting one.
  if (decisive(forward) && !forward?.weak) {
    return forward as SweepResult;
  }
  const backward = sweepDirection(
    world,
    routeA,
    visitA,
    routeB,
    visitB,
    -1,
    -orientationB as 1 | -1,
    sharedAxis,
    -sharedDir as 1 | -1,
  );
  if (decisive(backward) && !backward?.weak) {
    return backward as SweepResult;
  }
  if (chainSeparation.order !== 0) {
    return { order: chainSeparation.order, reason: 'touching' };
  }
  // Endpoint-derived pin decisions rank below every band fact but above the span fallback.
  if (decisive(forward)) {
    return forward as SweepResult;
  }
  if (decisive(backward)) {
    return backward as SweepResult;
  }
  const soft = forward ?? backward;
  if (soft) {
    return soft;
  }
  // Nothing geometric separated them. If they never share travel they cannot contend, so any
  // order would be invented -- but the rank is a total order, so we still must not contradict
  // whatever the bands allow. Report the tie and let the caller's stable tiebreak decide.
  return { order: 0, reason: 'tied' };
}
