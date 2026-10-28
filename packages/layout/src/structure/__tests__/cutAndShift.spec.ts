import { buildLayoutRanks } from '../ranks.js';
import { LayoutManager } from '../../LayoutManager.js';
import { makeEntity, makeConnection } from '../../testUtils.js';
import { cutAndShift } from '../cutAndShift.js';

describe('cutAndShift', () => {
  describe('sanity checks', () => {
    it('should handle single node layouts', () => {
      const entityA = makeEntity('A', { x: 0, y: 0 });

      const layoutManager = new LayoutManager({
        entities: [entityA],
        connections: [],
        primaryDirection: 'right',
      });

      const rankData = buildLayoutRanks(layoutManager);

      const result = cutAndShift({ repair: false, layoutManager, rankData, idealAspectRatio: 1.0 });

      expect(result.didChange).toBe(false);
    });

    it('should handle empty layouts', () => {
      const layoutManager = new LayoutManager({
        entities: [],
        connections: [],
        primaryDirection: 'right',
      });

      const rankData = buildLayoutRanks(layoutManager);

      const result = cutAndShift({ repair: false, layoutManager, rankData, idealAspectRatio: 1.0 });

      expect(result.didChange).toBe(false);
    });

    it('should return no change when no valid cuts are possible', () => {
      // Create a simple A -> B layout (only 2 ranks, no valid cuts)
      const { entities, connections } = makeHorizontalLayout(2, 150);
      // Add a split by making another entity in rank 1 and connect it to the start
      entities.push(makeEntity('Node2', { x: entities[1].x, y: entities[1].y + 100 }));
      connections.push(makeConnection(entities[0], entities[2]));

      const layoutManager = new LayoutManager({
        entities,
        connections,
        primaryDirection: 'right',
      });

      const rankData = buildLayoutRanks(layoutManager);

      const result = cutAndShift({ repair: false, layoutManager, rankData, idealAspectRatio: 1.0 });

      expect(result.didChange).toBe(false);
      expect(result.cutPoints).toEqual([]);
    });

    it('should handle different ideal aspect ratios', () => {
      const { layoutManager, rankData } = makeHorizontalLayout(8);

      const resultSquare = cutAndShift({
        repair: false,
        layoutManager,
        rankData,
        idealAspectRatio: 0.25,
      });

      // Reset layout manager for second test
      layoutManager.clearStagedChanges();

      const resultWide = cutAndShift({
        repair: false,
        layoutManager,
        rankData,
        // Note - because our test util entities are pretty flat and long, we need an exagerated aspect ratio
        idealAspectRatio: 2.0,
      });

      // Different ideal ratios should produce different costs
      expect(resultSquare.cutPoints).not.toEqual(resultWide.cutPoints);
    });
  });

  describe('simple linear layouts', () => {
    it('should find optimal cuts for a linear layout when beneficial', () => {
      // Create A -> B -> C -> D layout (very wide, should benefit from cutting)
      const { layoutManager, rankData } = makeHorizontalLayout(6, 200);
      const bounds = layoutManager.getDims();

      const result = cutAndShift({
        repair: false,
        layoutManager,
        rankData,
        idealAspectRatio: 1.0, // Want square layout
      });

      // Should find a solution better than the baseline (which would be very wide)
      const baselineAspectRatio = (bounds.maxX - bounds.minX) / (bounds.maxY - bounds.minY);
      const baselineCost = Math.abs(baselineAspectRatio - 1.0);

      expect(result.cost).toBeLessThan(baselineCost);
      expect(result.cost).toBeGreaterThanOrEqual(0);
      expect(result.didChange).toBe(true);
      expect(result.cutPoints.length).toBeGreaterThan(0);
    });
  });

  describe('valid cut detection', () => {
    it('should handle complex layouts with multiple outputs', () => {
      // Create a layout where A has multiple outputs
      const entityA = makeEntity('A', { x: 0, y: 0 });
      const entityB = makeEntity('B', { x: 200, y: 0 });
      const entityC = makeEntity('C', { x: 200, y: 100 });
      const entityD = makeEntity('D', { x: 400, y: 50 });

      const layoutManager = new LayoutManager({
        entities: [entityA, entityB, entityC, entityD],
        connections: [
          makeConnection(entityA, entityB),
          makeConnection(entityA, entityC),
          makeConnection(entityB, entityD),
          makeConnection(entityC, entityD),
        ],
        primaryDirection: 'right',
      });

      const rankData = buildLayoutRanks(layoutManager);

      const result = cutAndShift({ repair: false, layoutManager, rankData, idealAspectRatio: 1.0 });

      expect(result.didChange).toBe(false);
    });

    it('should allow cuts when ranks have single outputs', () => {
      const { layoutManager, rankData } = makeHorizontalLayout(6, 150);

      const result = cutAndShift({
        repair: false,
        layoutManager,
        rankData,
        idealAspectRatio: 1.0,
        maxCuts: 2,
      });

      expect(result.didChange).toBe(true);
      expect(result.cost).toBeGreaterThanOrEqual(0);
      expect(result.cutPoints.length).toBeGreaterThan(0);
    });
  });

  describe('layout optimization', () => {
    it('should prefer no cuts when current layout is close to ideal', () => {
      const { layoutManager, rankData } = makeHorizontalLayout(2, 150);

      const result = cutAndShift({ repair: false, layoutManager, rankData, idealAspectRatio: 2.0 });

      // Cost should be low since we're already close to ideal
      expect(result.didChange).toBe(false);
    });

    it('should find cuts that improve aspect ratio', () => {
      // Create a very wide layout that would benefit from multiple rows
      const { layoutManager, rankData } = makeHorizontalLayout(6, 150);

      const result = cutAndShift({
        repair: false,
        layoutManager,
        rankData,
        idealAspectRatio: 1.0,
        maxCuts: 2,
      });

      expect(result.didChange).toBe(true);
      expect(result.cutPoints.length).toBe(2);
    });
  });

  describe('shifts', () => {
    it('should actually apply shifts when optimal solution is found', () => {
      const { layoutManager, rankData } = makeHorizontalLayout(4, 150);
      // Store original positions
      const originalPositions = layoutManager.getEntities().map((entity) => ({
        id: entity.id,
        x: entity.x,
        y: entity.y,
      }));

      const result = cutAndShift({
        repair: false,
        layoutManager,
        rankData,
        idealAspectRatio: 1.0,
        maxCuts: 1,
      });

      // If a shift was applied, some entities should have moved
      const finalPositions = layoutManager.getEntities().map((entity) => ({
        id: entity.id,
        x: entity.x,
        y: entity.y,
      }));

      if (result.didChange) {
        // At least some entities should have different positions
        const hasMovement = originalPositions.some(
          (orig, i) => orig.x !== finalPositions[i].x || orig.y !== finalPositions[i].y,
        );
        expect(hasMovement).toBe(true);
      }
    });

    it('should shift entities to new rows', () => {
      const { layoutManager, rankData } = makeHorizontalLayout(6, 150);

      cutAndShift({ repair: false, layoutManager, rankData, idealAspectRatio: 2.0 });

      const finalBounds = layoutManager.getDims();
      const finalEntities = layoutManager.getEntities();

      expect(finalBounds).toMatchObject({ minX: 0, minY: 0, maxX: 400, maxY: 150 });
      expect(finalEntities[0]).toMatchObject({ x: 0, y: 0 });
      expect(finalEntities[1]).toMatchObject({ x: 150, y: 0 });
      expect(finalEntities[2]).toMatchObject({ x: 300, y: 0 });
      expect(finalEntities[3]).toMatchObject({ x: 0, y: 100 });
      expect(finalEntities[4]).toMatchObject({ x: 150, y: 100 });
      expect(finalEntities[5]).toMatchObject({ x: 300, y: 100 });
    });
  });

  describe('primary direction handling', () => {
    it('should handle vertical layouts (DOWN direction)', () => {
      const { layoutManager, rankData } = makeVerticalLayout(6, 150);

      const result = cutAndShift({
        repair: false,
        layoutManager,
        rankData,
        idealAspectRatio: 1.0,
        maxCuts: 1,
      });

      expect(result.didChange).toBe(true);
      expect(result.cost).toBeGreaterThanOrEqual(0);
    });
  });
});

/**
 * Helper function to create simple linear layouts for testing
 */
function makeHorizontalLayout(count: number, spacing = 150) {
  const entities = Array.from({ length: count }, (_, i) =>
    makeEntity(`Node${i}`, { x: i * spacing, y: 0 }),
  );

  const connections = Array.from({ length: count - 1 }, (_, i) =>
    makeConnection(entities[i], entities[i + 1]),
  );

  const layoutManager = new LayoutManager({
    entities,
    connections,
    primaryDirection: 'right',
  });

  const rankData = buildLayoutRanks(layoutManager);

  return { layoutManager, entities, connections, rankData };
}

function makeVerticalLayout(count: number, spacing = 150) {
  const entities = Array.from({ length: count }, (_, i) =>
    makeEntity(`Node${i}`, { x: 0, y: i * spacing }),
  );

  const connections = Array.from({ length: count - 1 }, (_, i) =>
    makeConnection(entities[i], entities[i + 1], true),
  );

  const layoutManager = new LayoutManager({
    entities,
    connections,
    primaryDirection: 'down',
  });

  const rankData = buildLayoutRanks(layoutManager);

  return { layoutManager, entities, connections, rankData };
}
