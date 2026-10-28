---
name: Layout connection routing
description: How routeConnections routes elbow, straight and arc connections and places their labels
targets:
  - ../packages/layout/src/routing/routeConnections.ts
  - ../packages/layout/src/routing/shiftRouting.ts
  - ../packages/layout/src/routing/directLine.ts
  - ../packages/layout/src/routing/executeCorridorRouting.ts
  - ../packages/layout/src/routing/fallbackConnection.ts
  - ../packages/layout/src/routing/textPlacements.ts
  - ../packages/layout/src/routing/manualLabelAnchor.ts
  - ../packages/layout/src/routing/corridor/**/*.ts
  - ../packages/layout/src/arcGeometry.ts
---

# Layout connection routing

`routeConnections` is the only routing entry point. A caller stages entity changes in a `LayoutManager`, then passes the connections to route. Each connection has a style. Elbow connections go to the corridor router. Straight and arc connections go to the direct-line logic. The caller does not filter connections by style.

```ts
type ConnectorStyle = 'elbow' | 'straight' | 'arc';

interface NewConnection {
  // existing fields: id, from, to, ports, arrowheads, label size, labelPlacement, ...
  readonly connectorStyle?: ConnectorStyle; // default 'elbow'
  readonly bend?: number; // arc only: signed distance from chord midpoint to apex
}

function routeConnections(args: {
  layoutManager: LayoutManager;
  repair: RepairPolicy; // false | { timeBudgetMs: number }
  connectionsToRoute?: readonly (NewConnection | ConnectionRoutingRequest)[];
  updates?: ReadonlyMap<string, LayoutChange>;
  allowShift?: boolean; // default true
  groupedPinnedPorts?: boolean;
  resolveEndpointPins?: (connection: NewConnection) => EndpointPins | undefined;
}): {
  updates: Map<string, LayoutConnectionChange>;
  fallbacks: ReadonlySet<string>;
};
```

`[@test] ../packages/layout/src/routing/__tests__/routeConnections.spec.ts`

## Which connections are routed

- Only the connections in `connectionsToRoute`, plus the connections that touch an entity in `updates`, are routed. All other connections keep their points. With neither selector, the call changes nothing. `[@test] ../packages/layout/src/routing/__tests__/routeConnections.spec.ts`
- With `allowShift` (default), a selected elbow connection keeps its existing path when its attachments and clearance are still valid. It is searched again only when the kept path is not valid. `[@test] ../packages/layout/src/routing/__tests__/shiftRouting.spec.ts`
- Explicit endpoint pins win over `resolveEndpointPins`. A bound pin keeps its face; a free pin can approach from any side. `[@test] ../packages/layout/src/routing/__tests__/corridor-bound-pin-approach.spec.ts`

## Style dispatch

- A connection with no `connectorStyle` routes as `elbow`. `[@test] ../packages/layout/src/routing/__tests__/routeConnections-styles.spec.ts`
- `straight` and `arc` connections never enter the corridor search. Their entities are still obstacles for elbow connections in the same call. `[@test] ../packages/layout/src/routing/__tests__/routeConnections-styles.spec.ts`

## Elbow routing

- The corridor router returns orthogonal paths that do not cross entities, with repair limited by `repair.timeBudgetMs`, or no repair when `repair` is `false`. `[@test] ../packages/layout/src/routing/__tests__/routing.spec.ts`
- When the corridor router cannot route a selected connection, the connection gets direct fallback geometry and its id is in `fallbacks`. `[@test] ../packages/layout/src/routing/__tests__/corridor-endpoint-fallback.spec.ts`

## Straight routing

- A connection with no stored path runs from center to center, clipped to each entity's outline (or bounding box when it has no outline). `[@test] ../packages/layout/src/routing/__tests__/directLine-straight.spec.ts`
- A bound end follows its entity when the entity moves: it keeps its relative anchor on the outline. A free end stays where it is. `[@test] ../packages/layout/src/routing/__tests__/directLine-straight.spec.ts`
- A pinned face puts that end on the face's port point, and the other end aims at it. `[@test] ../packages/layout/src/routing/__tests__/directLine-straight.spec.ts`

## Arc routing

An arc is a straight connection's two endpoints plus `bend`. The circle (center, radius, sweep) comes from the endpoints and `bend`, so it stays consistent when bound ends move.

- Endpoints follow the straight-routing rules above. `bend` is kept as stored. `[@test] ../packages/layout/src/routing/__tests__/directLine-arc.spec.ts`
- A `bend` with absolute value under 8 px (`ARC_BEND_SNAP_THRESHOLD`) is treated as straight. `[@test] ../packages/layout/src/routing/__tests__/directLine-arc.spec.ts`
- An arc with no stored `bend` uses `defaultBendForChord(start, end)`. `[@test] ../packages/layout/src/routing/__tests__/directLine-arc.spec.ts`
- When the endpoints are almost at the same point, the apex is attenuated (`getArcApex`) so the arc does not flip into a full loop. `[@test] ../packages/layout/src/routing/__tests__/directLine-arc.spec.ts`

## Labels

- Elbow: a stored `labelPlacement` stays where it is unless the router finds a clear spot on the line (`placeTextElement`). `[@test] ../packages/layout/src/routing/__tests__/textPlacements.spec.ts`
- Straight and arc, manual label (`lineOffset` set): the label keeps its place along the line and its offset from it after the line moves (`anchorFromStored`, `resolveManualLabel`). `[@test] ../packages/layout/src/routing/__tests__/manualLabelAnchor.spec.ts` `[@test] ../packages/layout/src/routing/__tests__/directLine-label.spec.ts`
- Straight and arc, automatic label: an arc's label centers on the apex. A straight line's label centers on the segment's middle, lifted clear when the segment is too short for it. `[@test] ../packages/layout/src/routing/__tests__/directLine-label.spec.ts`
- Placing a label again on request ignores the stored placement and uses the automatic place. `[@test] ../packages/layout/src/routing/__tests__/directLine-label.spec.ts`

## Golden outputs

- For every fixture in `fixtures/routing/`, `routeConnections` returns the recorded golden result (paths, label boxes, fallbacks). The goldens are recorded once, before the 0.5.0 change, from the reference implementation. `[@test] ../packages/layout/src/routing/__tests__/routing-goldens.spec.ts`
