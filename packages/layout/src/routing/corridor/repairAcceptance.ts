import { authoredEndpointsIntact } from './leafCuts.js';
import type { Route } from './route.js';

/**
 * The one identity veto every repair phase applies alongside the shared
 * compareRoutingQualityCosts gate when it accepts a realized candidate.
 *
 * The shared comparator ranks tiered magnitudes only. It cannot distinguish
 * which leaf a cut pierces, and it does not encode authored endpoint identity.
 * A candidate may therefore keep or remove inherited cuts but may never add a
 * cut key, and it must keep every authored endpoint on its track.
 */
export function violatesRepairIdentity(
  candidateRoutes: readonly Route[],
  candidateLeafCuts: ReadonlySet<number>,
  incumbentLeafCuts: ReadonlySet<number>,
): boolean {
  for (const cut of candidateLeafCuts) {
    if (!incumbentLeafCuts.has(cut)) {
      return true;
    }
  }
  return !authoredEndpointsIntact(candidateRoutes);
}
