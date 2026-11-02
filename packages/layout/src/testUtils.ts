import { getDimensions } from './sizeUtils.js';
import { LayoutEntity, LayoutConnection } from './types.js';
import { getFaceCenterPoint } from './portUtils.js';
import { getRelativePort } from './routing/points.js';

export const defaultRankScorer = (entity: LayoutEntity) => entity.x;

export function makeEntity(
  id: string,
  position: { x: number; y: number },
  options?: Partial<LayoutEntity>,
): LayoutEntity {
  return {
    id,
    x: position.x,
    y: position.y,
    width: 100,
    height: 50,
    ...options,
  };
}

export function makeGroup(id: string, entities: LayoutEntity[], padding = 20): LayoutEntity {
  // Update entities to have the group as their container
  for (const entity of entities) {
    entity.containerId = id;
  }

  const dimensions = getDimensions(entities);

  return {
    id,
    x: dimensions.minX - padding,
    y: dimensions.minY - padding,
    width: dimensions.maxX - dimensions.minX + padding * 2,
    height: dimensions.maxY - dimensions.minY + padding * 2,
    isContainer: true,
  };
}

export function makeConnection(
  fromEntity: LayoutEntity,
  toEntity: LayoutEntity,
  isVertical = false,
): LayoutConnection {
  const from = fromEntity.id;
  const to = toEntity.id;

  const fromDir = isVertical ? 'down' : 'right';
  const toDir = isVertical ? 'up' : 'left';

  const fromPort = getFaceCenterPoint(fromEntity, fromDir);
  const toPort = getFaceCenterPoint(toEntity, toDir);

  const deltaX = toPort[0] - fromPort[0];
  const deltaY = toPort[1] - fromPort[1];

  // Create points array. Uses only 2 points if a straight line, otherwise uses a simple 3-segment / 4-point path.
  const points: [number, number][] = [[0, 0]];
  if (isVertical) {
    if (deltaX === 0) {
      points.push([0, deltaY]);
    } else {
      points.push([0, deltaY / 2]);
      points.push([deltaX, deltaY / 2]);
      points.push([deltaX, deltaY]);
    }
  } else {
    if (deltaY === 0) {
      points.push([deltaX, 0]);
    } else {
      points.push([deltaX / 2, 0]);
      points.push([deltaX / 2, deltaY]);
      points.push([deltaX, deltaY]);
    }
  }

  return {
    id: `rel-${from}-${to}-forward`,
    from,
    to,
    x: fromPort[0],
    y: fromPort[1],
    relativeFromPort: getRelativePort(fromEntity, fromPort, fromDir),
    relativeToPort: getRelativePort(toEntity, toPort, toDir),
    points,
  };
}
