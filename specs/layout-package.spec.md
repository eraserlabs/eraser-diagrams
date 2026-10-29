---
name: Layout package boundary
description: What @eraserlabs/layout exports, what it may import, and what 0.5 removes
targets:
  - ../packages/layout/src/index.ts
  - ../packages/layout/package.json
  - ../packages/layout/README.md
---

# Layout package boundary

`@eraserlabs/layout` holds layout state (`LayoutManager`) and connection routing: elbow, straight and arc lines, and label placement. It has no DOM and no browser code, and it runs the same in Node and in a browser bundle. Entity placement, bumping, auto-layout and resize are not part of the package: callers position entities, and layout routes the connections between them.

## Dependencies

- `packages/layout/src` imports no package except `@eraserlabs/utils`, and no `node:*` builtins. depcruise enforces this (`layout-imports-utils-only`, `layout-no-node-builtins`); CI runs `pnpm depcruise`.
- `packages/layout/package.json` lists exactly one runtime dependency, `@eraserlabs/utils`, and no peer dependencies. `[@test] ../packages/layout/src/__tests__/dependencies.spec.ts`
- depcruise (`pnpm depcruise`) reports no circular imports.

## Public exports

The root is the only entry point (`package.json` `exports` has only `"."`).

```ts
// layout state
export { LayoutManager } from './LayoutManager.js';
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
```

## Removed in 0.5

- `routeCorridorConnectionBatch` and its option and result types are removed. `routeConnections` replaces it.
- `straightConnectionEndpoints` and `StraightConnectionOptions` are removed. `routeConnections` routes straight lines.
- The release that ships this bumps the package to 0.5.0 and lists both removals in its notes.

## Type checking

- All package sources compile with `tsc -b` under `packages/layout/tsconfig.json` (strict, `NodeNext` with `.js` import suffixes; this package turns off `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `verbatimModuleSyntax` from the repo base).
