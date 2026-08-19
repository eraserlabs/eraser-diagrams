export interface PointerHit {
  value: unknown;
  /** Concrete JSON pointer relative to the element (array `*` expanded to indices). */
  path: string;
  /** Replace the value at this location in place. No-op for a root ('') hit. */
  set(next: unknown): void;
}

/**
 * Resolve a policy pointer template against an element. A `*` segment expands over every index of an
 * array. Returns one hit per concrete location that exists, each with an in-place setter.
 */
export function resolvePointer(element: unknown, pointer: string): PointerHit[] {
  const segments = pointer === '' ? [] : pointer.split('/').slice(1).map(unescapePointerSegment);

  return walk(element, segments, '', undefined, undefined);
}

function walk(
  node: unknown,
  segments: string[],
  path: string,
  container: Record<string, unknown> | unknown[] | undefined,
  key: string | number | undefined,
): PointerHit[] {
  if (segments.length === 0) {
    return [
      {
        value: node,
        path,
        set(next: unknown): void {
          if (container !== undefined && key !== undefined) {
            (container as Record<string | number, unknown>)[key] = next;
          }
        },
      },
    ];
  }

  if (node === null || typeof node !== 'object') {
    return [];
  }

  const [head, ...rest] = segments;

  if (head === '*') {
    if (!Array.isArray(node)) {
      return [];
    }

    return node.flatMap((item, i) => walk(item, rest, `${path}/${i}`, node, i));
  }

  const k = head as string;

  if (!Object.hasOwn(node as object, k)) {
    return [];
  }

  return walk(
    (node as Record<string, unknown>)[k],
    rest,
    `${path}/${escapePointerSegment(k)}`,
    node as Record<string, unknown>,
    k,
  );
}

function unescapePointerSegment(seg: string): string {
  return seg.replace(/~1/g, '/').replace(/~0/g, '~');
}

function escapePointerSegment(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}
