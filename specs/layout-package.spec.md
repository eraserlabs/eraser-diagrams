---
name: Layout package boundary
description: What @eraserlabs/layout exports, what it may import, and what 0.5 removes
targets:
  - ../packages/layout/src/index.ts
  - ../packages/layout/package.json
  - ../packages/layout/README.md
---

# Layout package boundary

`@eraserlabs/layout` holds all layout and routing logic: where boxes go (placement, bumping, auto-layout, resize) and where lines go (elbow, straight and arc routing, label placement). It has no DOM and no browser code, and it runs the same in Node and in a browser bundle.

## Dependencies

- `packages/layout/src` imports no package except `@eraserlabs/utils`, and no `node:*` builtins. depcruise enforces this (`layout-imports-utils-only`, `layout-no-node-builtins`); CI runs `pnpm depcruise`.
- `packages/layout/package.json` lists exactly one runtime dependency, `@eraserlabs/utils`, and no peer dependencies. `[@test] ../packages/layout/src/__tests__/dependencies.spec.ts`
- The routing modules never reach editing code (`calculateChanges`, `bumpUtils`, `overlaps`, `structure/*` and the other editing helpers), directly or through other modules. depcruise enforces this (`layout-routing-no-editing`).
- Types that a caller passes in (resize handle directions, snap guideline names) are defined in this package, not imported from a caller. A type import from another package does not compile, because layout declares no other dependency.
- depcruise (`pnpm depcruise`) reports no circular imports.

## Public exports

The root exports the main API; every other module is reachable by its subpath, for example `@eraserlabs/layout/routing/directLine` (`package.json` `exports` has `"./*"`).

```ts
// layout state and editing
export { LayoutManager } from './LayoutManager.js';
export { generateChanges, generateChangesForMove } from './calculateChanges.js';
export { makeRoomForEntities } from './bumpUtils.js';
export { getPositionForEntity } from './newPosition.js';
// routing
export {
  COMMIT_REPAIR,
  isDirectConnection,
  routeConnections,
} from './routing/routeConnections.js';
export type { RepairPolicy } from './routing/executeCorridorRouting.js';
export {
  anchorFromStored,
  resolveManualLabel,
} from './routing/manualLabelAnchor.js';
// arc geometry
export {
  ARC_BEND_SNAP_THRESHOLD,
  defaultBendForChord,
  getArcApex,
  getArcPathD,
  getArcPolyline,
  isArcBend,
} from './arcGeometry.js';
// geometry kept from 0.4
export {
  intersectRanges,
  makeRangeFromEntity /* and the other 0.4 range helpers */,
} from './rangeUtils.js';
export { createEntityOutline, roundedCornerGeometry } from './outline.js';
export { GUIDELINE_NAME } from './types.js';
```

## Removed in 0.5

- `routeCorridorConnectionBatch` and its option and result types are removed. `routeConnections` replaces it.
- `straightConnectionEndpoints` and `StraightConnectionOptions` are removed. `routeConnections` routes straight lines.
- The release that ships this bumps the package to 0.5.0 and lists both removals in its notes.

## Type checking

- All package sources compile with `tsc -b` under `packages/layout/tsconfig.json` (strict, `NodeNext` with `.js` import suffixes; this package turns off `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `verbatimModuleSyntax` from the repo base).
