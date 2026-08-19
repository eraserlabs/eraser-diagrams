# @eraserlabs/layout

## Introduction

`@eraserlabs/layout` is the layout package used by [`eraser-diagrams`](https://github.com/eraserlabs/eraser-diagrams). It can also be used independently as a connection router for diagrams whose entities have already been sized and positioned, with `@eraserlabs/utils` as its only dependency.

Its main routine is the corridor router: it produces orthogonal routes, understands nested containers, avoids obstacles, and can route some or all connections in a diagram, respecting the current coordinates of lines that have already been routed.

For lines that should not travel around anything, `straightConnectionEndpoints` computes the two terminal points of a single direct segment between the entities' drawn boundaries — the centre-to-centre sight line clipped to each outline, or to the bounding box when an entity has none, with an authored face pinning its endpoint to that face's port. It is a standalone function rather than a routing mode: straight connections are held out of the corridor batch entirely, which is how `eraser-diagrams` implements `connectorStyle: 'straight'`.

## Why

We could not find a standalone router for arbitrary nested diagrams that also supported partial routing. Existing options tend to be coupled to a complete graph-layout engine or editor, assume a flat diagram, or require every connection to be regenerated together.

`@eraserlabs/layout` treats entity placement as input. It routes connections around that existing geometry while allowing unaffected routes to remain fixed, which makes it suitable for both initial rendering, incremental edits, and fully interactive drag editing in a GUI editor.

## Usage

```ts
import {
  LayoutManager,
  routeCorridorConnectionBatch,
  type LayoutEntity,
  type NewConnection,
} from '@eraserlabs/layout';

const entities: LayoutEntity[] = [
  { id: 'client', x: 0, y: 70, width: 120, height: 60 },
  {
    id: 'services',
    x: 220,
    y: 0,
    width: 320,
    height: 200,
    isContainer: true,
  },
  {
    id: 'api',
    containerId: 'services',
    x: 270,
    y: 70,
    width: 100,
    height: 60,
  },
];

const connections: NewConnection[] = [
  { id: 'client-api', from: 'client', to: 'api' },
];

const layoutManager = new LayoutManager({ entities, connections: [] });

routeCorridorConnectionBatch({
  layoutManager,
  connectionsToRoute: connections,
});

const route = layoutManager.getConnectionById('client-api');
```

`layoutManager` contains the positioned entities and any existing connections. Entity coordinates are absolute; `containerId` identifies nesting and `isContainer` identifies containers. `connectionsToRoute` selects the new or existing connections to route by their `from` and `to` entity IDs. The optional `options` field of the same argument object controls repair (`repair`, `repairTimeBudgetMs`), label placement (`labels`), port preservation (`preservePorts`), and whether unaffected routes are pinned (`pinUnaffectedRoutes`).

Existing connections not included in `connectionsToRoute` remain fixed by default, enabling partial routing. Pass every connection to reroute a complete diagram. Each result is `{ connectionId, status }`, where `status` is `'valid'` for a connection that received a corridor route and `'fallback'` for one that fell back to direct geometry; the resulting polyline is available from the manager as an absolute `x` / `y` origin with relative `[x, y]` points.
