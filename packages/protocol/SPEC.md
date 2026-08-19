# Model Diagramming Protocol 0.1

The Model Diagramming Protocol (MDP) is a schema-driven contract between diagram producers, vocabularies, layout systems, and renderers. “Must”, “should”, and “may” are normative terms.

## 1. Core and profiles

MDP defines element identity, element kinds, optional authored geometry, schema annotations, the template dialect, semantic DOM roles, and portable library packaging.

An MDP profile defines tags and their schemas, templates, styles, palette, and font roles. The Eraser vocabulary is one MDP profile; it is not part of the core protocol.

## 2. Tag dispatch and element kinds

The authored wire format is a document of tagged objects, always an object envelope in one of two mutually exclusive forms: `{ elements }`, or `{ entities, connections }` with both keys required so an empty connection list is stated rather than omitted. A bare JSON array is not a document.

Every element must carry a non-empty `tag`, with one exception: in the split envelope, a connection may omit `tag` when the profile declares a default connection tag. Entities must carry a document-unique non-empty `id`. A connection may omit `id`; the prepared payload always has a concrete one.

`tag` is the only per-element discriminator. Each dispatchable tag schema must declare exactly one kind at its root:

```json
{ "x-schema-kind": "entity" }
```

or:

```json
{ "x-schema-kind": "connection" }
```

A consumer must infer kind by resolving `tag` through the selected, versioned profile registry. Producers must not repeat `kind` on every element. A consumer must not infer kind from `from`, `to`, template markup, or a stock tag name.

An entity tag that can contain other entities declares that at the schema root:

```json
{ "x-schema-kind": "entity", "x-is-container": true }
```

`x-is-container` is a tag fact, like kind: authors should not need to pass `isContainer` per entity. A consumer infers container-ness from the tag registry. An entity may still author `isContainer`; a missing value is treated as true when the tag declares `x-is-container`, and a present value is the entity's container-ness. Only a container may be named by another entity's `containerId`. `x-is-container` is invalid on connection tags and below the schema root.

## 3. Entities and connections

An entity:

- must carry `tag` and `id`;
- may carry `x`, `y`, `width`, and `height`;
- may carry `containerId` as a non-empty entity id or `null`;
- may carry `isContainer` as a boolean;
- does not require authored geometry merely to conform to core MDP, though a tag schema may require any of its declared geometry fields;
- may carry further properties as its schema allows.

A connection:

- must carry `tag` (unless the profile default applies), `from`, and `to`, and may carry `id`;
- may carry `x` and `y` plus profile-defined route hints or explicit `points`;
- must not carry core `width` or `height`;
- must not carry `containerId`;
- may carry further properties as its schema allows.

`from` and `to` must name entities. A connection's logical containment is derived from its endpoints and container ancestry.

## 4. Geometry

All declared authored `x`, `y`, `width`, and `height` fields are non-negative. Fractional values are allowed. Core entity geometry and connection `x`/`y` are optional; a tag schema may require stronger geometry.

For an entity, `x` and `y` are placement inputs; `width` and `height` are minimum dimensions. Absence delegates placement or preferred sizing to the selected layout and render policy.

For a connection, `x` and `y` are an optional origin for profile-defined relative route geometry. Profile-defined bounds belong in distinctly named route or label properties.

An implementation must distinguish absent geometry from an authored zero. Prepared elements preserve absence. A local fallback to zero is not authored intent.

## 5. Containment

`containerId` belongs only to entities. A string value creates semantic containment; `null` places the entity at the document root. Containment does not require DOM nesting.

Which entities are containers is `x-is-container` on the tag, or an authored `isContainer` on the entity. Missing container references, references to connections or non-containers, and containment cycles are invalid.

## 6. Schema vocabulary

Profile schemas use MDP's closed JSON Schema draft-07 subset. The machine-readable subset is published as the tag-schema meta-schema. A profile schema containing any other JSON Schema keyword is invalid.

The structural subset: `type`, `const`, `enum`, `anyOf`, `not`, `properties`, `required`, `additionalProperties`, `items`, `additionalItems`, `minItems`, `maxItems`, `minLength`, `minimum`, `pattern`, and `default`.

`default` is a scalar (`string`, `number`, `boolean`, or `null`) that must itself be a valid instance of the schema it annotates. It fills a missing property on the prepared clone; a present value, including `null`, is left alone. Defaults never write back to the authored document. A required property, a core geometry property (`x`, `y`, `width`, `height`), and the tag-schema root must not declare `default`.

| Keyword          | Meaning                                                  |
| ---------------- | -------------------------------------------------------- |
| `x-schema-kind`  | Root tag classification: `entity` or `connection`.       |
| `x-is-container` | Entity tag members are containers (`true` at the root).  |
| `x-content`      | Content parsing and sanitization policy.                 |
| `x-css-color`    | Apply the strict CSS-color grammar before style binding. |
| `x-icon-name`    | Resolve the value through the configured icon loader.    |
| `x-ref`          | Treat the value as an element reference.                 |
| `x-palette`      | Accept a library palette token or a raw CSS color.       |

These are annotations to a generic JSON Schema validator; a consumer must not silently give a recognized keyword different semantics. `x-palette` annotates a string schema and is invalid without a profile `palette`, and invalid on the same schema as `x-css-color`.

## 7. Component contract

A template file has a name, one HTML `<template name="Name">`, and bare-selector CSS. Its content root carries `data-tpl="Name"`. A conforming engine implements `data-each`, `data-use`, `data-props`, `data-if`, `data-slot`, `data-role`, `data-part`, and `data-text-grow-policy` plus `{{path}}` substitution. It never evaluates template JavaScript.

`data-role` values come from `DATA_ROLES`; `data-text-grow-policy` values come from `TEXT_SIZE_POLICIES`; `data-part` values are profile-defined. These names are reserved inside MDP templates.

A portable library carries a `manifest`, per-tag `schemas`, `templates`, `baseCss`, and optionally `subTemplates`, a `palette`, and a `defaultConnectionTag`. `palette` maps token names matching `[A-Za-z][A-Za-z0-9_-]{0,63}` to CSS colors; each token becomes a legal value for every palette-annotated property, and resolution replaces the token with its color. A palette is data, not code — nothing executes it, which is why an implementation may accept one from an untrusted author.

## 8. Rendered DOM namespace

MDP-owned metadata in rendered or serialized HTML uses the `data-mdp-*` namespace:

- `data-mdp-id` identifies the source element represented by a mount host;
- `data-mdp-tag` identifies the template tag and is the CSS-isolation boundary.

Additional renderer-generated `data-mdp-*` attributes are non-normative unless this specification lists them. Profile CSS classes and implementation APIs are outside this namespace.

## 9. Prepared payload

The prepared document is `{ entities, connections, icons }`. Items carry `tag`, not a repeated `kind`. A container entity may carry `isContainer: true`. A consumer of a serialized prepared artifact must know which profile produced it in order to recover kind.

## 10. Compatibility

The protocol is versioned by this specification. A change to the 0.x minor version may be breaking.
