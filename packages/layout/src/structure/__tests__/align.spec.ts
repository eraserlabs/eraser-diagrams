import { LayoutManager } from '../../LayoutManager.js';
import { makeEntity, makeConnection, makeGroup } from '../../testUtils.js';
import { align } from '../align.js';

describe('align', () => {
  describe('sanity checks', () => {
    it('should handle single node layouts', () => {
      const entityA = makeEntity('A', { x: 0, y: 0 });

      const layoutManager = new LayoutManager({
        entities: [entityA],
        connections: [],
        primaryDirection: 'right',
      });

      const rankData = layoutManager.buildRanks();

      const result = align({ repair: false, layoutManager, rankData });

      expect(result.didChange).toBe(false);
    });

    it('should handle empty layouts', () => {
      const layoutManager = new LayoutManager({
        entities: [],
        connections: [],
        primaryDirection: 'right',
      });

      const rankData = layoutManager.buildRanks();

      const result = align({ repair: false, layoutManager, rankData });

      expect(result.didChange).toBe(false);
    });

    it('should handle ranks with single nodes', () => {
      // Create A -> B layout where each rank has only one node
      const entityA = makeEntity('A', { x: 0, y: 0 });
      const entityB = makeEntity('B', { x: 200, y: 0 });

      const layoutManager = new LayoutManager({
        entities: [entityA, entityB],
        connections: [makeConnection(entityA, entityB)],
        primaryDirection: 'right',
      });

      const rankData = layoutManager.buildRanks();

      const result = align({ repair: false, layoutManager, rankData });

      // Should not change anything since each rank has only one node
      expect(result.didChange).toBe(false);
    });
  });

  describe('simple linear flow (no alignment needed)', () => {
    it('should not change aligned linear layout', () => {
      // Create A -> B -> C where all nodes are already aligned
      const entityA = makeEntity('A', { x: 0, y: 0 });
      const entityB = makeEntity('B', { x: 200, y: 0 });
      const entityC = makeEntity('C', { x: 400, y: 0 });

      const layoutManager = new LayoutManager({
        entities: [entityA, entityB, entityC],
        connections: [makeConnection(entityA, entityB), makeConnection(entityB, entityC)],
        primaryDirection: 'right',
      });

      const rankData = layoutManager.buildRanks();

      const result = align({ repair: false, layoutManager, rankData });

      // Should not change anything since nodes are already aligned
      expect(result.didChange).toBe(false);
    });

    it('should not change aligned vertical layout', () => {
      // Create A -> B -> C where all nodes are already aligned vertically
      const entityA = makeEntity('A', { x: 0, y: 0 });
      const entityB = makeEntity('B', { x: 0, y: 100 });
      const entityC = makeEntity('C', { x: 0, y: 200 });

      const layoutManager = new LayoutManager({
        entities: [entityA, entityB, entityC],
        connections: [
          makeConnection(entityA, entityB, true),
          makeConnection(entityB, entityC, true),
        ],
        primaryDirection: 'down',
      });

      const rankData = layoutManager.buildRanks();

      const result = align({ repair: false, layoutManager, rankData });

      // Should not change anything since nodes are already aligned
      expect(result.didChange).toBe(false);
    });
  });

  describe('split with misalignment (should align)', () => {
    it('should align misaligned entities in horizontal layout', () => {
      // Create A -> B, A -> C where B and C are misaligned
      const entityA = makeEntity('A', { x: 0, y: 0 });
      const entityB = makeEntity('B', { x: 200, y: 0 });
      const entityC = makeEntity('C', { x: 250, y: 100 }); // Misaligned - should move to x: 200

      const layoutManager = new LayoutManager({
        entities: [entityA, entityB, entityC],
        connections: [makeConnection(entityA, entityB), makeConnection(entityA, entityC)],
        primaryDirection: 'right',
      });

      const rankData = layoutManager.buildRanks();

      const result = align({ repair: false, layoutManager, rankData });

      expect(result.didChange).toBe(true);

      // Check that C has been moved to align with B
      const finalEntityC = layoutManager.getEntityById('C');
      expect(finalEntityC?.x).toBe(200);
      expect(finalEntityC?.y).toBe(100); // Y should remain unchanged
    });

    it('should align misaligned entities in vertical layout', () => {
      // Create A -> B, A -> C where B and C are misaligned
      const entityA = makeEntity('A', { x: 0, y: 0 });
      const entityB = makeEntity('B', { x: 0, y: 100 });
      const entityC = makeEntity('C', { x: 150, y: 150 }); // Misaligned - should move to y: 100

      const layoutManager = new LayoutManager({
        entities: [entityA, entityB, entityC],
        connections: [
          makeConnection(entityA, entityB, true),
          makeConnection(entityA, entityC, true),
        ],
        primaryDirection: 'down',
      });

      const rankData = layoutManager.buildRanks();

      const result = align({ repair: false, layoutManager, rankData });

      expect(result.didChange).toBe(true);

      // Check that C has been moved to align with B
      const finalEntityC = layoutManager.getEntityById('C');
      expect(finalEntityC?.y).toBe(100);
      expect(finalEntityC?.x).toBe(150); // X should remain unchanged
    });

    it('should align multiple misaligned entities to the leftmost position', () => {
      // Create A -> B, A -> C, A -> D where B, C, D are at different x positions
      const entityA = makeEntity('A', { x: 0, y: 0 });
      const entityB = makeEntity('B', { x: 150, y: 75 }); // Leftmost
      const entityC = makeEntity('C', { x: 200, y: 150 }); // Should move to x: 150
      const entityD = makeEntity('D', { x: 250, y: 225 }); // Should move to x: 150

      const layoutManager = new LayoutManager({
        entities: [entityA, entityB, entityC, entityD],
        connections: [
          makeConnection(entityA, entityB),
          makeConnection(entityA, entityC),
          makeConnection(entityA, entityD),
        ],
        primaryDirection: 'right',
      });

      const rankData = layoutManager.buildRanks();

      const result = align({ repair: false, layoutManager, rankData });

      expect(result.didChange).toBe(true);

      // Check that C and D have been moved to align with B
      const finalEntityB = layoutManager.getEntityById('B');
      const finalEntityC = layoutManager.getEntityById('C');
      const finalEntityD = layoutManager.getEntityById('D');

      expect(finalEntityB?.x).toBe(150);
      expect(finalEntityC?.x).toBe(150);
      expect(finalEntityD?.x).toBe(150);

      // Y positions should remain unchanged
      expect(finalEntityB?.y).toBe(75);
      expect(finalEntityC?.y).toBe(150);
      expect(finalEntityD?.y).toBe(225);
    });
  });

  describe('split with alignment (do nothing)', () => {
    it('should not change entities that are already aligned', () => {
      // Create A -> B, A -> C where B and C are already aligned
      const entityA = makeEntity('A', { x: 0, y: 0 });
      const entityB = makeEntity('B', { x: 200, y: 50 });
      const entityC = makeEntity('C', { x: 200, y: 100 }); // Already aligned with B

      const layoutManager = new LayoutManager({
        entities: [entityA, entityB, entityC],
        connections: [makeConnection(entityA, entityB), makeConnection(entityA, entityC)],
        primaryDirection: 'right',
      });

      const rankData = layoutManager.buildRanks();

      // Store original positions
      const originalPositions = layoutManager.getEntities().map((entity) => ({
        id: entity.id,
        x: entity.x,
        y: entity.y,
      }));

      const result = align({ repair: false, layoutManager, rankData });

      expect(result.didChange).toBe(false);

      // Verify positions haven't changed
      const finalPositions = layoutManager.getEntities().map((entity) => ({
        id: entity.id,
        x: entity.x,
        y: entity.y,
      }));

      expect(finalPositions).toEqual(originalPositions);
    });
  });

  describe('split with orthogonal overlap (do nothing)', () => {
    it('should not align entities when it would cause overlap in horizontal layout', () => {
      // Create A -> B, A -> C where aligning C to B would cause overlap with an existing entity
      const entityA = makeEntity('A', { x: 0, y: 0 });
      const entityB = makeEntity('B', { x: 200, y: 0 });
      const entityC = makeEntity('C', { x: 250, y: 50 }); // Would move to x: 200, but there's a blocker
      const blocker = makeEntity('Blocker', { x: 200, y: 25 }); // Blocks the path from C to B's x position

      const layoutManager = new LayoutManager({
        entities: [entityA, entityB, entityC, blocker],
        connections: [makeConnection(entityA, entityB), makeConnection(entityA, entityC)],
        primaryDirection: 'right',
      });

      const rankData = layoutManager.buildRanks();

      // Store original position of C
      const originalCPosition = { x: entityC.x, y: entityC.y };

      align({ repair: false, layoutManager, rankData });

      // C should not move due to the blocker
      const finalEntityC = layoutManager.getEntityById('C');
      expect(finalEntityC?.x).toBe(originalCPosition.x);
      expect(finalEntityC?.y).toBe(originalCPosition.y);

      // B should still be able to stay in place
      const finalEntityB = layoutManager.getEntityById('B');
      expect(finalEntityB?.x).toBe(200);
    });

    it('should not align entities when it would cause overlap in vertical layout', () => {
      // Create A -> B, A -> C where aligning C to B would cause overlap with an existing entity
      const entityA = makeEntity('A', { x: 0, y: 0 });
      const entityB = makeEntity('B', { x: 0, y: 100 });
      const entityC = makeEntity('C', { x: 50, y: 150 }); // Would move to y: 100, but there's a blocker
      const blocker = makeEntity('Blocker', { x: 25, y: 100 }); // Blocks the path from C to B's y position

      const layoutManager = new LayoutManager({
        entities: [entityA, entityB, entityC, blocker],
        connections: [
          makeConnection(entityA, entityB, true),
          makeConnection(entityA, entityC, true),
        ],
        primaryDirection: 'down',
      });

      const rankData = layoutManager.buildRanks();

      // Store original position of C
      const originalCPosition = { x: entityC.x, y: entityC.y };

      align({ repair: false, layoutManager, rankData });

      // C should not move due to the blocker
      const finalEntityC = layoutManager.getEntityById('C');
      expect(finalEntityC?.x).toBe(originalCPosition.x);
      expect(finalEntityC?.y).toBe(originalCPosition.y);

      // B should still be able to stay in place
      const finalEntityB = layoutManager.getEntityById('B');
      expect(finalEntityB?.y).toBe(100);
    });

    it('should partially align when some entities can move but others cannot', () => {
      // Create A -> B, A -> C, A -> D where C can align but D cannot due to blocker
      const entityA = makeEntity('A', { x: 0, y: 0 });
      const entityB = makeEntity('B', { x: 200, y: 0 }); // Target alignment position
      const entityC = makeEntity('C', { x: 250, y: 100 }); // Can move to x: 200
      const entityD = makeEntity('D', { x: 300, y: 200 }); // Cannot move due to blocker
      const blocker = makeEntity('Blocker', { x: 220, y: 200 }); // Blocks D from moving to x: 200

      const layoutManager = new LayoutManager({
        entities: [entityA, entityB, entityC, entityD, blocker],
        connections: [
          makeConnection(entityA, entityB),
          makeConnection(entityA, entityC),
          makeConnection(entityA, entityD),
          makeConnection(entityD, blocker),
        ],
        primaryDirection: 'right',
      });

      const rankData = layoutManager.buildRanks();

      const result = align({ repair: false, layoutManager, rankData });

      expect(result.didChange).toBe(true);

      // C should move to align with B
      const finalEntityC = layoutManager.getEntityById('C');
      expect(finalEntityC?.x).toBe(200);

      // D should not move due to the blocker
      const finalEntityD = layoutManager.getEntityById('D');
      expect(finalEntityD?.x).toBe(300);
    });
  });

  describe('nested ranks - entities inside containers', () => {
    it('should align entities inside a container without being blocked by the container itself', () => {
      // Create entities B and C that need alignment, then group them in container G
      const entityA = makeEntity('A', { x: 0, y: 0 });
      const entityB = makeEntity('B', { x: 200, y: 0 });
      const entityC = makeEntity('C', { x: 250, y: 100 }); // Should align to x: 200

      // Create a proper group/container around B and C
      const containerG = makeGroup('G', [entityB, entityC], 25);

      const layoutManager = new LayoutManager({
        entities: [entityA, containerG, entityB, entityC],
        connections: [makeConnection(entityA, entityB), makeConnection(entityA, entityC)],
        primaryDirection: 'right',
      });

      const rankData = layoutManager.buildRanks();

      const result = align({ repair: false, layoutManager, rankData });

      expect(result.didChange).toBe(true);

      // C should move to align with B, even though they're inside container G
      const finalEntityC = layoutManager.getEntityById('C');
      expect(finalEntityC?.x).toBe(200);
      expect(finalEntityC?.y).toBe(100); // Y should remain unchanged
    });

    it('should align entities in vertical nested ranks without container interference', () => {
      // Create entities B and C that need vertical alignment, then group them
      const entityA = makeEntity('A', { x: 0, y: 0 });
      const entityB = makeEntity('B', { x: 0, y: 200 });
      const entityC = makeEntity('C', { x: 150, y: 250 }); // Should align to y: 200

      // Create a proper group/container around B and C
      const containerG = makeGroup('G', [entityB, entityC], 25);

      const layoutManager = new LayoutManager({
        entities: [entityA, containerG, entityB, entityC],
        connections: [
          makeConnection(entityA, entityB, true),
          makeConnection(entityA, entityC, true),
        ],
        primaryDirection: 'down',
      });

      const rankData = layoutManager.buildRanks();

      const result = align({ repair: false, layoutManager, rankData });

      expect(result.didChange).toBe(true);

      // C should move to align with B vertically
      const finalEntityC = layoutManager.getEntityById('C');
      expect(finalEntityC?.y).toBe(200);
      expect(finalEntityC?.x).toBe(150); // X should remain unchanged
    });

    it('should handle deeply nested containers without interference', () => {
      // Test nested containers: A -> G1 -> G2 -> B, C where B and C need alignment
      const entityA = makeEntity('A', { x: 0, y: 0 });
      const entityB = makeEntity('B', { x: 200, y: 0 });
      const entityC = makeEntity('C', { x: 275, y: 75 }); // Should align to x: 200
      const entityD = makeEntity('D', { x: 225, y: 200 }); // Should align to x: 200 after the outer groups are aligned
      const entityE = makeEntity('E', { x: 275, y: 275 }); // Should align to x: 200 after the outer groups are aligned

      const inner1 = makeGroup('Inner1', [entityB, entityC], 20);
      const inner2 = makeGroup('Inner2', [entityD, entityE], 20);
      const outer = makeGroup('Outer', [inner1, inner2], 20);

      const layoutManager = new LayoutManager({
        entities: [entityA, outer, inner1, inner2, entityB, entityC, entityD, entityE],
        connections: [makeConnection(entityA, inner1), makeConnection(entityA, inner2)],
        primaryDirection: 'right',
      });

      const rankData = layoutManager.buildRanks();

      const result = align({ repair: false, layoutManager, rankData });

      expect(result.didChange).toBe(true);

      // C should align with B despite being deeply nested
      const finalEntityC = layoutManager.getEntityById('C');
      expect(finalEntityC?.x).toBe(200);
      expect(finalEntityC?.y).toBe(entityC.y); // Y should remain unchanged

      // D should align with B despite being deeply nested
      const finalEntityD = layoutManager.getEntityById('D');
      expect(finalEntityD?.x).toBe(200);
      expect(finalEntityD?.y).toBe(entityD.y);

      // E should align with D despite being deeply nested
      const finalEntityE = layoutManager.getEntityById('E');
      expect(finalEntityE?.x).toBe(200);
      expect(finalEntityE?.y).toBe(entityE.y);

      // Inner1 and inner2 should be aligned
      const finalInner1 = layoutManager.getEntityById('Inner1');
      expect(finalInner1?.x).toBe(200 - 20);
      expect(finalInner1?.y).toBe(inner1.y);

      const finalInner2 = layoutManager.getEntityById('Inner2');
      expect(finalInner2?.x).toBe(200 - 20);
      expect(finalInner2?.y).toBe(inner2.y);
    });

    it('should not align when container boundaries would prevent proper alignment', () => {
      // Create scenario where alignment would be blocked by container constraints
      const entityA = makeEntity('A', { x: 0, y: 0 });
      const containerG = makeEntity(
        'G',
        { x: 180, y: -25 },
        {
          width: 100,
          height: 100,
          isContainer: true,
        },
      );
      const entityB = makeEntity('B', { x: 200, y: 0 }, { containerId: 'G' });
      const entityC = makeEntity('C', { x: 350, y: 50 }); // Outside container, far right
      const blocker = makeEntity('Blocker', { x: 220, y: 50 }); // Would block C from aligning with B

      const layoutManager = new LayoutManager({
        entities: [entityA, containerG, entityB, entityC, blocker],
        connections: [
          makeConnection(entityA, containerG),
          makeConnection(entityA, entityC),
          makeConnection(containerG, entityB),
        ],
        primaryDirection: 'right',
      });

      const rankData = layoutManager.buildRanks();

      // Store original positions
      const originalEntityC = { x: entityC.x, y: entityC.y };

      align({ repair: false, layoutManager, rankData });

      // C should not move due to the blocker
      const finalEntityC = layoutManager.getEntityById('C');
      expect(finalEntityC?.x).toBe(originalEntityC.x);
      expect(finalEntityC?.y).toBe(originalEntityC.y);

      // B should remain in its original position
      const finalEntityB = layoutManager.getEntityById('B');
      expect(finalEntityB?.x).toBe(200);
    });
  });

  describe('edge cases', () => {
    it('handles unconnected groups with a split', () => {
      // Arrange: create a container group at x=200 and another node at x=0 in the same rank
      const groupG = makeEntity(
        'G',
        { x: 150, y: -125 },
        { width: 100, height: 100, isContainer: true },
      );
      // Node A is within the vertical range of the container so it will act as a potential blocker
      const entityA = makeEntity('A', { x: 0, y: 50 });
      // Additional node B outside the vertical range (optional, but ensures multiple entities)
      const entityB = makeEntity('B', { x: 200, y: 0 });
      const entityC = makeEntity('C', { x: 200, y: 100 });

      // No connections – all entities will be placed in the same rank (rank 0)
      const layoutManager = new LayoutManager({
        entities: [groupG, entityA, entityB, entityC],
        connections: [makeConnection(entityA, entityB), makeConnection(entityA, entityC)],
        primaryDirection: 'right',
      });

      const rankData = layoutManager.buildRanks();

      // Act
      const result = align({ repair: false, layoutManager, rankData });

      // The group should be aligned at the start
      expect(result.didChange).toBe(true);
      const finalGroup = layoutManager.getEntityById('G');
      expect(finalGroup?.x).toBe(0);

      // The other entities should not move
      expect(layoutManager.getEntityById('A')?.x).toBe(0);
      expect(layoutManager.getEntityById('B')?.x).toBe(200);
      expect(layoutManager.getEntityById('C')?.x).toBe(200);
    });
  });

  describe('edge label overlap prevention', () => {
    it('should not align node when it would overlap labeled incoming connection', () => {
      // Complex flowchart structure based on real-world diagram:
      // Source1 -> Step1 -> Model1 -> Output1
      // Source1 -> Step2
      // Source2 -> Step2
      // Step2 -> Storage
      // Storage -> Processor: "Label"  <- labeled connection
      // Processor -> Result
      // Source1 -> Result

      const source1 = makeEntity('Source1', { x: 0, y: 0 });
      const source2 = makeEntity('Source2', { x: 0, y: 150 });
      const step1 = makeEntity('Step1', { x: 150, y: 0 });
      const step2 = makeEntity('Step2', { x: 150, y: 100 });
      const model1 = makeEntity('Model1', { x: 300, y: 0 });
      const storage = makeEntity('Storage', { x: 300, y: 100 });
      const output1 = makeEntity('Output1', { x: 450, y: 0 });
      const processor = makeEntity('Processor', { x: 500, y: 100 }); // Misaligned, would want to move to x: 450
      const result = makeEntity('Result', { x: 450, y: 200 });

      // Connection with label from Storage to Processor
      const storageToProcessor = makeConnection(storage, processor);
      storageToProcessor.textPlacement = {
        x: 460,
        y: 95,
        width: 80,
        height: 20,
      };

      const layoutManager = new LayoutManager({
        entities: [source1, source2, step1, step2, model1, storage, output1, processor, result],
        connections: [
          makeConnection(source1, step1),
          makeConnection(step1, model1),
          makeConnection(model1, output1),
          makeConnection(source1, step2),
          makeConnection(source2, step2),
          makeConnection(step2, storage),
          storageToProcessor,
          makeConnection(processor, result),
          makeConnection(source1, result),
        ],
        primaryDirection: 'right',
      });

      const rankData = layoutManager.buildRanks();
      const originalProcessorX = processor.x;

      align({ repair: false, layoutManager, rankData });

      // Processor should NOT move because it would overlap the "Label" on the incoming connection
      const finalProcessor = layoutManager.getEntityById('Processor');
      expect(finalProcessor?.x).toBe(originalProcessorX);

      // Output1 and Result should still be at their original x positions
      expect(layoutManager.getEntityById('Output1')?.x).toBe(450);
      expect(layoutManager.getEntityById('Result')?.x).toBe(450);
    });
  });
});
