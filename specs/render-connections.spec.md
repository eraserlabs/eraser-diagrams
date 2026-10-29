---
name: Render connections
description: How render converts a scene to layout input, calls routeConnections, and draws elbow, straight and arc connections
targets:
  - ../packages/render/src/browser/route.ts
  - ../packages/render/src/browser/index.ts
  - ../packages/render/src/browser/types.ts
  - ../packages/render/src/browser/roundedPath.ts
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

- Render passes every connection whose endpoints resolve to `routeConnections`, with its `connectorStyle` (an unknown value is `elbow`), `bend`, authored points and label. It does not keep a separate list of straight connections, and it does not decide itself whether to keep an authored path. `[@test] ../packages/render/test/route.test.ts`
- A stored label placement goes to layout as is, with `textLineOffset` when the label was placed by hand; a measured label with no stored placement passes only its size. Render does not save and restore manual labels around the routing call. `[@test] ../packages/render/test/route.test.ts`
- The repair policy comes from the caller (`RunRequest.repair`). Absent, repair has no time limit, so the same request always routes the same way. `[@test] ../packages/render/test/route.test.ts`

## Drawing elbow and straight connections

- `d` is the routed polyline, with rounded corners for `cornerStyle: 'elbow'` (`toPathData`). `points` is the routed polyline. `[@test] ../packages/render/test/roundedPath.test.ts`

## Drawing arcs

- `d` is `M start A r r 0 largeArc sweep end`, on the circle that the endpoints and `bend` define (`getArcPathD` from layout). An arc with no `bend` uses the default bow for its chord. `[@test] ../packages/render/test/arc.test.ts`
- An arc whose `bend` is under 8 px draws as a straight segment. `[@test] ../packages/render/test/arc.test.ts`
- `points` holds the sampled curve, so consumers that read `points` (label gap, scene box) work on the curve. `[@test] ../packages/render/test/arc.test.ts`
- Arrowheads are SVG markers with `orient="auto-start-reverse"` on the path, so on an arc they follow the curve's tangent, not the chord.
- The label box is the one that layout returns (apex, or the manual anchor). `[@test] ../packages/render/test/arc.test.ts`

## Label gap

- The stroke under a label is cut out with one mask on the anchor (`cutLabelGap`), never by a split of the path. Arrowheads stay whole. Nothing is cut when the label does not touch the line. `[@test] ../packages/render/test/label-gap.spec.ts`
- For an arc, the mask field covers the arc's bulge, because the scene box includes the sampled curve.

## Golden outputs

- Routing changed in 0.5.0, so the visual goldens in `fixtures/__goldens__` (rendered by `packages/diagrams/test/goldens.spec.ts`, per platform) must be re-recorded with `pnpm snap:update` and reviewed by eye.
