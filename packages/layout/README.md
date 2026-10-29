# @eraserlabs/layout

## Introduction

`@eraserlabs/layout` is the layout package used by [`eraser-diagrams`](https://github.com/eraserlabs/eraser-diagrams). It holds all layout and routing logic: where entities go (placement, bumping, auto-layout, resize) and where connections go (routing and label placement). It can also be used independently as a connection router for diagrams whose entities have already been sized and positioned, with `@eraserlabs/utils` as its only dependency.

Its main routine is `routeConnections`. Each connection has a style. `elbow` connections (the default) go to the corridor router: it produces orthogonal routes, understands nested containers, avoids obstacles, and can route some or all connections in a diagram, respecting the current coordinates of lines that have already been routed. `straight` and `arc` connections are one direct segment between the entities' drawn boundaries; an arc adds a `bend`, the signed distance from the chord's middle to its apex. When an entity moves, a straight line's bound end glides along the outline and an arc's bound end keeps its place on the entity.

## Why

We could not find a standalone router for arbitrary nested diagrams that also supported partial routing. Existing options tend to be coupled to a complete graph-layout engine or editor, assume a flat diagram, or require every connection to be regenerated together.

`@eraserlabs/layout` treats entity placement as input. It routes connections around that existing geometry while allowing unaffected routes to remain fixed, which makes it suitable for both initial rendering, incremental edits, and fully interactive drag editing in a GUI editor.

## Usage

```ts
import {
  COMMIT_REPAIR,
  LayoutManager,
  routeConnections,
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
  {
    id: 'client-services',
    from: 'client',
    to: 'services',
    connectorStyle: 'arc',
    bend: 40,
  },
];

const layoutManager = new LayoutManager({ entities, connections: [] });

const { updates, fallbacks } = routeConnections({
  layoutManager,
  connectionsToRoute: connections,
  repair: COMMIT_REPAIR,
});

const route = layoutManager.getConnectionById('client-api');
```

`layoutManager` contains the positioned entities and any existing connections. Entity coordinates are absolute; `containerId` identifies nesting and `isContainer` identifies containers. `connectionsToRoute` selects the new or existing connections to route; alternatively, `updates` selects the connections that touch entities you moved in the manager's staged changes. `repair` limits how long the router spends improving routes: `false` for none, `{ timeBudgetMs }` for a time limit (`COMMIT_REPAIR` is 100 ms; `Infinity` makes the result independent of machine speed).

Connections that are not selected keep their points, which enables partial routing. A selected connection keeps its existing path when its attachments and clearance are still valid (`allowShift`, on by default). `updates` holds each routed connection's change, and `fallbacks` the ids of connections that got direct fallback geometry instead of a corridor route. Each polyline is an absolute `x` / `y` origin with relative `[x, y]` points.

Every module is also reachable by its path, for example `@eraserlabs/layout/routing/directLine` or `@eraserlabs/layout/arcGeometry`.
