import type { PositionProps } from '../../types.js';
import { type MeasuredLine, linePiercesRect, segmentPiercesRect } from './geometry.js';

export const ENTITY_CUT_INSET_PX = 4;

interface LeafRect {
  id: string;
  rect: PositionProps;
}

interface LabelPierces {
  pairs: Set<string>;
  lines: Set<string>;
}

function collectLabelPierces(lines: readonly MeasuredLine[]): LabelPierces {
  const pairs = new Set<string>();
  const piercingLines = new Set<string>();
  for (const line of lines) {
    for (const other of lines) {
      if (
        other.connId === line.connId ||
        !other.labelRect ||
        !linePiercesRect(line, other.labelRect)
      ) {
        continue;
      }
      pairs.add(`${line.connId}|${other.connId}`);
      piercingLines.add(line.connId);
    }
  }
  return { pairs, lines: piercingLines };
}

/** Directed pairs `piercing line|label owner`. */
export function labelPiercePairs(lines: readonly MeasuredLine[]): Set<string> {
  return collectLabelPierces(lines).pairs;
}

/** Grader-compatible count: each line that pierces at least one foreign label. */
export function pierceCount(lines: readonly MeasuredLine[]): number {
  return collectLabelPierces(lines).lines.size;
}

/** Cut pairs `connId|entityId` through leaf interiors; own terminal segments are exempt. */
export function entityCutPairs(
  lines: readonly MeasuredLine[],
  leaves: readonly LeafRect[],
): Set<string> {
  const pairs = new Set<string>();
  // The shrunken test rects are line-independent — build once, not per line ×
  // leaf (this runs per repair candidate).
  const shrink = ENTITY_CUT_INSET_PX;
  const shrunken: Array<{ id: string; rect: PositionProps }> = [];
  for (const entity of leaves) {
    const rect: PositionProps = {
      x: entity.rect.x + shrink,
      y: entity.rect.y + shrink,
      width: entity.rect.width - 2 * shrink,
      height: entity.rect.height - 2 * shrink,
    };
    if (rect.width > 0 && rect.height > 0) {
      shrunken.push({ id: entity.id, rect });
    }
  }
  for (const line of lines) {
    for (const entity of shrunken) {
      const rect = entity.rect;
      const own = entity.id === line.from || entity.id === line.to;
      const last = line.points.length - 2;
      for (let index = 0; index < line.points.length - 1; index++) {
        if (own && (index === 0 || index === last)) {
          continue;
        }
        if (segmentPiercesRect(line.points[index], line.points[index + 1], rect)) {
          pairs.add(`${line.connId}|${entity.id}`);
          break;
        }
      }
    }
  }
  return pairs;
}
