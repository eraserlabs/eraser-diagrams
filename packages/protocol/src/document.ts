/**
 * An element after validation, normalization, derivation, and sanitization. Element kind remains a
 * property of the tag registry, not of each payload item.
 */
export interface ResolvedElement {
  tag: string;
  /** Always concrete; resolution synthesizes this for an authored connection that omitted it. */
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  containerId?: string | null;
  props: Record<string, unknown>;
}

/** Kind-refined prepared entity contract for consumers that have registry classification. */
export interface ResolvedEntity extends ResolvedElement {
  props: Record<string, unknown> & { from?: never; to?: never };
  /** True when this entity is a container: the tag declares `x-is-container`, or the author set it. */
  isContainer?: true;
}

/** Kind-refined prepared connection contract for consumers that have registry classification. */
export interface ResolvedConnection extends ResolvedElement {
  width?: never;
  height?: never;
  containerId?: never;
  props: Record<string, unknown> & { from: string; to: string };
}
