---
name: Layout editing
description: Placement, bumping, moves, resize and auto-layout of entities in a LayoutManager
targets:
  - ../packages/layout/src/LayoutManager.ts
  - ../packages/layout/src/calculateChanges.ts
  - ../packages/layout/src/bumpUtils.ts
  - ../packages/layout/src/newPosition.ts
  - ../packages/layout/src/moveUtils.ts
  - ../packages/layout/src/mergeOps.ts
  - ../packages/layout/src/sortOps.ts
  - ../packages/layout/src/modifyUtils.ts
  - ../packages/layout/src/sizeUtils.ts
  - ../packages/layout/src/overlaps.ts
  - ../packages/layout/src/resize.ts
  - ../packages/layout/src/resizeSnap.ts
  - ../packages/layout/src/structure/**/*.ts
---

# Layout editing

These functions decide where entities go. They stage changes in a `LayoutManager` and call `routeConnections` for the connections that the changes touch. Routing never calls them.

## Layout state

- `LayoutManager` holds entities, connections and text placements, and supports checkpoints that restore an earlier state. `[@test] ../packages/layout/src/__tests__/layoutManager.spec.ts` `[@test] ../packages/layout/src/__tests__/layoutManagerCheckpoint.spec.ts`
- The routing modules do not import editing modules. `buildRanks` is a function in `structure/ranks.ts`, not a `LayoutManager` method, and the overlap check that `sizeUtils.ts` uses lives in a module that does not import `calculateChanges.ts`. `[@test] ../packages/layout/src/__tests__/dependencies.spec.ts`

## Placement and bumping

- `generateChanges` places new entities, bumps siblings out of overlaps (unless `noBumping`), grows parent containers, and routes the touched connections. `[@test] ../packages/layout/src/__tests__/calculateChanges.spec.ts`
- `generateChangesForMove` moves entities by a delta, bumps nothing, and routes the touched connections. It returns only the changes for this step. `[@test] ../packages/layout/src/__tests__/calculateChanges.spec.ts`
- `makeRoomForEntities` pushes other entities away from new, expanded or moved entities. `[@test] ../packages/layout/src/__tests__/bumpUtils.spec.ts`
- Container sizes grow to fit their children. `[@test] ../packages/layout/src/__tests__/sizeUtils.spec.ts`
- Staged moves and adds are merged and sorted before they apply. `[@test] ../packages/layout/src/__tests__/sortOps.spec.ts`

## Auto-layout

- Ranks (levels) come from the connection graph; unjustified edges are removed before ranking. `[@test] ../packages/layout/src/structure/__tests__/buildRanks.spec.ts` `[@test] ../packages/layout/src/structure/__tests__/removeUnjustifiedEdges.spec.ts` `[@test] ../packages/layout/src/structure/__tests__/visualRanks.spec.ts`
- `align` aligns entities across ranks, and `cutAndShift` wraps long rows toward a target aspect ratio. `[@test] ../packages/layout/src/structure/__tests__/align.spec.ts` `[@test] ../packages/layout/src/structure/__tests__/cutAndShift.spec.ts`
- `alignmentMoves` aligns whole selection units, and `distributionMoves` makes equal gaps between units ordered by their centers (or spaces their centers when they overlap, with the outer units fixed). `[@test] ../packages/layout/src/__tests__/arrange.spec.ts`
