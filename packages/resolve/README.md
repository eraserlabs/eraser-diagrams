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

## Partial documents

Editors can resolve a selection without submitting its container or connection endpoints:

```ts
const result = await resolver.resolve(
  {
    elements: [
      {
        tag: 'Shape',
        id: 'a',
        x: 0,
        y: 0,
        containerId: 'group-outside-selection',
      },
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

## Presentation themes

Pass `resolve(input, { theme: 'dark' })` (or `resolveForLayout` with the same option) to prepare a dark presentation. Light is the default. Palette lookup and all normalizers run first; one schema-driven pass then transforms every declared CSS color, including nested text runs, badges, icon overrides, connection labels, and derived watercolor paints. Authored input and the `authored` sidecar remain unchanged. `validate` performs the same checks without preparing a presentation.

The result and each resolved element carry their theme. Both the full browser renderer and `createElementRenderer` use that metadata automatically; the host does not add a DOM theme attribute. To change themes, resolve the original authored input again. Changing a DOM attribute alone only changes CSS defaults, not the already prepared explicit paints.

Stock templates calculate their light-space surface colors before conversion (Shape 85% lightness, Group 98%, and their own title/badge treatments). Defaults, code chrome, links and syntax highlighting use theme-aware CSS variables. `scaleColorForTheme` and `setColorLightness` are exported for custom normalizers that derive light-space paints. Normalizers should not transform for the theme themselves: declare every output color as `CssColor` in the library's internal `renderProps` and let the shared pass do it once.

Concrete hex, named, RGB/RGBA and HSL/HSLA colors share the same conversion and preserve alpha. `transparent` and `currentColor` retain their semantic meaning. A stock surface using inherited `currentColor` keeps its relative tint in light mode and uses a neutral themed surface in dark mode; use a concrete color for hue-preserving derived tints. Fixed colors inside multicolor SVG/image assets are left intact; monochrome icons using `currentColor` inherit their themed ink. Custom CSS should consume the library's semantic variables or provide its own theme-aware defaults.

## Internal render properties

Keep author-facing options in `library.schemas`. A normalizer's new implementation fields belong in the optional `library.renderProps` map, keyed by dispatchable tag:

```ts
const library = {
  // ...manifest, templates, baseCss
  schemas: { Tile: entitySchema('Tile', { bgColor: CssColor }) },
  renderProps: { Tile: { fillColor: CssColor } },
};
const normalizers = {
  Tile: (element) => {
    element.fillColor = element.bgColor ?? '#ffffff';
  },
};
```

Here `bgColor` is accepted input, while `fillColor` is available to template bindings and the post-normalizer color/theme stages. Supplying `fillColor` in authored input produces the normal unknown-property warning and strips it before the normalizer runs. The original input schemas, `tagSchema()`, and schema exports do not include internal fields. Existing libraries without `renderProps` keep their behavior.

Render declarations use the same property-schema subset and may describe nested objects and arrays. They supply post-normalizer content, reference, icon and color policies; they do not apply defaults or run a second full structural validation. Normalizers are responsible for producing the declared shape. Derived colors must use `CssColor`, not `PaletteColor`: palette lookup runs on authored input before normalizers. Boot rejects unknown tag names, collisions with authored properties, forbidden keys and invalid declarations. Subtemplate-only declarations and extensions inside existing authored properties are not supported.

## Diagram text

Markdown is a small diagram-text surface: headings (drawn through level three), paragraphs, flat lists, simple blockquotes containing paragraph text and inline marks, horizontal rules, and top-level fenced code blocks. Inline marks include emphasis, strikethrough, code spans, and links. Nested block structures (such as headings, lists, or code fences inside quotes) are outside the supported contract; parser acceptance does not guarantee their presentation.

A prose newline draws a line break; two newlines separate paragraphs; additional blank lines and trailing newlines retain empty lines. Code spans and link syntax are interpreted by the Markdown parser, without injecting hard-break spaces into their source. Fenced code keeps its internal lines and spaces and wraps long tokens to the available width. Four-space indentation stays paragraph text. Labels use inline Markdown, so block starters remain literal. Tables, images, and raw HTML in Markdown are not supported. These output rules also apply to existing documents rendered through Node, CLI, and server entry points.
