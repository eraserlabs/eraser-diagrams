import type { Direction } from './types.js';
import type { LayoutManager } from './LayoutManager.js';
import type {
  LayoutEntity,
  NewEntity,
  LayoutOptions,
  LayoutConnection,
  NewConnection,
  LayoutRange,
} from './types.js';
import {
  getAxisForDirection,
  getOrthogonalDirection,
  getStartAndSizeForDirection,
  getStartAndEndFromObject,
} from './directionUtils.js';
import { getDimensions } from './sizeUtils.js';
import { MissingEntityError } from './LayoutError.js';
import { RankData } from './structure/ranks.js';

export type PositionArgs = Pick<
  NewEntity,
  'id' | 'placement' | 'width' | 'height' | 'containerId' | 'options'
>;

/**
 * Determines the new position for an entity. Handles the following cases:
 * 1. Fully new entity being added to top level or a group
 * 2. Existing entity being moved and / or re-parented
 * 3. Specifications of where to place the entity relative to another entity
 * @returns The new position and bump direction
 */
export function getPositionForEntity(
  layoutManager: LayoutManager,
  args: PositionArgs,
  rankData?: RankData,
  connections: readonly LayoutConnection[] | readonly NewConnection[] = [],
): { x: number; y: number; bumpDirection: Direction | Direction[] | null } {
  const axis = getAxisForDirection(layoutManager);
  let margin = layoutManager.getEntityOption(args, 'marginBetweenEntities');

  // A really simple heuristic for now - push it out a bit if it has a connection
  if (connections.length) {
    const textConnection = connections.find((c) => c.textPlacement);

    margin = textConnection
      ? layoutManager.options.minConnectionTextMargin * 2 + textConnection.textPlacement!.width
      : layoutManager.options.minConnectionLength;
  }

  if (args.placement?.afterId) {
    const afterEntity = layoutManager.getEntityById(args.placement?.afterId);

    if (!afterEntity) {
      throw new MissingEntityError('After entity not found', args.placement?.afterId);
    }

    // TODO: this does not account for diagrams that might go left or up (that is ok for now)
    if (axis === 'y') {
      return {
        x: centerAgainst(afterEntity.x, afterEntity.width, args.width),
        y: afterEntity.y + afterEntity.height + margin,
        bumpDirection: 'down',
      };
    }

    return {
      y: centerAgainst(afterEntity.y, afterEntity.height, args.height),
      x: afterEntity.x + afterEntity.width + margin,
      bumpDirection: 'right',
    };
  }

  if (args.placement?.displaceId) {
    const displacedEntity = layoutManager.getEntityById(args.placement?.displaceId);

    if (!displacedEntity) {
      throw new MissingEntityError('Displace entity not found', args.placement?.displaceId);
    }

    const displaceAxis = args.placement?.displaceDirection
      ? getAxisForDirection(args.placement?.displaceDirection)
      : axis;

    if (displaceAxis === 'y') {
      return {
        x: centerAgainst(displacedEntity.x, displacedEntity.width, args.width),
        y: displacedEntity.y,
        bumpDirection: 'down',
      };
    }

    return {
      y: centerAgainst(displacedEntity.y, displacedEntity.height, args.height),
      x: displacedEntity.x,
      bumpDirection: 'right',
    };
  }

  if (args.containerId) {
    const container = layoutManager.getEntityById(args.containerId);

    if (!container) {
      throw new MissingEntityError('Container does not exist', args.containerId);
    }

    return getPositionForEntityInContainer(layoutManager, container, args, rankData, margin);
  }

  // Edge case - adding first entity to the layout
  if (!layoutManager.getEntities().length) {
    return { ...layoutManager.origin, bumpDirection: null };
  }

  const dims = layoutManager.stagedDims;

  // If we have rankData, try to use rank-based positioning
  if (rankData) {
    const position = getPositionUsingRankData(layoutManager, args.id, rankData, dims, margin);
    if (position) {
      return { ...position, bumpDirection: null };
    }
  }

  // Fallback to default positioning
  if (axis === 'y') {
    return {
      x: Math.ceil(dims.midX - args.width / 2),
      y: dims.maxY + margin,
      bumpDirection: null,
    };
  }

  return {
    x: dims.maxX + margin,
    y: Math.ceil(dims.midY - args.height / 2),
    bumpDirection: null,
  };
}

export function getPositionForEntityInContainer(
  layoutManager: LayoutManager,
  container: LayoutEntity,
  args: PositionArgs,
  rankData?: RankData,
  margin: number = layoutManager.options.marginBetweenEntities,
): { x: number; y: number; bumpDirection: Direction[] | Direction | null } {
  const {
    orthogonalAxis,
    primaryAxis,
    primaryDirectionStart,
    primaryDirectionSize,
    orthogonalDirectionStart,
    orthogonalDirectionSize,
    sizeKey,
    orthogonalSizeKey,
  } = getStartAndSizeForDirection(layoutManager.primaryDirection, container);

  const options = layoutManager.getEntityOptions(container);
  const [primaryStartPadding, primaryEndPadding] = getStartAndEndFromObject(
    options.containerPadding,
    layoutManager.primaryDirection,
  );
  const [orthogonalStartPadding, orthogonalEndPadding] = getStartAndEndFromObject(
    options.containerPadding,
    orthogonalAxis,
  );

  // First, determine where to position the element in the orthogonal direction
  // (After all existing elements or at the start if there are none)
  let orthogonalStart: number | undefined;
  let primaryAxisStart: number | undefined;
  const childEntityIds = layoutManager.getChildIds(container.id);

  if (childEntityIds?.size) {
    // If we have children, put it after the last one
    const dims = getDimensions(layoutManager.getEntitiesById(childEntityIds));

    if (rankData) {
      const position = getPositionUsingRankData(layoutManager, args.id, rankData, dims, margin);

      if (position) {
        primaryAxisStart = position[primaryAxis];
        orthogonalStart = position[orthogonalAxis];
      }
    }

    if (orthogonalStart === undefined) {
      const containerEntityEnd = orthogonalAxis === 'x' ? dims.maxX : dims.maxY;
      orthogonalStart = containerEntityEnd + margin;
    }
  } else {
    // If not, put it at the beginning of the group, accounting for the proper padding
    orthogonalStart = orthogonalDirectionStart + orthogonalStartPadding;
  }

  const size = args[sizeKey];

  if (primaryAxisStart === undefined) {
    // Determine where to position the element in the primary direction
    // (Center against the primary axis, or put it at the start if centering is too big)
    primaryAxisStart = Math.max(
      centerAgainst(primaryDirectionStart, primaryDirectionSize, size),
      primaryDirectionStart + primaryStartPadding,
    );
  }

  const containerNeedsOrthogonalExpansion =
    orthogonalStart + args[orthogonalSizeKey] >
    orthogonalDirectionStart + orthogonalDirectionSize - orthogonalEndPadding;

  const containerNeedsPrimaryExpansion =
    primaryAxisStart! + size >
    primaryDirectionStart + primaryDirectionSize - primaryStartPadding - primaryEndPadding;

  let bumpDirection: Direction[] | Direction | null = null;

  if (containerNeedsPrimaryExpansion && containerNeedsOrthogonalExpansion) {
    bumpDirection = [
      getOrthogonalDirection(layoutManager.primaryDirection),
      layoutManager.primaryDirection,
    ];
  } else if (containerNeedsPrimaryExpansion) {
    bumpDirection = layoutManager.primaryDirection;
  } else if (containerNeedsOrthogonalExpansion) {
    bumpDirection = getOrthogonalDirection(layoutManager.primaryDirection);
  }

  return {
    [orthogonalAxis]: orthogonalStart,
    [primaryAxis]: primaryAxisStart,
    bumpDirection,
  } as { x: number; y: number; bumpDirection: Direction | null };
}

export function tryToDrawGroupAroundEntities(
  layoutManager: LayoutManager,
  entities: LayoutEntity[],
  options?: Partial<LayoutOptions>,
): { x: number; y: number; width: number; height: number } | null {
  if (!entities.length) {
    return null;
  }

  const dimensions = getDimensions(entities);
  const otherElements = layoutManager.findEntitiesInRange(dimensions, (e) => !entities.includes(e));

  // TODO: good heuristics here
  if (otherElements.length > entities.length) {
    return null;
  }

  const containerPadding = options?.containerPadding ?? layoutManager.options.containerPadding;

  return {
    x: dimensions.minX - containerPadding.left,
    y: dimensions.minY - containerPadding.top,
    width: dimensions.maxX - dimensions.minX + containerPadding.left + containerPadding.right,
    height: dimensions.maxY - dimensions.minY + containerPadding.top + containerPadding.bottom,
  };
}

/**
 * Attempts to position an entity using rank data.
 * Rules (all assuming primary direction is right):
 * 1. If we have other entities at this rank, line it up on the x axis and place it at the bottom
 * 2. If we have entities at the prior rank, put it just to the right and line it up with the top of the prior rank
 * @note This does not account for "chains" and wanting to keep those entities together.
 * In those cases, we want to grab the "in" connections and try to line it up with the prior entity.
 * This is where we basically get into writing our own layout algorithm.
 * @returns Position if successful, null if fallback should be used
 */
function getPositionUsingRankData(
  layoutManager: LayoutManager,
  id: string,
  rankData: RankData,
  dims: LayoutRange,
  margin: number,
): { x: number; y: number } | null {
  const rankedNode = rankData.rankedNodes[id];

  // If we couldn't find a new entity in the rank data, fall back to default
  if (!rankedNode) {
    return null;
  }

  const parent = rankData.parentMapping[id]?.[0];
  const ranksAtLevel = parent ? (rankData.rankedNodes[parent].childRanks ?? []) : rankData.ranks;

  // Get entities at the target rank (excluding the new entity itself)
  const rankEntities = layoutManager.getEntitiesById(
    ranksAtLevel[rankedNode.rank]?.nodes.map((n) => n.id) ?? [],
  );
  // Get entities at the prior rank
  const priorRankEntities = layoutManager.getEntitiesById(
    ranksAtLevel[rankedNode.rank - 1]?.nodes.map((n) => n.id) ?? [],
  );

  const axis = getAxisForDirection(layoutManager.primaryDirection);

  if (axis === 'y') {
    let y = dims.minY + margin;
    let x = dims.maxX + margin;

    if (rankEntities.length) {
      // If we have other entities at this rank, line it up. Otherwise put it at the back of the current entities.
      y = Math.min(...rankEntities.map((e) => e.y));
    } else if (priorRankEntities.length) {
      /** @todo This doesn't account for text placement */
      y = Math.max(...priorRankEntities.map((e) => e.y + e.height)) + margin;
      x = Math.min(...priorRankEntities.map((e) => e.x));
    }

    // Primary direction is vertical, so use same Y, but place at max X + margin
    return { x, y };
  } else {
    let x = dims.minX + margin;
    let y = dims.maxY + margin;

    if (rankEntities.length) {
      x = Math.min(...rankEntities.map((e) => e.x));
    } else if (priorRankEntities.length) {
      /** @todo This doesn't account for text placement */
      x = Math.max(...priorRankEntities.map((e) => e.x + e.width)) + margin;
      y = Math.min(...priorRankEntities.map((e) => e.y));
    }

    return { x, y };
  }
}

/**
 * Center a new entity relative to some existing entity
 * @returns The start point of the new entity
 */
export function centerAgainst(
  entityStart: number,
  entitySize: number,
  newEntitySize: number,
): number {
  return Math.ceil(entityStart + (entitySize - newEntitySize) / 2);
}
