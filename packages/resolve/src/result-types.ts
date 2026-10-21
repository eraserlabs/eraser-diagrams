import type { ResolvedConnection, ResolvedEntity } from '@eraserlabs/protocol';
import type { ElementKind } from '@eraserlabs/protocol/schema';
import type { AuthoredRecord } from './types.js';

/**
 * Validation/result vocabulary owned by @eraserlabs/resolve alone — render and layout never see a failed
 * input (resolve blocks those before anything downstream runs), so these are not shared types.
 */

/**
 * Error codes abort the render payload; warning codes do not. Values are the stable wire contract — reference
 * them through the `ERROR_CODE` / `WARNING_CODE` constants (autocomplete, single source, no magic
 * strings) rather than retyping the literals.
 */
export const ERROR_CODE = {
  // Engine errors (any => no payload)
  /** The submitted document is not a recognized `elements` / `entities`+`connections` envelope. */
  ENVELOPE: 'E_ENVELOPE',
  FORBIDDEN_KEY: 'E_FORBIDDEN_KEY',
  MISSING_TAG: 'E_MISSING_TAG',
  UNKNOWN_TAG: 'E_UNKNOWN_TAG',
  /** A tag whose schema declares one kind appeared in the list for the other. */
  KIND_MISMATCH: 'E_KIND_MISMATCH',
  SCHEMA: 'E_SCHEMA',
  DUPLICATE_ID: 'E_DUPLICATE_ID',
  MISSING_REF: 'E_MISSING_REF',
  REF_TO_CONNECTION: 'E_REF_TO_CONNECTION',
  /** `containerId` names an entity that is not a container. */
  NOT_CONTAINER: 'E_NOT_CONTAINER',
  CONTAINER_CYCLE: 'E_CONTAINER_CYCLE',
  INVALID_COLOR: 'E_INVALID_COLOR',
  UNKNOWN_ICON: 'E_UNKNOWN_ICON',
  // Transport errors (server layer)
  BAD_JSON: 'E_BAD_JSON',
  PAYLOAD_TOO_LARGE: 'E_PAYLOAD_TOO_LARGE',
} as const;
export type ErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE];

export const WARNING_CODE = {
  UNKNOWN_PROP: 'W_UNKNOWN_PROP',
  /** An unrecognized key at the top level of the submitted document; ignored. */
  UNKNOWN_KEY: 'W_UNKNOWN_KEY',
  CONTENT_SANITIZED: 'W_CONTENT_SANITIZED',
  UNKNOWN_ICON: 'W_UNKNOWN_ICON',
} as const;
export type WarningCode = (typeof WARNING_CODE)[keyof typeof WARNING_CODE];

export type IssueCode = ErrorCode | WarningCode;

export const SEVERITY = {
  ERROR: 'error',
  WARNING: 'warning',
} as const;
export type Severity = (typeof SEVERITY)[keyof typeof SEVERITY];

/** A single validation finding, pinned to a location in the input. */
export interface Issue {
  code: IssueCode;
  severity: Severity;
  /**
   * JSON pointer into the document as submitted: '/elements/3/texts/0/text' for the `elements`
   * envelope, '/entities/3/…' or '/connections/0/…' for the split envelope.
   */
  path: string;
  /** Index within the element's own list, not across the document. */
  elementIndex?: number;
  elementId?: string;
  tag?: string;
  /** One sentence, offending value quoted (truncated to 60 chars). */
  message: string;
  /** did-you-mean for enum / name / icon / prop misses. */
  suggestion?: string;
}

export interface ResolveMeta {
  /** Entities plus connections — the whole document, however it was submitted. */
  elementCount: number;
  iconsInlined: number;
  /** Wall-clock per pipeline stage, milliseconds. `icons` includes loader fetch time. */
  timingsMs?: Record<string, number>;
}

/**
 * Result of `resolve()`. `entities`, `connections`, and `icons` are present only when `ok`.
 * Classification happened once, inside the pipeline; the split lists carry it downstream so no
 * consumer re-derives kind from the tag registry.
 */
export interface ResolveResult {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  /** The resolved nodes — what the browser render stage mounts and measures. */
  entities?: ResolvedEntity[];
  /** The resolved edges — what the browser render stage routes. */
  connections?: ResolvedConnection[];
  /** Icon-name → sanitized SVG sidecar for the names this call's elements reference. */
  icons?: Record<string, string>;
  /**
   * Every resolved element's pristine authored object, in document order, keyed to the id the
   * payload and the layout results use. This is the sidecar a measured-JSON output is rebuilt
   * from: the resolver's own interpretation of the document never leaks into what is handed back
   * to the author.
   */
  authored?: AuthoredRecord[];
  meta: ResolveMeta;
}

/** Result of `validate()` — the full pipeline minus icon loading, never a payload. */
export interface ValidationResult {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
}

/** Per-tag summary returned by the registry route (LLM tool discovery). */
export interface TagInfo {
  tag: string;
  kind: ElementKind;
  requiredProps: string[];
  /** Present when the tag schema declares `x-is-container`. */
  container?: true;
}

export interface RegistryInfo {
  tags: TagInfo[];
  /**
   * The tag dispatched for a tag-less connection in the split `{ entities, connections }` form,
   * when the library declares one — tool-building consumers can teach an LLM to omit it.
   */
  defaultConnectionTag?: string;
}
