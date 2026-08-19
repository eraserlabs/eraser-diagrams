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
