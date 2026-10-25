# @eraserlabs/diagram-templates

## Introduction

`@eraserlabs/diagram-templates` is the Eraser stock template library as data: for each tag (Shape, Icon, Group, Relationship, …) its JSON Schema, its HTML template and its CSS, plus the shared base CSS, the palette, the normalizers that derive template props from authored fields, and the page-setup builder that turns the library into the renderer's page registry. It has no browser or Chromium code, so a host that draws elements itself can import it next to `@eraserlabs/resolve` and `@eraserlabs/render/fill`.

## Usage

```ts
import { buildRenderPageSetup, stockLibrary, tagSchemas } from '@eraserlabs/diagram-templates';
import { stockNormalizers } from '@eraserlabs/diagram-templates/normalizers';
import { normalizeFetchedIcon } from '@eraserlabs/diagram-templates/svg-transforms';
import { createResolver } from '@eraserlabs/resolve';
import { createFillEngine } from '@eraserlabs/render/fill';

const resolver = createResolver({ library: stockLibrary, normalizers: stockNormalizers, ... });
const { templates } = buildRenderPageSetup(stockLibrary);
const fill = createFillEngine({ templates: Object.fromEntries(Object.entries(templates).map(([n, t]) => [n, t.html])), icons: {} });
```

`@eraserlabs/diagrams` (the Chromium conductor) depends on this package and re-exports it under `@eraserlabs/diagrams/library`, `/normalizers` and `/svg-transforms`, so those imports keep working.

## Editing a template

Each tag lives in `src/templates/<Tag>/` as `<Tag>.schema.ts`, `<Tag>.html` and `<Tag>.style.css`. `pnpm generate` (run by `build`) folds the HTML and CSS into `src/generated/templates.gen.ts`, which is tracked; `pnpm check-generated` fails when the tracked file is stale. See [CUSTOMIZATION.md](../../CUSTOMIZATION.md) for the template conventions.

## Theme and paint ownership

When using `createResolver` directly, pass both `library: stockLibrary` and `normalizers: stockNormalizers`; the normalizers prepare the paints consumed by the stock CSS. Legacy light-mode rendering without normalizers retains its CSS tinting, but full functionality and dark mode require them. The high-level `@eraserlabs/diagrams` renderer installs these defaults automatically.

Resolve with `{ theme: 'dark' }` to theme every schema-declared color, including nested text, labels, icons, badges, and watercolor pigments. Stock normalizers first derive final surface paints in light space: `color` gets an 85%-lightness Shape/Legend fill, 98% Group/Lane/Pool/table fill, or 96% BPMN fill; explicit `bgColor` and `borderColor` remain exact light-theme paints. Palette tokens and equivalent literal colors use the same derivation. The shared resolver transform then themes these final paints without changing the authored input.

The renderer and fill engine automatically mark their stock template roots with `data-er-theme="light"` or `data-er-theme="dark"`. Include `baseCss` with the template CSS: it provides semantic defaults (`--er-text`, `--er-surface`, `--er-canvas`, `--er-shadow`, and the `--er-code-*` and `--er-syntax-*` families). Each explicit theme root resets those defaults, so a light diagram inside a dark page stays light. Code has a coordinated foreground and background in both themes; hosts can override the semantic tokens or syntax stylesheet.

Custom templates can use the same tokens and declare authored paint properties as schema colors. Hard-coded host CSS and multicolor image assets are not automatically recolored. `currentColor` remains browser-inherited rather than being converted to a literal: stock relative tints keep their light-mode behavior and use neutral themed surfaces in dark mode. Use concrete CSS colors when hue-preserving tint conversion is required.
