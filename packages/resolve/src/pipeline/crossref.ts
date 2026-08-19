import type { Issue } from '../result-types.js';
import { ERROR_CODE, SEVERITY } from '../result-types.js';
import type { PolicyEntry } from '../types.js';
import { quote } from '../schema/errors.js';
import type { PipelineElement } from './element.js';
import { entityIsContainer } from './container.js';
import { resolvePointer } from './pointer.js';

export interface CrossrefResult {
  errors: Issue[];
  warnings: Issue[];
}

/**
 * Detects duplicate ids, unresolved references, references that point at a connection instead of
 * a node, `containerId` targeting a non-container, and cyclic containment (`containerId`
 * chains, self-reference included). Self-referencing connections are allowed.
 */
export function stageCrossref(
  items: readonly PipelineElement[],
  policyTables: Record<string, PolicyEntry[]>,
  containers: ReadonlySet<string>,
): CrossrefResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];

  // Pass 1 — id index + duplicate detection.
  const idToKind = new Map<string, string>();
  const idIsContainer = new Map<string, boolean>();

  for (const { index, path, tag, kind, element } of items) {
    const id = element.id;

    if (typeof id !== 'string') {
      continue;
    }

    if (idToKind.has(id)) {
      errors.push({
        code: ERROR_CODE.DUPLICATE_ID,
        severity: SEVERITY.ERROR,
        path: `${path}/id`,
        elementIndex: index,
        tag,
        elementId: id,
        message: `Duplicate element id ${quote(id)}.`,
      });

      continue;
    }

    idToKind.set(id, kind);
    idIsContainer.set(id, entityIsContainer(element, tag, containers));
  }

  // Pass 2 — reference resolution.
  for (const { index, path: elementPath, tag, element } of items) {
    const refEntries = (policyTables[tag] ?? []).filter((e) => e.kind === 'ref');

    for (const entry of refEntries) {
      for (const { value, path } of resolvePointer(element, entry.pointer)) {
        if (typeof value !== 'string') {
          continue;
        }

        const targetKind = idToKind.get(value);
        const fullPath = `${elementPath}${path}`;

        if (targetKind === undefined) {
          errors.push({
            code: ERROR_CODE.MISSING_REF,
            severity: SEVERITY.ERROR,
            path: fullPath,
            elementIndex: index,
            tag,
            message: `Reference ${quote(value)} at ${fullPath} does not resolve to any element.`,
          });
        } else if (targetKind === 'connection') {
          errors.push({
            code: ERROR_CODE.REF_TO_CONNECTION,
            severity: SEVERITY.ERROR,
            path: fullPath,
            elementIndex: index,
            tag,
            message: `Reference ${quote(value)} at ${fullPath} points at a connection, not a node.`,
          });
        } else if (path === '/containerId' && idIsContainer.get(value) !== true) {
          errors.push({
            code: ERROR_CODE.NOT_CONTAINER,
            severity: SEVERITY.ERROR,
            path: fullPath,
            elementIndex: index,
            tag,
            message: `Reference ${quote(value)} at ${fullPath} is not a container.`,
          });
        }
      }
    }
  }

  // Pass 3 — containment must be acyclic. Walking each element's containerId chain and erroring
  // only when the walk returns to its start reports every cycle member exactly once (a
  // self-reference is a length-1 cycle).
  const parentById = new Map<string, string>();

  for (const { element } of items) {
    if (typeof element.id === 'string' && typeof element.containerId === 'string') {
      parentById.set(element.id, element.containerId);
    }
  }

  for (const { index, path, tag, element } of items) {
    const id = element.id;

    if (typeof id !== 'string' || !parentById.has(id)) {
      continue;
    }

    const seen = new Set<string>([id]);
    let current = parentById.get(id);

    while (current !== undefined) {
      if (current === id) {
        errors.push({
          code: ERROR_CODE.CONTAINER_CYCLE,
          severity: SEVERITY.ERROR,
          path: `${path}/containerId`,
          elementIndex: index,
          tag,
          elementId: id,
          message: `Containment cycle: ${quote(id)} is inside its own containerId chain.`,
        });
        break;
      }

      if (seen.has(current)) {
        break;
      }

      seen.add(current);
      current = parentById.get(current);
    }
  }

  return { errors, warnings };
}
