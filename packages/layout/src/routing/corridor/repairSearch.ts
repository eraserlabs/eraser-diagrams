import type { RouteSearchRequest } from './contract.js';
import { searchRoute, type RouteSearchResult } from './topology.js';
import type { CorridorWorld } from './world.js';

export type RepairSearch = ReturnType<typeof createRepairSearch>;

/**
 * One immutable world and request set per repair invocation. Searches depend on
 * their restrictions, not the incumbent's spacing; realized batches are never cached.
 * Callers keep the returned routes topology-only: realizeRoutes clones before writing.
 */
export function createRepairSearch(world: CorridorWorld) {
  const results = new Map<string, RouteSearchResult>();
  const metrics = { searches: 0, cacheHits: 0 };
  return {
    metrics,
    search(request: RouteSearchRequest, options: Parameters<typeof searchRoute>[2] = {}) {
      // Include endpoint values: face repair rebuilds identical pinned requests.
      // Preserve every option and collection's iteration order; different ordering
      // may miss reuse, but must never reuse a different search.
      const key = JSON.stringify([request, options], (_key, value) =>
        value instanceof Set || value instanceof Map ? [...value] : value,
      );
      const cached = results.get(key);
      if (cached) {
        metrics.cacheHits += 1;
        return cached;
      }
      const result = searchRoute(world, request, options);
      metrics.searches += 1;
      results.set(key, result);
      return result;
    },
  };
}
