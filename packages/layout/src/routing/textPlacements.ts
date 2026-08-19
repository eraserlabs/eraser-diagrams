import {
  makePropsFromRange,
  makeRangeForEntityTextPlacement,
  makeRangeFromEntity,
} from '../rangeUtils.js';
import type { LayoutEntity, LayoutRange, PositionProps } from '../types.js';

/** Gap between a label and the line when a manual perpendicular offset needs clearance. */
export const LABEL_LINE_GAP = 4;

export function isExternalTextPlacement(entity: LayoutEntity | undefined): boolean {
  if (!entity?.textPlacement) {
    return false;
  }

  return (
    entity.textPlacement.relativeX < 0 ||
    entity.textPlacement.relativeX >= entity.width ||
    entity.textPlacement.relativeY < 0 ||
    entity.textPlacement.relativeY >= entity.height
  );
}

export function makeExternalTextRange(entity: LayoutEntity | undefined): LayoutRange | undefined {
  return isExternalTextPlacement(entity) ? makeRangeForEntityTextPlacement(entity)! : undefined;
}

/** Join external text to its owning body so no unusable gap becomes a corridor. */
export function touchExternalTextRangeToEntity(entity: LayoutEntity): PositionProps | undefined {
  const textRange = makeExternalTextRange(entity);
  if (!textRange) {
    return undefined;
  }

  const entityRange = makeRangeFromEntity(entity);
  return makePropsFromRange({
    minX: textRange.minX > entityRange.maxX ? entityRange.maxX : textRange.minX,
    minY: textRange.minY > entityRange.maxY ? entityRange.maxY : textRange.minY,
    maxX: textRange.maxX < entityRange.minX ? entityRange.minX : textRange.maxX,
    maxY: textRange.maxY < entityRange.minY ? entityRange.minY : textRange.maxY,
  });
}

/**
 * Corridor obstacle view for a caption separated from one body face. Its outward depth,
 * including the visual gap, remains blocked while its cross-span is clipped to the
 * caption/body face overlap. Overlapping and diagonal external placements have no
 * unambiguous owning face, so they retain the conservative full blocker.
 */
export function touchExternalTextRangeToEntityClippedToBodyFace(
  entity: LayoutEntity,
): PositionProps | undefined {
  const textRange = makeExternalTextRange(entity);
  if (!textRange) {
    return undefined;
  }

  const entityRange = makeRangeFromEntity(entity);
  const overlapsHorizontalFace =
    Math.min(textRange.maxX, entityRange.maxX) > Math.max(textRange.minX, entityRange.minX);
  if (
    overlapsHorizontalFace &&
    (textRange.maxY <= entityRange.minY || textRange.minY >= entityRange.maxY)
  ) {
    return makePropsFromRange({
      minX: Math.max(textRange.minX, entityRange.minX),
      minY: textRange.maxY <= entityRange.minY ? textRange.minY : entityRange.maxY,
      maxX: Math.min(textRange.maxX, entityRange.maxX),
      maxY: textRange.maxY <= entityRange.minY ? entityRange.minY : textRange.maxY,
    });
  }

  const overlapsVerticalFace =
    Math.min(textRange.maxY, entityRange.maxY) > Math.max(textRange.minY, entityRange.minY);
  if (
    overlapsVerticalFace &&
    (textRange.maxX <= entityRange.minX || textRange.minX >= entityRange.maxX)
  ) {
    return makePropsFromRange({
      minX: textRange.maxX <= entityRange.minX ? textRange.minX : entityRange.maxX,
      minY: Math.max(textRange.minY, entityRange.minY),
      maxX: textRange.maxX <= entityRange.minX ? entityRange.minX : textRange.maxX,
      maxY: Math.min(textRange.maxY, entityRange.maxY),
    });
  }

  return touchExternalTextRangeToEntity(entity);
}
