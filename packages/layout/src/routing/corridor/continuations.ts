export interface ContinuationBoundaryRef {
  readonly routeIndex: number;
  readonly afterVisitIndex: number;
}

export interface IndependentContinuationBoundary extends ContinuationBoundaryRef {}

export function continuationKey(routeIndex: number, afterVisitIndex: number): string {
  return `${routeIndex}:${afterVisitIndex}`;
}

export function continuationKeySet(refs: readonly ContinuationBoundaryRef[]): Set<string> {
  return new Set(refs.map((ref) => continuationKey(ref.routeIndex, ref.afterVisitIndex)));
}

/** Last write wins per boundary; output sorted by (routeIndex, afterVisitIndex). */
export function dedupeContinuations(
  continuations: readonly IndependentContinuationBoundary[],
): IndependentContinuationBoundary[] {
  const unique = new Map(
    continuations.map(
      (continuation) =>
        [
          continuationKey(continuation.routeIndex, continuation.afterVisitIndex),
          continuation,
        ] as const,
    ),
  );
  return [...unique.values()].sort(
    (left, right) =>
      left.routeIndex - right.routeIndex || left.afterVisitIndex - right.afterVisitIndex,
  );
}
