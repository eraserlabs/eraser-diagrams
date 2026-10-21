# @eraserlabs/resolve

## Introduction

`@eraserlabs/resolve` turns an authored diagram document into fully-resolved element data. It validates tags against a template library, applies derived-prop normalizers, sanitizes text, inlines icons, and emits a split `{ entities, connections }` payload for `@eraserlabs/render`. There is no server, filesystem, or network of its own: icon loading and similar I/O are injected by the caller.

It owns the authored input grammar. A document is an object envelope — either `{ elements }` or a split `{ entities, connections }` with both keys required. A bare JSON array is rejected (`E_ENVELOPE`). Authored TypeScript shapes (`AuthoredEntity`, `AuthoredConnection`, `DiagramInput`) are exported from this package; `@eraserlabs/protocol` owns the resolved contracts.

All authored dimensions are rounded to the nearest integer during resolution: every element's `x`/`y`/`width`/`height`, each connection waypoint in `points`, and the `labelPlacement` box. The layout engine works on the integer grid, so fractional coordinates (float dust from app exports or measured round trips) are canonicalized rather than carried.

## Why

Resolution has to run in Node, in the CLI, and in the browser playground with the same results. Coupling it to Chromium or a framework would force every consumer to take that dependency. A library that fails schema or template checks throws at `createResolver`, so no resolver exists over a vocabulary the engine has not proven it can run.

## Usage

```ts
import { createResolver } from '@eraserlabs/resolve';
import { stockLibrary } from '@eraserlabs/diagram-templates';
import { stockNormalizers } from '@eraserlabs/diagram-templates/normalizers';

const resolver = await createResolver({
  library: stockLibrary,
  normalizers: stockNormalizers,
});

const result = await resolver.resolve({
  entities: [
    { tag: 'Shape', id: 'a', x: 0, y: 0 },
    { tag: 'Shape', id: 'b', x: 200, y: 0 },
  ],
  connections: [{ from: 'a', to: 'b' }],
});
```

`createResolver` compiles the library once. `resolve` returns `{ ok, entities, connections, icons, warnings, errors }`; `validate` runs the same pipeline without inlining icon bytes. Supply `iconLoader` to fetch SVGs by name; `onUnknownIcon` is `'placeholder'` or `'error'`.

Portable document, component, font, and schema-vocabulary contracts live in `@eraserlabs/protocol`. Compatibility re-exports remain at `@eraserlabs/resolve/schema`. Component authoring is documented in [CUSTOMIZATION.md](../../CUSTOMIZATION.md).

## Partial documents

Editors can resolve a selection without submitting its container or connection endpoints:

```ts
const result = await resolver.resolve(
  {
    elements: [
      { tag: 'Shape', id: 'a', containerId: 'group-outside-selection' },
      {
        tag: 'Relationship',
        id: 'edge',
        from: 'a',
        to: 'node-outside-selection',
      },
    ],
  },
  { partial: true },
);
```

The same per-call option is available on `validate`. Only missing-reference errors are suppressed; reference values are preserved. Duplicate IDs, invalid schemas, references to included connections, references to included non-containers, containment cycles, sanitization and icon policy still apply. A subsequent call without the option remains strict. Partial results are for an editor's fragment renderer; they do not supply the missing geometry needed to route a complete scene.
