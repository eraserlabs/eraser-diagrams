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

`createResolver` compiles the library once. `resolve` returns `{ ok, entities, connections, icons, warnings, errors }`; `validate` runs the same pipeline without inlining icon bytes. Supply `iconLoader` to fetch SVGs by name; `onUnknownIcon` is `'placeholder'` or `'error'`. Loaded SVGs pass an allowlist sanitizer that parses them by the browser's HTML rules: static drawing elements and local references only. Anything else rejects the icon, which then falls under `onUnknownIcon`, except editor metadata (Inkscape/Sodipodi, `<metadata>`, extra namespace declarations), filter effects, and style properties outside the allowlist, which are removed.

Portable document, component, font, and schema-vocabulary contracts live in `@eraserlabs/protocol`. Compatibility re-exports remain at `@eraserlabs/resolve/schema`. Component authoring is documented in [CUSTOMIZATION.md](../../CUSTOMIZATION.md).

## Subsets and synchronous resolution

`resolve(input, { partial: true })` and `validate(input, { partial: true })` allow references to omitted elements. Schema errors, duplicate IDs, included targets of the wrong kind, and containment cycles remain errors. Calls are strict by default; partial results do not supply missing routing geometry.

`resolveForLayout(input, options?)` returns synchronously with placeholder icons, without loading icons or checking their existence. All other resolution stages are shared. It supports measurement before assets load when templates give real and placeholder icons the same bounds.

## Themes and internal paints

Pass `{ theme: 'dark' }` to either resolution method. Palette lookup and normalizers run first, then every schema-declared color is transformed once, including nested and internal colors. Authored input stays unchanged. Renderers apply the resulting theme metadata automatically; changing themes requires resolving the original input again.

Normalizers compute light-space paints. Declare new internal outputs in `library.renderProps`, e.g. `renderProps: { Card: { fillColor: CssColor } }`. These authorize template bindings and post-normalizer content/color policies without appearing in authoring schemas. Submitted internal fields are warned about and stripped before normalization. Names cannot overlap authored fields; derived colors use `CssColor`, not `PaletteColor`. Normalizers own structural validity; render declarations do not apply defaults or repeat full schema validation.

Custom CSS needs theme-aware defaults; stock CSS provides `--er-text`, `--er-surface`, `--er-line`, and code/syntax tokens. Fixed-color artwork is unchanged. `currentColor` stays inherited; use concrete colors for hue-preserving tint conversion.

## Diagram Markdown

Block text supports paragraphs, headings (capped at level three), flat lists, simple quotes, rules, strikethrough, and fenced code. Labels use inline Markdown. Nested blocks, tables, images, and raw HTML are outside the presentation contract; raw HTML is escaped. These rules also affect existing documents.

Prose newlines draw line breaks; a blank line separates paragraphs. Extra and trailing empty lines are preserved. Four-space indentation remains prose. Marked handles code spans and links; fenced code preserves internal whitespace and wraps long tokens. Optional `highlightCode` returns text/class runs that must reproduce its input exactly; failures fall back to plain code.
