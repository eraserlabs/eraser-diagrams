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

## Rendering subsets in an editor

`@eraserlabs/render/elements` is a browser entry with no import-time side effects: it does not install `window.__eraser`, mount or remove DOM, inject styles, or run layout. It is suitable for a host that already owns element positions, routes and DOM lifetimes.

```ts
import {
  createElementRenderer,
  measureElements,
  measureText,
} from '@eraserlabs/render/elements';
import { buildRenderPageSetup } from '@eraserlabs/diagram-templates';

// `resolver` was created with the desired library and normalizers.
const renderer = createElementRenderer(buildRenderPageSetup(resolver.library));
const resolved = await resolver.resolve(
  { elements: selection },
  { partial: true },
);
if (!resolved.ok)
  throw new Error(resolved.errors.map((e) => e.message).join('\n'));

const fragment = await renderer.render({
  entities: resolved.entities!,
  connections: resolved.connections!,
  icons: resolved.icons!,
});

// Install renderer.css once for this library. It includes base CSS and host-scoped template CSS.
const style = document.createElement('style');
style.textContent = renderer.css;
document.head.appendChild(style);

// Use a connected, untransformed host (or an offscreen measurement probe, not display:none).
const host = document.createElement('div');
document.body.appendChild(host);
host.innerHTML = fragment.defs;
const mounted = fragment.elements.map(({ id, tag, html }) => {
  const wrapper = document.createElement('div');
  wrapper.dataset.mdpTag = tag;
  wrapper.innerHTML = html;
  host.appendChild(wrapper);
  return { id, tag, wrapper };
});

// Natural max-content sizes and policy-sized body/role/part/ink bounds, without routing.
const measures = await measureElements(mounted, resolved.entities!);
// Or inspect current host dimensions without applying sizing policies:
const current = await measureElements(mounted);
// Exact text fragments and their union at the DOM node's current font and wrapping width:
const text = mounted[0]?.wrapper.querySelector<HTMLElement>(
  '[data-role="internal-text"]',
);
if (text) console.log(await measureText(text));

// The host owns cleanup; the library retains none of these DOM nodes.
host.remove();
style.remove();
```

`render` returns all supplied elements, including orphaned `containerId`/`from`/`to` references. It fills templates, including icons and watercolor, without resolving geometry or mutating input. It does not invent missing nodes, route connections, or apply positions. A connection's anchor is left for the editor's saved path. Hosts can use the exported `applyLayout(scene, mounted, layout)` with their own `SceneLayout` (public at `@eraserlabs/render`) to paint supplied boxes, paths and label positions even when endpoints are absent. Alternatively, the editor can paint those itself. `run()` continues to provide the full-scene sizing/routing/painting pipeline.

Keep `fragment.defs` mounted alongside its elements. Each render has distinct watercolor mask and texture-symbol IDs, including across independently bundled copies of the library; tinted texture bytes are cached and shared across elements of the same pigment pair. Templates and `washMaster` are trusted library configuration; element content and icon SVG must come through `resolve` before rendering. Base CSS is intentionally unscoped, as in `setup`.

### Measurement and fonts

`run()` already returns `ElementMeasure[]`, including text roles, but runs the full scene pipeline. The standalone `measureElements` and `measureText` functions do not route, replace the current scene, or alter text. They wait for the mounted content's fonts via `document.fonts.ready`. Stage custom fonts before calling them; a font not registered with the document cannot be measured.

With entities, `measureElements` uses the same two-pass sizing policy as `run`, then restores the hosts' original inline styles and any descendant styles changed by width probes, including `!important` priorities. Probes run synchronously in the original CSS context after fonts load. If the host needs isolation from style mutations, it can supply its own mounted measurement copy with equivalent ancestor styles and constraints. Use the returned `body` dimensions to resize elements explicitly. Without entities it reads current layout; `intrinsic` then equals the current wrapper box. Text roles (`internal-text`, `external-text`) and parts are in the element measurement; `measureText` returns individual text-run fragments and their union, excluding padding. Fragments are **not** line boxes: differently styled spans on the same line may produce multiple fragments. Empty text has `bounds: null`.

Measurements require connected elements in the current document and actual browser layout. Use an untransformed probe for canvas coordinates; CSS transforms/zoom are reflected in browser rectangles. Hidden offscreen probes may use `visibility:hidden`; `display:none` has no layout.

### Reusing watercolor preparation alone

Existing fill-engine integrations can import `prepareWashMasters` from `@eraserlabs/render/elements`. Call it with the library's `washMaster` and resolved elements **before** filling their templates. It writes `props.washSym` and returns the SVG definitions that must be mounted with that fragment. It does not install those definitions. This low-level function mutates the supplied props; `createElementRenderer` handles cloning, per-fragment watercolor mask IDs, and preparation for you.

To control watercolor IDs, pass `{ idPrefix: 'view-a-element-123' }` as the second argument to `renderer.render(request, options)` or the third argument to `prepareWashMasters(master, elements, options)`. Use only letters, digits, underscores, and hyphens. The prefix must be unique among simultaneously mounted fragments in the same document: an element ID alone is insufficient when the same element appears in multiple views. Reuse a prefix only when replacing its previous fragment and definitions. Without a prefix, the library uses a random bundle namespace plus a counter. Cached tinted image bytes are shared, while each preparation call emits definitions with its own IDs.
