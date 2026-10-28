---
name: Layout package boundary
description: What @eraserlabs/layout exports, what it may import, and what it removed in 0.5.0
targets:
  - ../packages/layout/src/index.ts
  - ../packages/layout/package.json
---

# Layout package boundary

`@eraserlabs/layout` holds all layout and routing logic: where boxes go (placement, bumping, auto-layout, resize) and where lines go (elbow, straight and arc routing, label placement). It has no DOM and no browser code, and it runs the same in Node and in a browser bundle.

## Dependencies

- `packages/layout/src` imports no package except `@eraserlabs/utils`. Any other bare import fails the guard test. `[@test] ../packages/layout/src/__tests__/dependencies.spec.ts`
- `packages/layout/package.json` lists exactly one runtime dependency, `@eraserlabs/utils`. `[@test] ../packages/layout/src/__tests__/dependencies.spec.ts`
- Types that a caller passes in (resize handle directions, snap guideline names) are defined in this package, not imported from a caller. `[@test] ../packages/layout/src/__tests__/exports.spec.ts`

## Public exports

The package exports at least these names from its root. The final list is the set of names that the package's callers import; the export test pins it.

```ts
// routing
export { routeConnections } from './routing/routeConnections.js';
export type {
  RouteConnectionsArgs,
  ConnectionRoutingRequest,
  EndpointPins,
  RoutingResult,
} from './routing/routeConnections.js';
export type { RepairPolicy } from './routing/executeCorridorRouting.js';
export {
  anchorFromStored,
  resolveManualLabel,
} from './routing/manualLabelAnchor.js';
// layout state and editing
export { LayoutManager } from './LayoutManager.js';
export { generateChanges, generateChangesForMove } from './calculateChanges.js';
export { makeRoomForEntities } from './bumpUtils.js';
export { getPositionForEntity } from './newPosition.js';
// geometry kept from 0.4.x
export { createEntityOutline, roundedCornerGeometry } from './outline.js';
```

`[@test] ../packages/layout/src/__tests__/exports.spec.ts`

## Removed in 0.5.0

- `routeCorridorConnectionBatch` and its option and result types are removed. `routeConnections` replaces it. `[@test] ../packages/layout/src/__tests__/exports.spec.ts`
- `straightConnectionEndpoints` and `StraightConnectionOptions` are removed. `routeConnections` routes straight lines. `[@test] ../packages/layout/src/__tests__/exports.spec.ts`
- The package version is 0.5.0 and the changelog lists both removals.

## Type strictness

- All package sources compile under the repo's `tsconfig.base.json` (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `NodeNext` with `.js` import suffixes). The check is `tsc -b` in CI.
