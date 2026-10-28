---
name: Render connections
description: How render converts a scene to layout input, calls routeConnections, and draws elbow, straight and arc connections
targets:
  - ../packages/render/src/browser/route.ts
  - ../packages/render/src/browser/roundedPath.ts
  - ../packages/render/src/browser/arcPath.ts
  - ../packages/render/src/browser/labelGap.ts
  - ../packages/render/src/scene.ts
  - ../packages/templates/src/schema/enums.ts
  - ../packages/templates/src/templates/Relationship/Relationship.schema.ts
---

# Render connections

Render does not make routing decisions. It converts resolved entities and connections to layout types, passes every connection to `routeConnections` in one call, and converts the result to `ConnectionGeometry` (`d`, `points`, `label`, `labelBox`).

## Input schema

- `CONNECTOR_STYLES` is `['elbow', 'straight', 'arc']`. A Relationship accepts `connectorStyle: 'arc'` and a numeric `bend`. `[@test] ../packages/templates/test/connectorStyle.test.ts`

## Conversion and routing call

- Render passes every connection to `routeConnections`, with its `connectorStyle` and `bend`. It does not keep a separate list of straight connections, and it does not decide itself whether to keep an authored path. `[@test] ../packages/render/test/route.test.ts`
- Render uses `{ timeBudgetMs: 100 }` as the repair policy. `[@test] ../packages/render/test/route.test.ts`
- Manual labels reach layout as stored placements with `lineOffset`. Render does not save and restore them around the routing call. `[@test] ../packages/render/test/route.test.ts`

## Drawing elbow and straight connections

- `d` is the routed polyline, with rounded corners for `cornerStyle: 'elbow'` (`toPathData`). `points` is the routed polyline. `[@test] ../packages/render/test/roundedPath.test.ts`

## Drawing arcs

- `d` is `M start A r r 0 largeArc sweep end`, on the circle that the endpoints and `bend` define (the same circle that layout's `arcGeometry` derives). `[@test] ../packages/render/test/arc.spec.ts`
- An arc whose `bend` is under 8 px draws as a straight segment. `[@test] ../packages/render/test/arc.spec.ts`
- `points` holds the sampled curve, so consumers that read `points` (label gap, hit tests, fit) work on the curve. `[@test] ../packages/render/test/arc.spec.ts`
- Arrowheads follow the tangent of the curve at each end, not the chord. `[@test] ../packages/render/test/arc.spec.ts`
- The label box is the one that layout returns (apex, or the manual anchor). `[@test] ../packages/render/test/arc.spec.ts`

## Label gap

- The stroke under a label is cut out with one mask on the anchor (`cutLabelGap`), never by a split of the path. Arrowheads stay whole. Nothing is cut when the label does not touch the line. `[@test] ../packages/render/test/label-gap.spec.ts`
- For an arc, the mask field covers the arc's bulge. `[@test] ../packages/render/test/label-gap.spec.ts`

## Golden outputs

- For every fixture in `fixtures/routing/`, the rendered SVG of each connection (`d`, label box, mask) matches the recorded golden. `[@test] ../packages/render/test/pipeline.spec.ts`
