import type { LayoutManager } from '../../LayoutManager.js';
import { spansOverlapPositive, subtractSpan } from '../../rangeUtils.js';
import type { Axis, AxisSpan, LayoutEntity, PositionProps } from '../../types.js';
import type { Corridor } from './contract.js';
import {
  type AxisFreeSpace,
  certifiedRunFrom,
  type FreeSpaceSubstrate,
} from './freeSpaceSubstrate.js';
import type { LandingZoneRect } from './landingZones.js';
import { crossSpanOf, travelSpanOf } from './geometry.js';
import {
  insertIntoSortedBy,
  sortedUnique,
  addUniqueNumber,
  upperBound,
  lowerBoundInt32,
  upperBoundInt32,
} from './sortedArrayUtils.js';

const DIRECT_RESIDUAL_MIN_CROSS_PX = 24;
const DIRECT_RESIDUAL_ENTRY_COST_PX = 1;
const DIRECT_NEAR_MISS_WALL_TOLERANCE_PX = 20;
const DIRECT_NEAR_MISS_MAX_CROSS_PX = 100;
// Below this cross width a corridor cannot host a route with usable clearance; such
// pieces are escape-only regardless of source (the escape pass keeps them reachable).
const DIRECT_NARROW_ESCAPE_CROSS_PX = 8;

/** One wall side as CSR parallel arrays: unique sorted boundary coords -> wall entries. */
interface WallSideIndex {
  /** Unique grid boundary coordinates, ascending. */
  readonly coords: Int32Array;
  /** Wall-entry offsets per coordinate; length coords.length + 1. */
  readonly offsets: Uint32Array;
  readonly spanStarts: Int32Array;
  readonly spanEnds: Int32Array;
  /** Entity index per wall entry; -1 marks the routing bounds. */
  readonly entityIndexes: Int32Array;
  /** 1 marks an inner container wall. */
  readonly innerFlags: Uint8Array;
}

interface WallIndex {
  readonly negative: WallSideIndex;
  readonly positive: WallSideIndex;
}

/** Ancestor entity indexes as CSR parallel arrays (lists are nesting-depth small). */
interface AncestorIndex {
  readonly offsets: Uint32Array;
  readonly items: Int32Array;
}

/** Everything the construction derives from one pass over the entities. */
interface EntityIndexes {
  readonly walls: Readonly<Record<Axis, WallIndex>>;
  readonly boundaries: Readonly<Record<Axis, readonly ContainerTravelBoundary[]>>;
  readonly containerCrossEdges: ContainerCrossEdgeTables;
  readonly ancestors: AncestorIndex;
  /** Containers sorted by travel start per axis, for the free-atom slab sweep. */
  readonly containersByTravel: Readonly<Record<Axis, readonly LayoutEntity[]>>;
}

interface FreeAtom {
  readonly travel: AxisSpan;
  readonly cross: AxisSpan;
  /** Substrate travelCuts index of `travel[0]`; `travel[1]` lives at the next index. */
  readonly slabIndex: number;
}

interface GapSlice {
  readonly axis: Axis;
  readonly travel: AxisSpan;
  readonly cross: AxisSpan;
}

interface DirectClaim {
  readonly travel: AxisSpan;
  readonly cross: AxisSpan;
  readonly source: 'gap' | 'runway';
}

type DirectGapCorridorSource = 'gap' | 'runway' | 'residual';

/** Construction-internal piece; the result materializes final `Corridor`s plus metadata. */
interface DirectGapCorridorPiece {
  readonly axis: Axis;
  readonly rect: PositionProps;
  readonly searchTier: 'preferred' | 'escape';
  readonly entryCost: number;
}

/**
 * Builds the production corridor partition directly from packed free-space slabs.
 * Wall-backed slices establish gap identities, which bridge only through certified free space.
 */
export function constructDirectGapCorridors({
  bounds,
  layoutManager,
  freeSpace,
  runways,
}: {
  readonly bounds: PositionProps;
  readonly layoutManager: LayoutManager;
  readonly freeSpace: FreeSpaceSubstrate;
  readonly runways: readonly LandingZoneRect[];
}): {
  readonly corridors: readonly Corridor[];
  readonly searchTiers: Uint8Array;
  readonly entryCosts: Float64Array;
} {
  const entities = layoutManager.getEntities();
  const indexes = buildEntityIndexes(bounds, entities, layoutManager);
  const boundaries = indexes.boundaries;
  const atoms = {
    x: freeAtoms('x', freeSpace.x, indexes.containersByTravel.x),
    y: freeAtoms('y', freeSpace.y, indexes.containersByTravel.y),
  };
  const slices = supportedGapSlices(atoms, indexes.walls, indexes.ancestors);
  const gapRuns = buildGapRuns(slices, freeSpace, indexes.containerCrossEdges, boundaries);
  const nearMissGaps = buildNearMissGapClaims(
    indexes.walls,
    indexes.ancestors,
    freeSpace,
    indexes.containerCrossEdges,
    boundaries,
  );
  const structuralClaims: Record<Axis, DirectClaim[]> = { x: [], y: [] };
  for (const runway of runways) {
    structuralClaims[runway.axis].push({
      travel: travelSpanOf(runway.axis, runway),
      cross: crossSpanOf(runway.axis, runway),
      source: 'runway',
    });
  }
  structuralClaims.x.push(...gapRuns.x, ...nearMissGaps.x);
  structuralClaims.y.push(...gapRuns.y, ...nearMissGaps.y);
  const pieces = partitionAtoms(atoms, structuralClaims, boundaries, freeSpace);
  const corridors: Corridor[] = new Array(pieces.length);
  const searchTiers = new Uint8Array(pieces.length);
  const entryCosts = new Float64Array(pieces.length);
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index];
    corridors[index] = { index, axis: piece.axis, rect: piece.rect };
    searchTiers[index] = piece.searchTier === 'escape' ? 1 : 0;
    entryCosts[index] = piece.entryCost;
  }
  return { corridors, searchTiers, entryCosts };
}

function freeAtoms(
  axis: Axis,
  freeSpace: AxisFreeSpace,
  containers: readonly LayoutEntity[],
): FreeAtom[] {
  const result: FreeAtom[] = [];
  // Containers arrive sorted by travel start. Those active for a slab cover its whole
  // travel span: the sweep admits them once their travel start reaches the slab and
  // retires them for good once their travel end can no longer cover a slab (slab ends
  // only grow).
  let nextContainer = 0;
  const active: LayoutEntity[] = [];
  const slabEdges: number[] = [];
  for (let slabIndex = 0; slabIndex < freeSpace.travelCuts.length - 1; slabIndex += 1) {
    const travelStart = freeSpace.travelCuts[slabIndex];
    const travelEnd = freeSpace.travelCuts[slabIndex + 1];
    if (travelEnd <= travelStart) {
      continue;
    }
    const travel: AxisSpan = [travelStart, travelEnd];
    while (nextContainer < containers.length) {
      const candidate = containers[nextContainer];
      if ((axis === 'x' ? candidate.x : candidate.y) > travelStart) {
        break;
      }
      active.push(candidate);
      nextContainer += 1;
    }
    let activeCount = 0;
    for (let index = 0; index < active.length; index += 1) {
      const candidate = active[index];
      const candidateEnd =
        axis === 'x' ? candidate.x + candidate.width : candidate.y + candidate.height;
      if (candidateEnd >= travelEnd) {
        active[activeCount] = candidate;
        activeCount += 1;
      }
    }
    active.length = activeCount;
    slabEdges.length = 0;
    for (const container of active) {
      const start = axis === 'x' ? container.y : container.x;
      slabEdges.push(start, start + (axis === 'x' ? container.height : container.width));
    }
    slabEdges.sort((left, right) => left - right);
    for (
      let intervalIndex = freeSpace.slabOffsets[slabIndex];
      intervalIndex < freeSpace.slabOffsets[slabIndex + 1];
      intervalIndex += 1
    ) {
      const crossStart = freeSpace.crossSpans[intervalIndex * 2];
      const crossEnd = freeSpace.crossSpans[intervalIndex * 2 + 1];
      let cursor = crossStart;
      if (slabEdges.length > 0) {
        const low = upperBound(slabEdges, crossStart);
        for (let edgeIndex = low; edgeIndex < slabEdges.length; edgeIndex += 1) {
          const cut = slabEdges[edgeIndex];
          if (cut >= crossEnd) {
            break;
          }
          if (cut <= cursor) {
            continue;
          }
          result.push({ travel, cross: [cursor, cut], slabIndex });
          cursor = cut;
        }
      }
      if (crossEnd > cursor) {
        result.push({ travel, cross: [cursor, crossEnd], slabIndex });
      }
    }
  }
  return result;
}

/** Mutable accumulator for one wall side before it is packed into CSR arrays. */
interface WallSideAccumulator {
  readonly boundaries: number[];
  readonly spanStarts: number[];
  readonly spanEnds: number[];
  readonly entityIndexes: number[];
  readonly innerFlags: number[];
}

function buildEntityIndexes(
  bounds: PositionProps,
  entities: readonly LayoutEntity[],
  layoutManager: LayoutManager,
): EntityIndexes {
  const sides: Record<Axis, { negative: WallSideAccumulator; positive: WallSideAccumulator }> = {
    x: { negative: newWallSideAccumulator(), positive: newWallSideAccumulator() },
    y: { negative: newWallSideAccumulator(), positive: newWallSideAccumulator() },
  };
  const fullTravel: Readonly<Record<Axis, AxisSpan>> = {
    x: [bounds.x, bounds.x + bounds.width],
    y: [bounds.y, bounds.y + bounds.height],
  };
  appendWall(sides.x.negative, crossSpanOf('x', bounds)[0], fullTravel.x, -1, false);
  appendWall(sides.x.positive, crossSpanOf('x', bounds)[1], fullTravel.x, -1, false);
  appendWall(sides.y.negative, crossSpanOf('y', bounds)[0], fullTravel.y, -1, false);
  appendWall(sides.y.positive, crossSpanOf('y', bounds)[1], fullTravel.y, -1, false);
  const boundaries: Record<Axis, ContainerTravelBoundary[]> = { x: [], y: [] };
  const crossEdgesX: number[] = [];
  const crossEdgesY: number[] = [];
  const containersX: LayoutEntity[] = [];
  const containersY: LayoutEntity[] = [];
  const indexById = new Map<string, number>();
  for (let entityIndex = 0; entityIndex < entities.length; entityIndex += 1) {
    const entity = entities[entityIndex];
    indexById.set(entity.id, entityIndex);
    const isContainer = entity.isContainer === true;
    for (const axis of ['x', 'y'] as const) {
      const [crossStart, crossEnd] = crossSpanOf(axis, entity);
      const travel = travelSpanOf(axis, entity);
      addEntityWall(sides[axis].negative, entity, entityIndex, axis, crossEnd, travel, false);
      addEntityWall(sides[axis].positive, entity, entityIndex, axis, crossStart, travel, false);
      if (isContainer) {
        addEntityWall(sides[axis].negative, entity, entityIndex, axis, crossStart, travel, true);
        addEntityWall(sides[axis].positive, entity, entityIndex, axis, crossEnd, travel, true);
        boundaries[axis].push(
          { coord: travel[0], cross: [crossStart, crossEnd] },
          { coord: travel[1], cross: [crossStart, crossEnd] },
        );
      }
    }
    if (isContainer) {
      crossEdgesX.push(entity.y, entity.y + entity.height);
      crossEdgesY.push(entity.x, entity.x + entity.width);
      containersX.push(entity);
      containersY.push(entity);
    }
  }
  boundaries.x.sort((left, right) => left.coord - right.coord);
  boundaries.y.sort((left, right) => left.coord - right.coord);
  containersX.sort((left, right) => left.x - right.x);
  containersY.sort((left, right) => left.y - right.y);
  const parentMapping = layoutManager.getParentMapping();
  const ancestorOffsets = new Uint32Array(entities.length + 1);
  const ancestorItems: number[] = [];
  for (let entityIndex = 0; entityIndex < entities.length; entityIndex += 1) {
    for (const ancestorId of parentMapping[entities[entityIndex].id] ?? []) {
      const ancestorIndex = indexById.get(ancestorId);
      if (ancestorIndex !== undefined) {
        ancestorItems.push(ancestorIndex);
      }
    }
    ancestorOffsets[entityIndex + 1] = ancestorItems.length;
  }
  return {
    walls: {
      x: { negative: packWallSide(sides.x.negative), positive: packWallSide(sides.x.positive) },
      y: { negative: packWallSide(sides.y.negative), positive: packWallSide(sides.y.positive) },
    },
    boundaries,
    containerCrossEdges: {
      // Bare .sort() on an Int32Array is numeric (typed-array default), not the
      // lexicographic Array default it resembles.
      x: Int32Array.from(crossEdgesX).sort(),
      y: Int32Array.from(crossEdgesY).sort(),
    },
    ancestors: { offsets: ancestorOffsets, items: Int32Array.from(ancestorItems) },
    containersByTravel: { x: containersX, y: containersY },
  };
}

function newWallSideAccumulator(): WallSideAccumulator {
  return { boundaries: [], spanStarts: [], spanEnds: [], entityIndexes: [], innerFlags: [] };
}

function addEntityWall(
  side: WallSideAccumulator,
  entity: LayoutEntity,
  entityIndex: number,
  axis: Axis,
  boundary: number,
  travel: AxisSpan,
  innerContainer: boolean,
): void {
  for (const span of wallSpansOutsideTitle(entity, axis, boundary, travel, innerContainer)) {
    appendWall(side, boundary, span, entityIndex, innerContainer);
  }
}

function appendWall(
  side: WallSideAccumulator,
  boundary: number,
  span: AxisSpan,
  entityIndex: number,
  innerContainer: boolean,
): void {
  side.boundaries.push(boundary);
  side.spanStarts.push(span[0]);
  side.spanEnds.push(span[1]);
  side.entityIndexes.push(entityIndex);
  side.innerFlags.push(innerContainer ? 1 : 0);
}

/** Packs a wall-side accumulator into CSR arrays sorted by boundary (stable per coord). */
function packWallSide(side: WallSideAccumulator): WallSideIndex {
  const count = side.boundaries.length;
  const order: number[] = new Array(count);
  for (let index = 0; index < count; index += 1) {
    order[index] = index;
  }
  order.sort((left, right) => side.boundaries[left] - side.boundaries[right] || left - right);
  const coords: number[] = [];
  const offsets: number[] = [0];
  const spanStarts = new Int32Array(count);
  const spanEnds = new Int32Array(count);
  const entityIndexes = new Int32Array(count);
  const innerFlags = new Uint8Array(count);
  for (let position = 0; position < count; position += 1) {
    const source = order[position];
    const boundary = side.boundaries[source];
    if (coords.length === 0 || coords[coords.length - 1] !== boundary) {
      coords.push(boundary);
      offsets.push(position);
    }
    offsets[offsets.length - 1] = position + 1;
    spanStarts[position] = side.spanStarts[source];
    spanEnds[position] = side.spanEnds[source];
    entityIndexes[position] = side.entityIndexes[source];
    innerFlags[position] = side.innerFlags[source];
  }
  return {
    coords: Int32Array.from(coords),
    offsets: Uint32Array.from(offsets),
    spanStarts,
    spanEnds,
    entityIndexes,
    innerFlags,
  };
}

function supportedGapSlices(
  atoms: Readonly<Record<Axis, readonly FreeAtom[]>>,
  walls: Readonly<Record<Axis, WallIndex>>,
  ancestors: AncestorIndex,
): GapSlice[] {
  const result: GapSlice[] = [];
  for (const axis of ['x', 'y'] as const) {
    for (const atom of atoms[axis]) {
      const negative = walls[axis].negative;
      const positive = walls[axis].positive;
      const negativeCoord = nearestCoordIndex(negative.coords, atom.cross[0]);
      if (negativeCoord < 0) {
        continue;
      }
      const positiveCoord = nearestCoordIndex(positive.coords, atom.cross[1]);
      if (positiveCoord < 0) {
        continue;
      }
      if (
        hasFacingWallPair(negative, negativeCoord, positive, positiveCoord, atom.travel, ancestors)
      ) {
        result.push({ axis, travel: atom.travel, cross: atom.cross });
      }
    }
  }
  return result;
}

function hasFacingWallPair(
  negative: WallSideIndex,
  negativeCoord: number,
  positive: WallSideIndex,
  positiveCoord: number,
  travel: AxisSpan,
  ancestors: AncestorIndex,
): boolean {
  const travelStart = travel[0];
  const travelEnd = travel[1];
  for (
    let left = negative.offsets[negativeCoord];
    left < negative.offsets[negativeCoord + 1];
    left += 1
  ) {
    if (negative.spanStarts[left] > travelStart || negative.spanEnds[left] < travelEnd) {
      continue;
    }
    for (
      let right = positive.offsets[positiveCoord];
      right < positive.offsets[positiveCoord + 1];
      right += 1
    ) {
      if (
        positive.spanStarts[right] <= travelStart &&
        positive.spanEnds[right] >= travelEnd &&
        validWallPair(
          negative.entityIndexes[left],
          negative.innerFlags[left] === 1,
          positive.entityIndexes[right],
          positive.innerFlags[right] === 1,
          ancestors,
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function validWallPair(
  negativeEntity: number,
  negativeInner: boolean,
  positiveEntity: number,
  positiveInner: boolean,
  ancestors: AncestorIndex,
): boolean {
  if (negativeEntity < 0 && positiveEntity < 0) {
    return false;
  }
  if (negativeEntity >= 0 && negativeEntity === positiveEntity) {
    return false;
  }
  if (
    negativeInner &&
    (positiveEntity < 0 || !hasAncestor(ancestors, positiveEntity, negativeEntity))
  ) {
    return false;
  }
  if (
    positiveInner &&
    (negativeEntity < 0 || !hasAncestor(ancestors, negativeEntity, positiveEntity))
  ) {
    return false;
  }
  return true;
}

function hasAncestor(
  ancestors: AncestorIndex,
  entityIndex: number,
  ancestorIndex: number,
): boolean {
  for (
    let cursor = ancestors.offsets[entityIndex];
    cursor < ancestors.offsets[entityIndex + 1];
    cursor += 1
  ) {
    if (ancestors.items[cursor] === ancestorIndex) {
      return true;
    }
  }
  return false;
}

function buildGapRuns(
  slices: readonly GapSlice[],
  freeSpace: FreeSpaceSubstrate,
  containerCrossEdges: ContainerCrossEdgeTables,
  boundaries: Readonly<Record<Axis, readonly ContainerTravelBoundary[]>>,
): Record<Axis, DirectClaim[]> {
  // Preserve first-seen order within each axis; group keys are exact grid coordinates.
  const groups: Readonly<Record<Axis, Map<number, Map<number, GapSlice[]>>>> = {
    x: new Map(),
    y: new Map(),
  };
  for (const slice of slices) {
    const byCrossStart = groups[slice.axis];
    let byCrossEnd = byCrossStart.get(slice.cross[0]);
    if (!byCrossEnd) {
      byCrossEnd = new Map();
      byCrossStart.set(slice.cross[0], byCrossEnd);
    }
    const values = byCrossEnd.get(slice.cross[1]);
    if (values) {
      values.push(slice);
    } else {
      byCrossEnd.set(slice.cross[1], [slice]);
    }
  }
  const result: Record<Axis, DirectClaim[]> = { x: [], y: [] };
  for (const axis of ['x', 'y'] as const) {
    for (const byCrossEnd of groups[axis].values()) {
      for (const group of byCrossEnd.values()) {
        group.sort(
          (left, right) => left.travel[0] - right.travel[0] || left.travel[1] - right.travel[1],
        );
        let start = group[0].travel[0];
        let end = group[0].travel[1];
        const cross = group[0].cross;
        for (let index = 1; index < group.length; index += 1) {
          const next = group[index];
          const candidateTravel: AxisSpan = [start, Math.max(end, next.travel[1])];
          if (
            freeSpaceContains(freeSpace[axis], candidateTravel, cross) &&
            !crossesParallelContainerBoundary(axis, cross, containerCrossEdges)
          ) {
            end = candidateTravel[1];
          } else {
            result[axis].push(
              claimForGapRun(axis, [start, end], cross, freeSpace, containerCrossEdges, boundaries),
            );
            start = next.travel[0];
            end = next.travel[1];
          }
        }
        result[axis].push(
          claimForGapRun(axis, [start, end], cross, freeSpace, containerCrossEdges, boundaries),
        );
      }
    }
  }
  return result;
}

/**
 * Seeds a wall-backed gap when opposing entity walls narrowly miss along travel.
 * The complete bridged rectangle must already be certified free space, and container
 * boundaries retain the same legality rules as ordinary literal gap runs.
 */
function buildNearMissGapClaims(
  walls: Readonly<Record<Axis, WallIndex>>,
  ancestors: AncestorIndex,
  freeSpace: FreeSpaceSubstrate,
  containerCrossEdges: ContainerCrossEdgeTables,
  boundaries: Readonly<Record<Axis, readonly ContainerTravelBoundary[]>>,
): Record<Axis, DirectClaim[]> {
  const result: Record<Axis, DirectClaim[]> = { x: [], y: [] };
  const seen = new Set<string>();
  for (const axis of ['x', 'y'] as const) {
    const negative = walls[axis].negative;
    const positive = walls[axis].positive;
    // Both coordinate tables ascend, so only positive coords inside the near-miss window
    // (negativeCoord, negativeCoord + max cross] can pair; the window start pointer is
    // monotone across negative coords and the width check breaks the scan.
    let windowStart = 0;
    for (let negativeIdx = 0; negativeIdx < negative.coords.length; negativeIdx += 1) {
      const negativeCoord = negative.coords[negativeIdx];
      while (
        windowStart < positive.coords.length &&
        positive.coords[windowStart] <= negativeCoord
      ) {
        windowStart += 1;
      }
      for (let positiveIdx = windowStart; positiveIdx < positive.coords.length; positiveIdx += 1) {
        const positiveCoord = positive.coords[positiveIdx];
        const cross: AxisSpan = [negativeCoord, positiveCoord];
        if (cross[1] - cross[0] > DIRECT_NEAR_MISS_MAX_CROSS_PX) {
          break;
        }
        if (crossesParallelContainerBoundary(axis, cross, containerCrossEdges)) {
          continue;
        }
        for (
          let left = negative.offsets[negativeIdx];
          left < negative.offsets[negativeIdx + 1];
          left += 1
        ) {
          if (negative.entityIndexes[left] < 0) {
            continue;
          }
          for (
            let right = positive.offsets[positiveIdx];
            right < positive.offsets[positiveIdx + 1];
            right += 1
          ) {
            if (
              positive.entityIndexes[right] < 0 ||
              !validWallPair(
                negative.entityIndexes[left],
                negative.innerFlags[left] === 1,
                positive.entityIndexes[right],
                positive.innerFlags[right] === 1,
                ancestors,
              )
            ) {
              continue;
            }
            const travel = nearMissUnion(
              [negative.spanStarts[left], negative.spanEnds[left]],
              [positive.spanStarts[right], positive.spanEnds[right]],
            );
            if (!travel || !freeSpaceContains(freeSpace[axis], travel, cross)) {
              continue;
            }
            const claim = claimForGapRun(
              axis,
              travel,
              cross,
              freeSpace,
              containerCrossEdges,
              boundaries,
            );
            const key = `${axis}:${claim.travel[0]}:${claim.travel[1]}:${claim.cross[0]}:${claim.cross[1]}`;
            if (!seen.has(key)) {
              seen.add(key);
              result[axis].push(claim);
            }
          }
        }
      }
    }
  }
  return result;
}

function nearMissUnion(left: AxisSpan, right: AxisSpan): AxisSpan | undefined {
  const miss = Math.max(left[0], right[0]) - Math.min(left[1], right[1]);
  if (miss <= 0 || miss > DIRECT_NEAR_MISS_WALL_TOLERANCE_PX) {
    return undefined;
  }
  return [Math.min(left[0], right[0]), Math.max(left[1], right[1])];
}

function claimForGapRun(
  axis: Axis,
  travel: AxisSpan,
  cross: AxisSpan,
  freeSpace: FreeSpaceSubstrate,
  containerCrossEdges: ContainerCrossEdgeTables,
  boundaries: Readonly<Record<Axis, readonly ContainerTravelBoundary[]>>,
): DirectClaim {
  if (crossesParallelContainerBoundary(axis, cross, containerCrossEdges)) {
    return { travel, cross, source: 'gap' };
  }
  return {
    travel: extendTravelThroughFreeSpace(freeSpace[axis], boundaries[axis], travel, cross),
    cross,
    source: 'gap',
  };
}

interface ContainerTravelBoundary {
  readonly coord: number;
  readonly cross: AxisSpan;
}

/**
 * Extends a gap run's travel span through certified free space at its exact cross span.
 * Wall-backing establishes where the identity is born; this pass lets it continue as far
 * as the substrate certifies. Container walls are zero-thickness travel events the free
 * space would happily bridge, so they cap the walk explicitly.
 */
function extendTravelThroughFreeSpace(
  freeSpace: AxisFreeSpace,
  boundaries: readonly ContainerTravelBoundary[],
  travel: AxisSpan,
  cross: AxisSpan,
): AxisSpan {
  let backwardCap = Number.NEGATIVE_INFINITY;
  let forwardCap = Number.POSITIVE_INFINITY;
  for (const boundary of boundaries) {
    if (!spansOverlapPositive(boundary.cross, cross, 0)) {
      continue;
    }
    if (boundary.coord < travel[0]) {
      backwardCap = Math.max(backwardCap, boundary.coord);
    } else if (boundary.coord > travel[1]) {
      forwardCap = Math.min(forwardCap, boundary.coord);
    }
  }
  return [
    certifiedRunFrom(freeSpace, travel[0], cross, -1, backwardCap),
    certifiedRunFrom(freeSpace, travel[1], cross, 1, forwardCap),
  ];
}

function partitionAtoms(
  atoms: Readonly<Record<Axis, readonly FreeAtom[]>>,
  claims: Readonly<Record<Axis, DirectClaim[]>>,
  boundaries: Readonly<Record<Axis, readonly ContainerTravelBoundary[]>>,
  freeSpace: FreeSpaceSubstrate,
): DirectGapCorridorPiece[] {
  const state = {
    lanes: { x: new Map(), y: new Map() },
    survivors: { x: [], y: [] },
    dirtyLanes: { x: new Set(), y: new Set() },
    travelGrown: { x: new Set(), y: new Set() },
  } as CoalesceState;
  for (const axis of ['x', 'y'] as const) {
    const sortedClaims = claims[axis].sort((left, right) => left.travel[0] - right.travel[0]);
    const tables = buildPartitionTables(atoms[axis], sortedClaims, freeSpace[axis].travelCuts);
    partitionAxisAtoms(axis, atoms[axis], sortedClaims, tables, state);
  }
  return finalizeCoalescedPieces(state, boundaries);
}

/**
 * Coordinate tables for one axis's partition. The substrate travelCuts are the canonical
 * travel table — claim edges intern into it once, and the few off-table edges (runway
 * edges mostly) join through a small sorted overlay merged in. Cross coordinates are
 * already whole-pixel grid integers, so retaining their values is both exact and cheaper
 * than interning them into a second table. In particular, two distinct atom bounds may
 * occupy the same gap between claim edges; a gap-rank key would collapse that real span.
 */
interface PartitionTables {
  readonly travelCoords: Int32Array;
  /** Interned indices into `travelCoords`, not coordinates - this is why the tables exist. */
  readonly atomTravelStart: Int32Array;
  readonly atomTravelEnd: Int32Array;
  readonly claimTravelStart: Int32Array;
  readonly claimTravelEnd: Int32Array;
}

function buildPartitionTables(
  atoms: readonly FreeAtom[],
  claims: readonly DirectClaim[],
  travelCuts: Int32Array,
): PartitionTables {
  const overlay: number[] = [];
  for (const claim of claims) {
    if (nearestCoordIndex(travelCuts, claim.travel[0]) < 0) {
      overlay.push(claim.travel[0]);
    }
    if (nearestCoordIndex(travelCuts, claim.travel[1]) < 0) {
      overlay.push(claim.travel[1]);
    }
  }
  let travelCoords = travelCuts;
  let baseToExt: Int32Array | null = null;
  if (overlay.length > 0) {
    const kept = sortedUnique(overlay);
    travelCoords = mergeSortedCoords(travelCuts, kept);
    baseToExt = new Int32Array(travelCuts.length);
    let inserted = 0;
    for (let baseIndex = 0; baseIndex < travelCuts.length; baseIndex += 1) {
      while (inserted < kept.length && kept[inserted] < travelCuts[baseIndex]) {
        inserted += 1;
      }
      baseToExt[baseIndex] = baseIndex + inserted;
    }
  }
  const atomTravelStart = new Int32Array(atoms.length);
  const atomTravelEnd = new Int32Array(atoms.length);
  for (let index = 0; index < atoms.length; index += 1) {
    const startCut = atoms[index].slabIndex;
    atomTravelStart[index] = baseToExt === null ? startCut : baseToExt[startCut];
    atomTravelEnd[index] = baseToExt === null ? startCut + 1 : baseToExt[startCut + 1];
  }
  const claimTravelStart = new Int32Array(claims.length);
  const claimTravelEnd = new Int32Array(claims.length);
  for (let index = 0; index < claims.length; index += 1) {
    const claim = claims[index];
    claimTravelStart[index] = nearestCoordIndex(travelCoords, claim.travel[0]);
    claimTravelEnd[index] = nearestCoordIndex(travelCoords, claim.travel[1]);
  }
  return {
    travelCoords,
    atomTravelStart,
    atomTravelEnd,
    claimTravelStart,
    claimTravelEnd,
  };
}

/** Exact table index of `value`, or -1. */
function nearestCoordIndex(coords: Int32Array, value: number): number {
  const low = lowerBoundInt32(coords, value);
  return low < coords.length && coords[low] === value ? low : -1;
}

function mergeSortedCoords(base: Int32Array, overlay: readonly number[]): Int32Array {
  const merged = new Int32Array(base.length + overlay.length);
  let baseIndex = 0;
  let overlayIndex = 0;
  let write = 0;
  while (baseIndex < base.length || overlayIndex < overlay.length) {
    if (
      overlayIndex >= overlay.length ||
      (baseIndex < base.length && base[baseIndex] <= overlay[overlayIndex])
    ) {
      merged[write] = base[baseIndex];
      baseIndex += 1;
    } else {
      merged[write] = overlay[overlayIndex];
      overlayIndex += 1;
    }
    write += 1;
  }
  return merged;
}

function partitionAxisAtoms(
  axis: Axis,
  atoms: readonly FreeAtom[],
  claims: readonly DirectClaim[],
  tables: PartitionTables,
  state: CoalesceState,
): void {
  const { travelCoords, claimTravelStart, claimTravelEnd } = tables;
  const survivors = state.survivors[axis];
  let nextClaimIndex = 0;
  const activeClaims: number[] = [];
  let activeSlabStart = -1;
  const relevant: number[] = [];
  const open: number[] = [];
  const travelCutIdx: number[] = [];
  const crossCuts: number[] = [];
  for (let atomIndex = 0; atomIndex < atoms.length; atomIndex += 1) {
    const atomTs = tables.atomTravelStart[atomIndex];
    const atomTe = tables.atomTravelEnd[atomIndex];
    const atomCross = atoms[atomIndex].cross;
    const atomCs = atomCross[0];
    const atomCe = atomCross[1];
    if (activeSlabStart !== atomTs) {
      activeSlabStart = atomTs;
      let keep = 0;
      for (let index = 0; index < activeClaims.length; index += 1) {
        if (claimTravelEnd[activeClaims[index]] > atomTs) {
          activeClaims[keep] = activeClaims[index];
          keep += 1;
        }
      }
      activeClaims.length = keep;
      while (nextClaimIndex < claims.length && claimTravelStart[nextClaimIndex] < atomTe) {
        activeClaims.push(nextClaimIndex);
        nextClaimIndex += 1;
      }
    }
    // One pass: claims that actually hit this atom, plus the travel events they induce.
    relevant.length = 0;
    travelCutIdx.length = 0;
    travelCutIdx.push(atomTs, atomTe);
    for (let index = 0; index < activeClaims.length; index += 1) {
      const claimIndex = activeClaims[index];
      const claimTs = claimTravelStart[claimIndex];
      const claimTe = claimTravelEnd[claimIndex];
      if (claimTs >= atomTe || claimTe <= atomTs) {
        continue;
      }
      const claimCross = claims[claimIndex].cross;
      if (claimCross[0] >= atomCe || claimCross[1] <= atomCs) {
        continue;
      }
      relevant.push(claimIndex);
      if (claimTs > atomTs && claimTs < atomTe) {
        addUniqueNumber(travelCutIdx, claimTs, 0);
      }
      if (claimTe > atomTs && claimTe < atomTe) {
        addUniqueNumber(travelCutIdx, claimTe, 0);
      }
    }

    // Sweep along travel. `relevant` is start-ordered (subset of the sliding window), so
    // each claim enters `open` once and leaves once — no per-slice rescan of activeClaims.
    let nextRelevant = 0;
    open.length = 0;
    for (let travelIndex = 0; travelIndex < travelCutIdx.length - 1; travelIndex += 1) {
      const sliceTs = travelCutIdx[travelIndex];
      const sliceTe = travelCutIdx[travelIndex + 1];
      while (nextRelevant < relevant.length && claimTravelStart[relevant[nextRelevant]] < sliceTe) {
        open.push(relevant[nextRelevant]);
        nextRelevant += 1;
      }
      let openCount = 0;
      for (let index = 0; index < open.length; index += 1) {
        if (claimTravelEnd[open[index]] > sliceTs) {
          open[openCount] = open[index];
          openCount += 1;
        }
      }
      open.length = openCount;

      crossCuts.length = 0;
      crossCuts.push(atomCs, atomCe);
      for (let index = 0; index < open.length; index += 1) {
        const claimCross = claims[open[index]].cross;
        const claimCs = claimCross[0];
        const claimCe = claimCross[1];
        if (claimCs > atomCs && claimCs < atomCe) {
          addUniqueNumber(crossCuts, claimCs, 0);
        }
        if (claimCe > atomCs && claimCe < atomCe) {
          addUniqueNumber(crossCuts, claimCe, 0);
        }
      }
      const travel: AxisSpan = [travelCoords[sliceTs], travelCoords[sliceTe]];
      for (let crossIndex = 0; crossIndex < crossCuts.length - 1; crossIndex += 1) {
        const cellCs = crossCuts[crossIndex];
        const cellCe = crossCuts[crossIndex + 1];
        let rank = SOURCE_RANK.residual;
        for (let index = 0; index < open.length; index += 1) {
          const claimIndex = open[index];
          // Cheap interned-index bounds first; only survivors touch the claim object.
          if (claimTravelStart[claimIndex] > sliceTs || claimTravelEnd[claimIndex] < sliceTe) {
            continue;
          }
          const claim = claims[claimIndex];
          if (claim.cross[0] <= cellCs && claim.cross[1] >= cellCe) {
            if (claim.source === 'runway') {
              rank = SOURCE_RANK.runway;
              break;
            }
            rank = SOURCE_RANK.gap;
          }
        }
        emitCoalescePiece(state, survivors, axis, travel, [cellCs, cellCe], rank);
      }
    }
  }
}

const SOURCE_RANK: Readonly<Record<DirectGapCorridorSource, number>> = {
  residual: 0,
  gap: 1,
  runway: 2,
};

const SOURCE_BY_RANK: readonly DirectGapCorridorSource[] = ['residual', 'gap', 'runway'];

/**
 * Mutable coalesce-time piece. Scalar span keys are assigned at creation and merged in
 * place: travel merges grow `te`, cross merges widen `cs`/`ce`, the source is a running
 * max rank, and tier/entry cost re-classify from the final width at materialization —
 * all associative, so incremental merging cannot change the outcome.
 */
interface CoalescePiece {
  readonly axis: Axis;
  readonly ts: number;
  te: number;
  cs: number;
  ce: number;
  rank: number;
  alive: boolean;
  lane: CoalescePiece[];
}

interface CoalesceState {
  /** Per axis: interned cross start -> interned cross end -> lane, ascending travel. */
  readonly lanes: Readonly<Record<Axis, Map<number, Map<number, CoalescePiece[]>>>>;
  /**
   * Per axis. No merge crosses axes - lanes are axis-scoped and the cross sweep only
   * pairs same-lane-shaped neighbours - so each axis coalesces as an independent
   * fixpoint and the results concatenate x-then-y.
   */
  readonly survivors: Readonly<Record<Axis, CoalescePiece[]>>;
  /** Lanes that received a cross-merged piece since the last travel absorption. */
  readonly dirtyLanes: Readonly<Record<Axis, Set<CoalescePiece[]>>>;
  /** Pieces whose travel end grew, pending binary re-insert into the working order. */
  readonly travelGrown: Readonly<Record<Axis, Set<CoalescePiece>>>;
}

function coalesceLaneOf(
  state: CoalesceState,
  axis: Axis,
  crossStart: number,
  crossEnd: number,
): CoalescePiece[] {
  const byCrossStart = state.lanes[axis];
  let byCrossEnd = byCrossStart.get(crossStart);
  if (!byCrossEnd) {
    byCrossEnd = new Map();
    byCrossStart.set(crossStart, byCrossEnd);
  }
  let lane = byCrossEnd.get(crossEnd);
  if (!lane) {
    lane = [];
    byCrossEnd.set(crossEnd, lane);
  }
  return lane;
}

/**
 * Emission-time travel merge: pieces arrive per lane (axis + interned cross span) in
 * ascending travel order, so the lane tail absorbs any touching piece immediately and
 * the pre-coalesce piece population never materializes.
 */
function emitCoalescePiece(
  state: CoalesceState,
  survivors: CoalescePiece[],
  axis: Axis,
  travel: AxisSpan,
  cross: AxisSpan,
  rank: number,
): void {
  const lane = coalesceLaneOf(state, axis, cross[0], cross[1]);
  const tail = lane[lane.length - 1];
  if (tail !== undefined && travel[0] <= tail.te) {
    if (travel[1] > tail.te) {
      tail.te = travel[1];
    }
    if (rank > tail.rank) {
      tail.rank = rank;
    }
    return;
  }
  const piece: CoalescePiece = {
    axis,
    ts: travel[0],
    te: travel[1],
    cs: cross[0],
    ce: cross[1],
    rank,
    alive: true,
    lane,
  };
  lane.push(piece);
  survivors.push(piece);
}

/**
 * Emission left every lane internally merged (the travel phase's fixpoint), so what
 * remains alternates cross-stack sweeps with travel absorption in the lanes the sweep
 * touched, until a full round merges nothing. The working array is sorted travel-major
 * once; sweeps preserve that order in place, and the rare merge that changes a piece's
 * sort key binary re-inserts it instead of re-sorting.
 */
function finalizeCoalescedPieces(
  state: CoalesceState,
  boundaries: Readonly<Record<Axis, readonly ContainerTravelBoundary[]>>,
): DirectGapCorridorPiece[] {
  const coalesced: DirectGapCorridorPiece[] = [];
  // x before y required for ordering invariant
  for (const axis of ['x', 'y'] as const) {
    // Sorted in place: `state` is local to partitionAtoms, this is its last read, and
    // the loop below reassigns `pieces` to filtered copies anyway.
    let pieces = state.survivors[axis];
    pieces.sort(compareTravelMajor);
    while (true) {
      const crossMerges = crossStackSweep(state, axis, pieces, boundaries);
      const travelMerges = absorbDirtyLaneRuns(state, axis);
      if (crossMerges + travelMerges === 0) {
        break;
      }
      pieces = pieces.filter((piece) => piece.alive);
      for (const piece of state.travelGrown[axis]) {
        reinsertPiece(pieces, piece);
      }
      state.travelGrown[axis].clear();
    }
    // Corridor indexes — and therefore portal identities — depend on this exact final
    // order; do not drop it.
    pieces.sort(compareCoalescedCorridors);
    for (const piece of pieces) {
      coalesced.push(materializeCoalescedPiece(piece));
    }
  }
  return coalesced;
}

function compareTravelMajor(left: CoalescePiece, right: CoalescePiece): number {
  return left.ts - right.ts || left.te - right.te || left.cs - right.cs;
}

function compareCoalescedCorridors(left: CoalescePiece, right: CoalescePiece): number {
  return left.cs - right.cs || left.ce - right.ce || left.ts - right.ts || left.te - right.te;
}

function materializeCoalescedPiece(piece: CoalescePiece): DirectGapCorridorPiece {
  const source = SOURCE_BY_RANK[piece.rank];

  const rect =
    piece.axis === 'x'
      ? { x: piece.ts, y: piece.cs, width: piece.te - piece.ts, height: piece.ce - piece.cs }
      : { x: piece.cs, y: piece.ts, width: piece.ce - piece.cs, height: piece.te - piece.ts };

  return {
    axis: piece.axis,
    rect,
    ...pieceClassification(source, piece.ce - piece.cs),
  };
}

/**
 * Merges same-axis pieces that share an exact travel span and touch in cross, widening
 * the corridor. A parallel container wall along the touch line blocks the merge; the wall
 * lookup uses the opposite axis's boundary index because a cross-direction touch line is
 * a travel-direction edge of that axis. Merging into `previous` keeps the working array's
 * travel-major order valid (the merged key components do not move).
 */
function crossStackSweep(
  state: CoalesceState,
  axis: Axis,
  pieces: readonly CoalescePiece[],
  boundaries: Readonly<Record<Axis, readonly ContainerTravelBoundary[]>>,
): number {
  let merges = 0;
  let previous: CoalescePiece | undefined;
  for (const piece of pieces) {
    if (
      previous !== undefined &&
      previous.ts === piece.ts &&
      previous.te === piece.te &&
      previous.cs <= piece.ce &&
      piece.cs <= previous.ce &&
      !crossesContainerWallAt(
        boundaries[piece.axis === 'x' ? 'y' : 'x'],
        piece.cs,
        piece.ts,
        piece.te,
      )
    ) {
      removeFromLane(previous);
      removeFromLane(piece);
      piece.alive = false;
      if (piece.cs < previous.cs) {
        previous.cs = piece.cs;
      }
      if (piece.ce > previous.ce) {
        previous.ce = piece.ce;
      }
      if (piece.rank > previous.rank) {
        previous.rank = piece.rank;
      }
      const lane = coalesceLaneOf(state, previous.axis, previous.cs, previous.ce);
      insertIntoSortedBy(lane, previous, compareTravelStart);
      previous.lane = lane;
      state.dirtyLanes[axis].add(lane);
      merges += 1;
    } else {
      previous = piece;
    }
  }
  return merges;
}

/**
 * Travel phase for the lanes the cross sweep changed: only lanes that gained a member
 * can hold a new touching pair, so absorbing runs there is a complete travel pass.
 */
function absorbDirtyLaneRuns(state: CoalesceState, axis: Axis): number {
  let merges = 0;
  for (const lane of state.dirtyLanes[axis]) {
    let write = 0;
    for (let read = 0; read < lane.length; read += 1) {
      const piece = lane[read];
      const previous = write > 0 ? lane[write - 1] : undefined;
      if (previous !== undefined && piece.ts <= previous.te) {
        if (piece.te > previous.te) {
          previous.te = piece.te;
          state.travelGrown[axis].add(previous);
        }
        if (piece.rank > previous.rank) {
          previous.rank = piece.rank;
        }
        piece.alive = false;
        merges += 1;
      } else {
        lane[write] = piece;
        write += 1;
      }
    }
    lane.length = write;
  }
  state.dirtyLanes[axis].clear();
  return merges;
}

function removeFromLane(piece: CoalescePiece): void {
  const lane = piece.lane;
  const index = lane.indexOf(piece);
  lane.copyWithin(index, index + 1);
  lane.length -= 1;
}

const compareTravelStart = (left: CoalescePiece, right: CoalescePiece): number =>
  left.ts - right.ts;

/** Binary re-insert for a piece whose travel end grew out of its maintained slot. */
function reinsertPiece(pieces: CoalescePiece[], piece: CoalescePiece): void {
  const index = pieces.indexOf(piece);
  pieces.copyWithin(index, index + 1);
  pieces.length -= 1;
  insertIntoSortedBy(pieces, piece, compareTravelMajor);
}

/**
 * Tier/entry-cost classification for a piece, from its source and cross width alone.
 * Sub-clearance widths are escape-only for gap/residual sources; residuals keep the
 * ordinary-width pricing; everything else is preferred at no cost.
 */
function pieceClassification(
  source: DirectGapCorridorSource,
  crossWidth: number,
): Pick<DirectGapCorridorPiece, 'searchTier' | 'entryCost'> {
  if (crossWidth < DIRECT_NARROW_ESCAPE_CROSS_PX) {
    return { searchTier: 'escape', entryCost: 0 };
  }
  if (source === 'residual') {
    const ordinaryResidual = crossWidth >= DIRECT_RESIDUAL_MIN_CROSS_PX;
    return ordinaryResidual
      ? { searchTier: 'preferred', entryCost: DIRECT_RESIDUAL_ENTRY_COST_PX }
      : { searchTier: 'escape', entryCost: 0 };
  }
  return { searchTier: 'preferred', entryCost: 0 };
}

function crossesContainerWallAt(
  boundaries: readonly ContainerTravelBoundary[],
  coord: number,
  spanStart: number,
  spanEnd: number,
): boolean {
  for (const boundary of boundaries) {
    if (boundary.coord > coord) {
      break;
    }
    if (boundary.coord < coord) {
      continue;
    }
    if (Math.min(boundary.cross[1], spanEnd) > Math.max(boundary.cross[0], spanStart)) {
      return true;
    }
  }
  return false;
}

function freeSpaceContains(freeSpace: AxisFreeSpace, travel: AxisSpan, cross: AxisSpan): boolean {
  return certifiedRunFrom(freeSpace, travel[0], cross, 1, travel[1]) >= travel[1];
}

/** Sorted container cross-edge coordinates per corridor axis (grid values, both edges). */
interface ContainerCrossEdgeTables {
  readonly x: Int32Array;
  readonly y: Int32Array;
}

function crossesParallelContainerBoundary(
  axis: Axis,
  cross: AxisSpan,
  containerCrossEdges: ContainerCrossEdgeTables,
): boolean {
  const edges = containerCrossEdges[axis];
  const low = upperBoundInt32(edges, cross[0]);
  return low < edges.length && edges[low] < cross[1];
}

function wallSpansOutsideTitle(
  entity: LayoutEntity,
  axis: Axis,
  boundary: number,
  span: AxisSpan,
  innerContainer: boolean,
): AxisSpan[] {
  if (!innerContainer || !entity.textPlacement) {
    return [span];
  }
  const title = entity.textPlacement;
  const titleCross: AxisSpan =
    axis === 'x'
      ? [entity.y + title.relativeY, entity.y + title.relativeY + title.height]
      : [entity.x + title.relativeX, entity.x + title.relativeX + title.width];
  if (titleCross[0] > boundary || titleCross[1] < boundary) {
    return [span];
  }
  const titleTravel: AxisSpan =
    axis === 'x'
      ? [entity.x + title.relativeX, entity.x + title.relativeX + title.width]
      : [entity.y + title.relativeY, entity.y + title.relativeY + title.height];
  return subtractSpan(span, titleTravel, 0);
}
