import type { LayoutEntity } from '../../types.js';
import { LayoutManager } from '../../LayoutManager.js';
import type { RouteSearchRequest } from '../corridor/contract.js';
import { realizeRoutes } from '../corridor/realize.js';
import { buildCorridorWorld } from '../corridor/worldConstruction.js';
import { searchRoutes } from '../corridor/topology.js';

function leaf(id: string, x: number, y: number, width: number, height: number): LayoutEntity {
  return { id, x, y, width, height };
}

const request: RouteSearchRequest = {
  requestIndex: 0,
  from: { entityIndex: 0, face: 'right' },
  to: { entityIndex: 1, face: 'left' },
};

describe('routing corridor whole-pixel world grid', () => {
  it('snaps fractional entity edges into a routing-owned integer view', () => {
    const source = leaf('a', 10.4, 20.6, 40.2, 40.2);
    const target = leaf('b', 150.5, 20.1, 40, 40);
    const manager = new LayoutManager({ entities: [source, target], connections: [] });
    const world = buildCorridorWorld(manager, [request]);

    // The caller's entities are never mutated; routing snaps into its own copies.
    expect(source.x).toBe(10.4);
    expect(world.sourceEntities?.[0]).toBe(manager.getEntities()[0]);
    for (const entity of world.entities) {
      for (const value of [entity.x, entity.y, entity.width, entity.height]) {
        expect(Number.isInteger(value)).toBe(true);
      }
    }
    // Edges snap independently: x+width rounds as an edge, not as a size.
    expect(world.entities[0]).toMatchObject({ x: 10, y: 21, width: 41, height: 40 });

    for (const corridor of world.indexer.corridors) {
      const rect = corridor.rect;
      for (const value of [rect.x, rect.y, rect.width, rect.height]) {
        expect(Number.isInteger(value)).toBe(true);
      }
    }
  });

  it('reuses the caller view when the scene is already on-grid', () => {
    const manager = new LayoutManager({
      entities: [leaf('a', 0, 0, 40, 40), leaf('b', 150, 0, 40, 40)],
      connections: [],
    });
    const world = buildCorridorWorld(manager, [request]);
    expect(world.entities).toBe(manager.getEntities());
    expect(world.sourceEntities).toBe(world.entities);
  });

  it('re-anchors emitted terminals to the true entity faces, tracks staying on-grid', () => {
    const manager = new LayoutManager({
      entities: [leaf('a', 0, 0, 40.4, 40), leaf('b', 150, 0.3, 40, 40)],
      connections: [],
    });
    const world = buildCorridorWorld(manager, [request]);
    const [result] = searchRoutes(world, [request]);
    expect(result.fallback).toBe(false);
    const batch = realizeRoutes(world, [result.route]);
    const points = batch.routes[0].points();

    // Terminal face-normal coordinates float back to the unsnapped faces...
    expect(points[0].x).toBe(40.4);
    expect(points[points.length - 1].x).toBe(150);
    // ...while every other coordinate stays a whole-pixel grid value.
    for (const point of points.slice(1, -1)) {
      expect(Number.isInteger(point.x)).toBe(true);
      expect(Number.isInteger(point.y)).toBe(true);
    }
    expect(Number.isInteger(points[0].y)).toBe(true);
    expect(Number.isInteger(points[points.length - 1].y)).toBe(true);
  });
});
