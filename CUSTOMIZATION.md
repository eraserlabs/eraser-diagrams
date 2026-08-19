# Customizing Eraser Diagrams

The stock library is a complete diagramming system, and most customization is a matter of using what it already exposes: colors, variants, icons, typefaces, badges, and style modes are all authored properties on the stock tags. This document covers the next level: changing what the tags themselves are and how they look — a walkthrough first, then the full authoring reference.

Customization is data, not code. A visual vocabulary — Eraser calls it a _component library_ — is a set of tags, where each tag is a **component**:

- a **JSON Schema** describing the tag's authored properties;
- **markup** that renders those properties (a named HTML `<template>` element);
- **CSS** scoped to that component; and
- optionally, **normalizers** that derive render-ready values from authored ones (see [Normalizers](#normalizers) — these are application code, not library data).

A library may also declare a **[palette](#palettes)**: named colors its tags can accept by name.

Component markup contains no JavaScript. It is validated before use, and the fill engine performs substitution only. This is what keeps diagram data safe to accept from LLMs and other untrusted authors.

Reference material:

- The stock tags are the best examples: [`packages/diagrams/src/library/templates/`](./packages/diagrams/src/library/templates/) contains each tag's schema, HTML, and CSS side by side.
- [`@eraserlabs/protocol`](./packages/protocol/README.md) and the [MDP spec](./packages/protocol/SPEC.md) define the underlying contracts a library implements.

## The three levels of customization

### 1. Configure the stock library

No new components needed. The stock tags accept colors (`color` as a palette token or any CSS color, `bgColor` / `borderColor` as raw CSS colors), `styleMode` (`plain`, `shadow`, `watercolor`), typefaces, border styles, badges, icons, and more — see [Getting Started](./GETTING_STARTED.md#common-properties). Custom icons and fonts are supplied through configuration ([icons](./GETTING_STARTED.md#icons), [fonts](./GETTING_STARTED.md#fonts)).

### 2. Override stock components

To restyle a stock tag without forking the library, pass `overrides` to `createRenderer` (component markup travels as `TemplateFile` entries). Entries whose names match replace the stock components; new names are appended. The merged library is validated before use.

```ts
import { createRenderer } from '@eraserlabs/diagrams';

const renderer = await createRenderer({
  overrides: { templates: [myRestyledShapeTemplate] },
  chromiumPath: process.env.CHROMIUM_PATH!,
});
```

### 3. Define your own tags

Supply your own library — your tags, your schemas, your visual system. The rest of this document walks through a complete example.

## A custom tag, end to end

We'll define a `Card` entity with a `variant` (`primary` / `secondary`) and a `state` (`default` / `disabled`) driven by authored data, plus a `Link` connection — the classic case of bundling visual decisions into a few named options an author (or LLM) picks from, instead of exposing raw colors.

### Define the schemas

`entitySchema` and `connectionSchema` add the core element fields (`id`, geometry, `containerId`; `from`/`to` for connections) so you declare only your tag's own properties:

```ts
import { entitySchema, connectionSchema } from '@eraserlabs/diagrams';

const Card = entitySchema(
  'Card',
  {
    label: { type: 'string', 'x-content': 'plain' },
    variant: { type: 'string', enum: ['primary', 'secondary'] },
    state: { type: 'string', enum: ['default', 'disabled'] },
  },
  { required: ['x', 'y', 'label'] },
);

const Link = connectionSchema('Link', {
  label: { type: 'string', 'x-content': 'plain' },
});
```

Text-bearing properties declare an `x-content` policy (`plain`, `inline-markdown`, `markdown`, or `html`) so the resolver sanitizes them before they reach the browser. The stock library uses the first three; `html` admits a sanitized subset of markup for profiles that need it. Color-bearing properties use `'x-css-color': true` and are validated against the CSS color grammar. Optional properties may declare a JSON Schema `default` (a scalar that is itself a valid instance of that property); resolution fills a missing value on the prepared clone. A present value, including `null`, is left alone, and the authored document is never rewritten.

What the cores provide: the entity core exposes optional `x`, `y`, `width`, `height`, and nullable `containerId`; a profile may add any declared entity geometry to `required` (as `Card` does with `x`/`y` above). Pass `{ isContainer: true }` on an entity tag whose members can contain other entities — the same kind of tag fact as kind, stamped onto the schema as `x-is-container`. Authors need not set `isContainer` per entity when the tag declares it; they may still author it to opt a specific entity in or out. Tag schemas need not declare the property — resolution accepts an optional boolean on every entity. Only a container may be named by `containerId`. The connection core requires `from` and `to`, permits an optional authored `id` and optional route-origin `x`/`y`, and exposes neither `width`, `height`, nor `containerId`. Pass `{ required: ['id'] }` only when a profile requires authored connection identities. Core geometry is non-negative. The stock Eraser profile requires `x` and `y` for every entity because it does not auto-place entities, while keeping `width` and `height` optional minimums.

### Write the components

A component's markup is a `TemplateFile`: one named HTML `<template>` element plus bare-selector CSS. The root carries `data-tpl` and, for entities, `data-role="body"` — the box that layout and routing treat as the element. `{{property}}` substitutes schema-declared properties; enum values can be bound to `data-*` attributes and targeted from CSS. That attribute binding is the whole variant/state mechanism:

```ts
import type { TemplateFile } from '@eraserlabs/diagrams';

const cardTemplate: TemplateFile = {
  name: 'Card',
  html: `<template name="Card">
  <article
    data-tpl="Card"
    data-role="body"
    class="card"
    data-variant="{{variant}}"
    data-state="{{state}}"
  >
    <span class="card__label" data-role="internal-text">{{label}}</span>
  </article>
</template>`,
  css: `.card {
  display: inline-flex;
  align-items: center;
  padding: 12px 20px;
  border-radius: 8px;
  border: 1.5px solid #2f6fed;
  background: #ffffff;
  color: #2f6fed;
  font-family: var(--font-clean);
}
.card[data-variant='primary'] {
  background: #2f6fed;
  color: #ffffff;
}
.card[data-state='disabled'] {
  opacity: 0.45;
  border-style: dashed;
}`,
};

const linkTemplate: TemplateFile = {
  name: 'Link',
  html: `<template name="Link">
  <div data-tpl="Link" class="link">
    <svg><path data-role="anchor" d="{{ }}" /></svg>
    <span data-role="external-text">{{label}}</span>
  </div>
</template>`,
  css: `.link path { fill: none; stroke: #64748b; stroke-width: 1.5px; }
.link span { font-family: var(--font-clean); font-size: 12px; color: #64748b; }`,
};
```

Two rules the linter enforces here: the `<template>` name, `TemplateFile.name`, and the root's `data-tpl` value must agree; and every placeholder must resolve to a property declared by that component's schema or to a loop variable.

Connection components use `data-role="anchor"` on a path whose `d` is the empty `{{ }}` placeholder — the router writes the routed path there — and may carry a `data-role="external-text"` label positioned along the line.

CSS is authored with ordinary bare selectors; the renderer scopes each stylesheet to its component's elements, so `.card` cannot leak into other tags. Fonts are provided as `--font-rough` / `--font-clean` / `--font-mono` variables.

### Assemble the library and render

```ts
import { createRenderer, type AuthoredLibrary } from '@eraserlabs/diagrams';

const library: AuthoredLibrary = {
  manifest: ['Card', 'Link'],
  schemas: { Card, Link },
  templates: [cardTemplate, linkTemplate],
  subTemplates: {},
  baseCss: '',
};

const renderer = await createRenderer({
  library,
  chromiumPath: process.env.CHROMIUM_PATH!,
});

const outcome = await renderer.render({
  entities: [
    {
      tag: 'Card',
      id: 'a',
      x: 40,
      y: 40,
      label: 'Sign up',
      variant: 'primary',
    },
    { tag: 'Card', id: 'b', x: 260, y: 40, label: 'Invite team' },
    {
      tag: 'Card',
      id: 'c',
      x: 480,
      y: 40,
      label: 'Billing',
      state: 'disabled',
    },
  ],
  connections: [
    { tag: 'Link', from: 'a', to: 'b', label: 'then' },
    { tag: 'Link', from: 'b', to: 'c', label: 'later' },
  ],
});
```

![Three rendered cards: a filled primary "Sign up" card, an outlined "Invite team" card, and a faded dashed disabled "Billing" card, connected by labeled lines](./docs/images/custom-cards.png)

`manifest` is more than a listing: it is the deterministic emission order, so it decides the CSS cascade order between components.

The library is validated when `createRenderer` prepares it: schema problems, malformed markup, placeholders that don't match schema properties, and unsafe markup are all rejected up front with a `RegistryError` listing every issue. To run the same validation without booting a renderer, call `prepareLibrary` from `@eraserlabs/diagrams` directly. Authored diagrams then validate against _your_ schemas — `{ "variant": "tertiary" }` is a structured error naming the element, path, and allowed values, which is exactly the guardrail you want when an LLM authors the JSON.

## Component markup dialect

| Form | Meaning |
| --- | --- |
| `data-tpl="Name"` | Marks the single component root. |
| `data-role` | Assigns a semantic measurement or routing role. |
| `data-part` | Adds a profile-defined measurement handle such as `title` or `icon`. |
| `data-text-grow-policy` | Selects `balanced`, `width-only`, or `height-only` text growth. |
| `data-each="item of items"` | Repeats a child subtree for each array item; a sibling `data-key` is required. |
| `data-use="Name"` | Mounts a sub-template at this host. |
| `data-props="property"` | Binds a mounted sub-template to a nested property object. |
| `data-if="property"` | Removes the element and its subtree when the property is falsy. |
| `data-slot="icon"` | Mounts the sanitized SVG associated with an icon-name property. |
| `{{property}}` | Substitutes an own-property path. Dotted paths are supported. |
| `{{item.property}}` | Substitutes a field from the current loop item. |
| `{{ }}` | Reserves a value for the layout stage, such as a connection path's `d`. |

Inside a `data-each` subtree, item values support string substitution. Nested `data-each`, `data-if`, `data-use`, and `data-slot` directives are not evaluated; flatten more complex presentation data in a [normalizer](#normalizers).

## Roles and measurement

`data-role` is how a component's markup tells the renderer which boxes _mean_ something. Everything else in the markup is paint; roles are the contract between your markup and measurement, sizing, and routing.

- **`body`** — the element's layout box, and the most consequential role: exactly one per entity component. Its measured box _is_ the entity as far as the system is concerned — the obstacle routes avoid, the box connection endpoints attach to, the geometry containment is computed from, and the `width`/`height` reported back in the measured JSON output. Authored `width`/`height` are minimums; content can grow the body, and the measured box wins. (Attachment can be refined past the box: a normalizer may emit an `outline` describing the true drawn boundary — a hexagon's slope, an ellipse's curve — and endpoints attach to that instead. Malformed outlines degrade to box attachment.)
- **`internal-text`** — text that participates in sizing the body. The renderer measures it and grows the body to fit, governed by `data-text-grow-policy` (`balanced`, `width-only`, or `height-only`).
- **`external-text`** — ink measured _outside_ the body. On an entity (an icon's caption), it does not grow the body, but the router is told about its box and keeps routes clear of it. On a connection, it is the label: the router places its box along the route, and the painted stroke is masked out behind it.
- **`anchor`** — on a connection, the SVG path whose `d` is the empty `{{ }}` placeholder; layout writes the routed path into it. On an entity, it marks the reference box that external text sizes against — the stock `Icon` marks its glyph as the anchor, which is why captions measure around the glyph rather than the other way round.
- **`badge`** — badge-like rendered content, measured as its own box so overlaid badges don't distort the body's sizing.

For measurements that need no protocol semantics, use `data-part="name"` — the renderer reports those boxes by part name (the stock components use `title` and `icon`), which is how applications can locate a sub-element of a rendered entity without parsing its HTML.

## CSS isolation and bindings

Author ordinary, bare CSS selectors. The renderer scopes each stylesheet to hosts carrying `data-mdp-tag="Name"` and stops the scope at nested component hosts. Do not add `@scope`, `:scope`, shadow-DOM selectors, `@import`, `@font-face`, or `url()` yourself.

Fonts are provided by the renderer as `--font-<role>` variables. Bind a schema-selected role through the sanctioned inline form:

```html
<span style="--f: var(--font-{{typeface}}, var(--font-clean))">{{label}}</span>
```

Schema-validated colors and numbers may be bound to CSS custom properties using `--er-*` declarations:

```html
<article style="--er-color: {{color}}; --er-gap: {{gap}}px">...</article>
```

The referenced property must be a number, or carry `x-css-color` or [`x-palette`](#palettes). Content-bearing properties cannot appear in attributes. CSS `var()` fallbacks do not activate for an empty custom-property value, so bind only values your schema or normalizers reliably provide, or gate their use with a substituted attribute.

## Palettes

A library may declare a `palette`: a map from token name to one CSS color.

```json
{
  "palette": {
    "ink": "#1b1f24",
    "brand": "#3b5bdb",
    "accent": "#f08c00",
    "ok": "#2f9e44",
    "danger": "#e03131"
  }
}
```

That is the whole feature on the library side. Five lines give a brand its own vocabulary: authors (and the LLMs writing for them) name `"brand"` instead of remembering `#3b5bdb`, and moving the brand color is a one-line edit to the library, not a find-and-replace across every stored diagram.

A property opts in with `x-palette`:

```json
"color": { "type": "string", "x-palette": true }
```

An `x-palette` property accepts **either a palette token name or any raw CSS color**. At resolve time a token is translated to its color in place, a raw value is checked against the same strict CSS-color grammar `x-css-color` uses, and a string that is neither is an error carrying a did-you-mean over the token names. Everything downstream — normalizers, the color stage, your component's `--er-*` binding — sees one concrete color, so an `x-palette` property is style-bindable exactly like an `x-css-color` one. `x-palette` in a library that declares no palette is a boot-time definition error, as is combining it with `x-css-color` on the same schema.

### Why this union is fine when `enum | number` was not

This is the one union the system blesses, and the reason is mechanical. A `"sm" | number` size union cannot work as data: the token arm wants an attribute selector and the number arm wants an `--er-*` binding, and one property cannot be both — which is why sizes are an enum or a number, never either-or. The palette union has no such split. Both arms are colors, and a color has exactly one markup mechanism — a custom-property binding. Translation does not pick between two mechanisms; it just replaces a name with the value it names, and the property has a single domain (validated CSS color) before and after. There is nothing to reconcile.

The one thing that does change is _what_ the value means to your CSS. A palette that names identity colors pairs naturally with relative-color formulas over the single bound value, which is how the stock library works — one `--er-color` per element, and the pastel body, hairline, container tint, badge background and title surface are all `hsl(from var(--er-color) h s <L>%)` steps of it. Doing that in CSS rather than in a normalizer is what lets a raw `color: "peachpuff"` get exactly the treatment a token gets.

### Trust boundary

A palette is fully live — every token it declares becomes a legal value for palette-annotated properties, and resolution replaces the token with its color — but it is data, not code: like schemas, component markup, and CSS (and unlike normalizers), it serializes as part of `AuthoredLibrary` and nothing executes it. Boot rejects a token name outside `[A-Za-z][A-Za-z0-9_-]*` and any value outside the strict CSS-color grammar (the same gate that stops CSS injection through authored colors), so a hosted product can accept a palette from an untrusted profile author the same way it accepts their components.

## Sub-templates

Sub-templates (the `subTemplates` slot) are components in miniature — their own schemas and markup — but are not dispatchable element tags. Add their schemas to `subTemplates`, then mount them with `data-use` and `data-props`. They are exempt from the one-`body` rule and are not dispatch targets. The stock library's `Badge` is the live example: every stock tag mounts it with `<span data-use="Badge" data-props="badge" data-if="badge"></span>`.

## Normalizers

Before reaching for a normalizer, encode the conversion in CSS. An enum-to-value mapping is just a variant whose payload is geometry, and the attribute-binding pattern from the walkthrough handles it entirely as data:

```html
<svg data-size="{{size}}" class="widget"></svg>
```

```css
.widget[data-size='sm'] {
  width: 32px;
  height: 32px;
}
.widget[data-size='md'] {
  width: 50px;
  height: 50px;
}
```

Measurement happens after CSS applies, so a CSS-assigned dimension is exactly as real to sizing, routing, and the measured JSON output as a derived property. Numeric authored values bind directly (`--er-gap: {{gap}}px`), and `calc()` over those bindings covers arithmetic. A profile built this way stays pure data end to end — storable, transportable, and safe to accept from untrusted authors.

A custom property set by an attribute selector inherits, so one authored token can drive a whole subtree — the stock icon sizes work this way, and so does the group title band's icon bucket. Stock text sizing needs no token at all: `fontSize` is raw pixels through the gated-binding idiom (`data-font-px="{{fontSize}}"` plus `--er-font-px: {{fontSize}}px`, consumed only under `[data-font-px]:not([data-font-px=''])`), and every slot's default is a plain declaration in its own stylesheet. Where an element's px has to reach a nested run, the gate re-bases the slot's `--er-base` instead of setting `font-size` outright, so a per-run `data-run-px` can still pin one line — the element→run cascade is custom-property inheritance, with no resolve-time code at all.

A sizing property is therefore an enum **or** a number — never a union of the two. A token wants an attribute selector and a number wants an `--er-*` binding, and one property cannot be both, so the system simply does not offer `"sm" | number`. The stock library follows its own rule: text sizes are px-only, and icon sizes are token-only enums whose buckets each host's stylesheet owns (`md` is 50px for a standalone `Icon`, 20px inside a `Shape`, 15px in a group title band), with the numeric path being the authored `width`/`height` that outrank the token through a gated rule. When two properties must not be authored together, declare a plain JSON Schema `not: { required: [...] }` on the slot — validation names both properties in the error.

Color is the other conversion that has already happened. The stock library derives no colors at all: `color` is an `x-palette` property, and the whole coordinated identity treatment is relative-color arithmetic in each tag's own stylesheet — `hsl(from var(--er-color) h s 85%)` for a shape's pastel body, `98%` for a container's near-white tint and the badge background a mounted `Badge` inherits, `92%` for a `DatabaseTable`'s row separators, with the identity color itself as the hairline. Authored `bgColor` / `borderColor` outrank those formulas through ordinary cascade order.

Normalizers exist for what neither CSS nor an annotation can express. The markup dialect deliberately cannot compute — no arithmetic beyond `calc()`, no string building, no conditionals beyond truthiness — and some derivations fall outside paint entirely. A normalizer is a per-tag function run during resolution that writes render-ready properties onto the element. What the stock library still uses them for, in full:

- precomputed SVG path data — the watercolor wash blobs and the rounded shape polygons, since CSS cannot author a path's `d`;
- the watercolor **texture pigment pair** (`washShade` / `washMid`): the stain recolors a grayscale scan through an SVG luminance LUT whose stops are concrete `#rrggbb` values in `feFunc*` _attributes_, which no relative-color expression can reach, so that one pastel step is computed a second time in code;
- the `outline` geometry that lets connection endpoints attach to a shape's true drawn boundary (consumed by the router, not the painter);
- seeded per-element randomness;
- the half of an `Icon`'s `width || height || size || 50px` precedence that is not paint (it writes `sizePx` only when bounds are authored; the token and the 50px default are attribute selectors, and the gated `[data-sized]` rule is what lets bounds outrank them);
- a handful of small flattenings CSS and `default` cannot express: `vMargin` (clamp), the text-wrap aspect ratio, the `Icon` element→run typeface cascade, `iconColor`, `lineWidthPx`, and the crow-foot arrowhead pair a `relType` implies. Simple omitted values (`shape`, `styleMode`, `vAlign`, `Relationship.endArrowhead`, group-title `width`/`border`) are schema `default`s, filled by AJV during validation.

Two rules: every property a normalizer writes must also be declared in the tag's schema (kept optional — derived output is validated exactly like authored input), and every markup binding it feeds should get a concrete default (see the `var()` caveat above).

**Normalizers are application code, not library data — know the trust boundary.** Schemas, component markup, and CSS are data, not code: `AuthoredLibrary` contains exactly those, they serialize, and a hosted product can accept them from untrusted profile authors because preparation validates and the engine never executes them. Normalizers are JavaScript functions passed separately (`createRenderer({ normalizers })`) and run in your process — ship them only as part of your own application, and never accept them from outside the trust boundary. A profile that must stay pure data can do without them: every derived property is schema-declared, so authoring tools can compute and supply those values directly as input.

## Safety rules

Profile preparation rejects executable or context-breaking markup. Component markup cannot contain scripts, embedded documents, event-handler attributes, declarative shadow roots, `javascript:` or `data:` URLs, or arbitrary inline styles. Attribute values must be quoted.

Text properties should declare an `x-content` policy so the resolver can sanitize them before rendering. The fill engine performs substitution only; it never evaluates any authored JavaScript.

## Going further

The stock components in [`packages/diagrams/src/library/templates/`](./packages/diagrams/src/library/templates/) exercise everything above — schemas, roles, sub-template composition, normalizer-fed bindings — and the [MDP spec](./packages/protocol/SPEC.md) and [render contract](./packages/render/SPEC.md) define the underlying protocol these conventions implement.
