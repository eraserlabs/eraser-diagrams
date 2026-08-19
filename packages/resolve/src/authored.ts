/**
 * The authored (pre-resolution) input grammar. It lives here rather than in `@eraserlabs/protocol`
 * because it is the shape *this* package's `validate`/`resolve` accept — protocol owns the
 * resolved contracts and the schema machinery, not the input envelope.
 *
 * Every one of these types is advisory: `validate()` and `resolve()` take `unknown` and prove the
 * shape at runtime. They exist so a TypeScript caller can write `satisfies DiagramInput` and get
 * the obvious mistakes (a connection in `entities`, a missing `connections: []`) at compile time.
 */

/**
 * One authored node. Kind is inferred from the tag's schema (`x-schema-kind`), never repeated on
 * the element; the `from`/`to` markers only stop an editor from offering connection endpoints
 * here.
 */
export interface AuthoredEntity {
  tag: string;
  id: string;
  /** Optional non-negative coordinate; absent lets layout place the entity. */
  x?: number;
  /** Optional non-negative coordinate; absent lets layout place the entity. */
  y?: number;
  /** Optional non-negative minimum width; absent delegates preferred sizing to the renderer. */
  width?: number;
  /** Optional non-negative minimum height; absent delegates preferred sizing to the renderer. */
  height?: number;
  /** Null explicitly means no container. */
  containerId?: string | null;
  from?: never;
  to?: never;
  /** Tag-specific props sit flat beside the core fields. */
  [prop: string]: unknown;
}

/**
 * One authored edge. Endpoints are required; the id is optional and is synthesized during
 * resolution when omitted. Bounds and containment are not part of the connection core.
 */
export interface AuthoredConnection {
  /**
   * Omittable only in the split `{ entities, connections }` form when the library declares a
   * `defaultConnectionTag` (the stock library defaults to `Relationship`); required in the
   * `{ elements }` form, where the list asserts no kind.
   */
  tag?: string;
  id?: string;
  from: string;
  to: string;
  /** Tag-specific props sit flat beside the core fields. */
  [prop: string]: unknown;
}

export type AuthoredElement = AuthoredEntity | AuthoredConnection;

/**
 * A diagram as submitted. The union is deliberately strict: either you hand over one interleaved
 * `elements` list, or you hand over BOTH `entities` and `connections`. Writing `connections: []`
 * is the point of the split form — it makes "this diagram has no edges" a statement rather than an
 * omission. Mixing the two forms is an error.
 *
 * A document is always this object envelope: a bare `AuthoredElement[]` is rejected at runtime
 * with `E_ENVELOPE`, and no layer wraps one on the author's behalf.
 *
 * The element lists are `readonly` because nothing here ever writes to them — the pipeline works
 * on its own clones — so a document written `as const` (readonly tuples) satisfies this type as
 * readily as a mutable array does.
 */
export type DiagramInput =
  | { elements: readonly AuthoredElement[]; title?: string }
  | {
      entities: readonly AuthoredEntity[];
      connections: readonly AuthoredConnection[];
      title?: string;
    };
