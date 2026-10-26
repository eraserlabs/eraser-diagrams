# @eraserlabs/render Browser Pipeline Contract

The browser bundle (`@eraserlabs/render/browser`, IIFE at `dist/browser/eraser-render.iife.js`) turns resolved element data into positioned DOM. The payload and template dialect are MDP ([`packages/protocol/SPEC.md`](../protocol/SPEC.md)). Classification, sanitization, and the icon sidecar come from resolve ([`packages/resolve/README.md`](../resolve/README.md)).

## Page API

The bundle assigns `window.__eraser`:

```ts
setup({ templates, baseCss }): void
registerFonts({ css, faces }): Promise<void>
run({ entities, connections, icons }): Promise<{ measures, layout }>
serialize(): { scene, css }
```

- **`setup`** is page-lifetime. It wraps each template's CSS in a host-scoped `@scope` block and injects one stylesheet reused by every request.
- **`registerFonts`** is page-lifetime and must run before the first `run`. The caller supplies a stylesheet (injected as `#eraser-fonts`: role vars plus `@font-face` rules for `url` faces) and byte-backed faces. Byte faces become `document.fonts.add(new FontFace(...))` because Chromium blocks `file://` subresources from an origin-less page. Absolute `http(s)://` `@font-face` URLs load from that page; each url family is force-started with `document.fonts.load` so `run()`'s `document.fonts.ready` wait is deterministic. A face that fails to parse degrades without crashing. This bundle registers whatever it is handed.
- **`run`** is per request: fill → mount at max-content → `await document.fonts.ready` → measure → size text → measure → route → apply. Connection labels that opt into wrapping are constrained by the routed run, remeasured, and routed once more before apply.
- **`serialize`** returns the laid-out scene plus the two stylesheets this bundle owns: `#eraser-fonts` (empty when fonts were never registered) and `#eraser-styles`. `buildHtmlDocument` in this package is the document shell around that markup.

## Measures

One `ElementMeasure` per element. Boxes are wrapper-relative until apply writes scene coordinates.

- `intrinsic` — pass-1 natural max-content box.
- `body` — the routable layout box: the template root's (`[data-tpl]`) rect after size resolution. Null if the template mounted nothing.
- `ink` — union of every rendered descendant rect plus outward box-shadow extents (`inset` shadows are excluded). Apply grows the scene box by ink so exports contain all paint.
- `roles` — `[data-role]` boxes grouped by role.
- `parts` — `[data-part]` boxes grouped by part name.
- `content` — containers only: union of member body boxes. Filled by the caller, not the measure pass.

## Isolation

Every mounted template sits in a mount host with `data-mdp-tag` (the wrapper for top-level elements; the `data-use` host for nested compositions). Setup confines each template's bare-selector CSS to its hosts:

```css
@scope ([data-mdp-tag="Shape"]) to ([data-mdp-tag]) {
  /* template CSS, verbatim */
}
```

The scope root is the host, so bare selectors reach the whole template. The `to` boundary stops at nested mount hosts, so a template cannot style into or out of a `data-use` composition. Boundary hosts themselves sit outside the enclosing scope — wrap a nested host in your own element to position it. `baseCss` stays unscoped; `:root` custom properties are the shared theming channel.

## Fill

Values are substituted into the template HTML string and assigned with `innerHTML`. `textContent` / `setAttribute` are never used for content (they would double-escape). The dialect is MDP; this engine does not evaluate template JavaScript. Empty `{{ }}` placeholders are left for apply (for example a connection path `d`).

## Text sizing

Sizing is tag-independent. Entity sizing applies it to a template's own `internal-text` roles; the post-route pass applies it to connection `external-text` roles. Nested `data-use` templates keep their own policy. Other external text takes its width from template CSS and is still measured as ink.

- `width-only` uses the natural max-content box. Authored dimensions remain floors.
- `height-only` keeps an authored or available width and grows height as CSS wraps.
- `balanced` starts at that width; if the text exceeds its preferred line count, it may grow toward its aspect target before growing height, and never past max-content merely for balance.

Unannotated internal and route-bound external text defaults to `balanced`. Wrapping needs a wrappable CSS formatting context (`min-width: 0`, normal whitespace, `overflow-wrap`). With no authored width, this renderer uses `min(max-content, 100px)` for `height-only` and `balanced` internal text unless the template CSS already imposes a larger minimum. A connection label's available width is the longest horizontal straight run minus end clearance; that box is remeasured and the connection is routed again. A persisted label width wins when the label is authored or manual.

## Route and apply

`run` adapts measured boxes to [`@eraserlabs/layout`](../layout/README.md) and applies the result. A missing entity `x` or `y` is treated as zero here.

`apply` positions nodes absolutely and draws each connection on a full-scene SVG overlay. Lines share one layer above every node; labels share one layer above the lines. The label is transparent; a user-space SVG mask cuts its measured rectangle plus 2px clearance from the path. A template-authored mask is composed, never overwritten. `#eraser-scene` is sized to the scene box grown by ink so paint does not clip at the edge.

`cornerStyle: 'elbow'` paints each interior vertex as a circular arc (radius clamped to half the shorter leg; terminals stay sharp). The polyline remains the geometry of record for labels, the mask, and the scene box.
