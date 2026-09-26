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
