# @eraserlabs/protocol

## Introduction

`@eraserlabs/protocol` is the TypeScript and JSON Schema distribution of the Model Diagramming Protocol (MDP). MDP describes diagram elements, their visual templates, and the contracts that carry them through resolution, measurement, layout, and rendering. The protocol is vocabulary-neutral; this package is the reference distribution, and `@eraserlabs/diagrams` ships one MDP profile on top of it.

The package contains no resolver, browser, layout, filesystem, or network implementation.

## Why

Resolve, render, and layout need a shared document and schema vocabulary. Putting those contracts in the packages that implement them would couple every consumer to Node, Chromium, or a particular profile. MDP keeps the wire shapes and annotations in one place; implementations and profiles stay replaceable.

## Usage

```ts
import type { ResolvedDocument } from '@eraserlabs/protocol';
import { entitySchema } from '@eraserlabs/protocol/schema';
```

| Export | Contents |
| --- | --- |
| `@eraserlabs/protocol` | MDP identifiers, resolved document/template/font contracts, semantic DOM roles |
| `@eraserlabs/protocol/schema` | JSON Schema subset, `x-schema-kind` / `x-is-container` and property annotations, kind helpers |
| `@eraserlabs/protocol/schemas/document` | Base authored-document JSON Schema |
| `@eraserlabs/protocol/schemas/tag-schema` | Meta-schema for a profile tag against the MDP 0.1 subset |

Authored TypeScript input shapes (`DiagramInput` and related) live in `@eraserlabs/resolve`, which owns the input grammar. The protocol text is `SPEC.md`.
