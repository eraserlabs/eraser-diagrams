# @eraserlabs/render

## Introduction

`@eraserlabs/render` is the in-browser half of the rendering pipeline. Given resolved elements and a prepared template library, it fills markup, mounts and isolates each template's CSS, measures the boxes the browser actually produced, routes connections through `@eraserlabs/layout`, and applies the result as positioned nodes plus a scene-wide SVG overlay.

It runs in Chromium as a self-contained IIFE (`@eraserlabs/render/browser/iife`, exposed as `window.__eraser`), which is how `@eraserlabs/diagrams` drives it. The root export is node-safe scene types and `buildHtmlDocument` and depends on nothing browser-specific. Portable element, icon, template, role, and font contracts live in `@eraserlabs/protocol`.

## Why

Authored width and height are intent, not paint. Text wrapping, padding, icons, and shadows change the boxes that routing and export must honor. Those measurements only exist after a real layout engine has run, so this package lives in the page rather than approximating CSS in Node.

## Usage

Inject the IIFE into a page, then:

```ts
window.__eraser.setup({ templates, baseCss });
await window.__eraser.registerFonts({ css, faces });

const { measures, layout } = await window.__eraser.run({
  entities,
  connections,
  icons,
});

const { scene, css } = window.__eraser.serialize();
```

`setup` and `registerFonts` are page-lifetime. `run` is per request: fill, mount, measure, route, apply. `serialize` returns the positioned scene markup and the stylesheets this bundle owns, for the HTML output path.

Authored connection `points` are route-local `{ x, y }` objects whose origin is the connection's `x` / `y`. The adapter converts them to the tuple geometry `@eraserlabs/layout` uses; output polylines remain scene-space tuples.

The page API and measure contract are specified in `SPEC.md`.

## Editor APIs

`@eraserlabs/render/elements` renders resolved subsets without mounting, routing, or global setup:

```ts
import { createElementRenderer } from '@eraserlabs/render/elements';
import { buildRenderPageSetup } from '@eraserlabs/diagram-templates';

const renderer = createElementRenderer(buildRenderPageSetup(resolver.library));
const result = await resolver.resolve(
  { elements: selection },
  { partial: true },
);
if (!result.ok) throw new Error(JSON.stringify(result.errors));
const fragment = await renderer.render({
  entities: result.entities!,
  connections: result.connections!,
  icons: result.icons!,
});
```

Install `renderer.css` and mount `fragment.defs` alongside the HTML. Wrap each element in `[data-mdp-tag="<tag>"]`; the host owns positioning and cleanup. Resolved themes are applied automatically to template roots. Use `applyLayout` to apply existing geometry without routing.

The same entry exports `measureElements(mounted, entities?)` and `measureText(root)`. Supply connected, untransformed DOM with the library CSS and registered fonts; `display:none` cannot be measured. These calls wait for fonts. With entities, measurement applies the full renderer's sizing policies and restores probe styles; without them it reads current layout. Text measurements contain range fragments and their union, not padded boxes or one rectangle per line.

`@eraserlabs/render/fit` exports synchronous `measureElement(wrapper)` and `fitElement(wrapper, constraints)`. Fit policies are `natural`, `fixed`, `content`, and `balanced`; fitting leaves the probe at its proposed size. The host decides whether to persist that geometry.

`prepareWashMasters(master, elements, { idPrefix }?)` prepares watercolor definitions before low-level filling and mutates `props.washSym`. `renderer.render(request, { idPrefix }?)` handles cloning and preparation itself. Keep returned definitions mounted; an optional prefix must be unique among mounted fragments, using only letters, digits, underscores and hyphens. Automatic prefixes are isolated across bundles.
