import type { ValidateFunction } from 'ajv';
import type { ElementKind } from '@eraserlabs/protocol/schema';
import type { Issue } from '../result-types.js';
import { ERROR_CODE, SEVERITY } from '../result-types.js';
import { quote, suggest } from '../schema/errors.js';
import type { ElementList } from './input.js';
import { stageSchema } from './validate.js';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * One candidate element that survived the per-element pass: cloned, schema-checked, and
 * classified. Every later stage reads `path` for pointers and `kind` for classification — neither
 * is recomputed downstream.
 */
export interface PipelineElement {
  /** Index within its own submitted list. */
  index: number;
  /** JSON pointer to this element in the document as submitted, e.g. '/entities/2' or '/elements/5'. */
  path: string;
  tag: string;
  kind: ElementKind;
  /** The mutable clone every stage reads and writes. */
  element: Record<string, unknown>;
  /**
   * The submitted object itself, never mutated: the schema stage clones before anything touches
   * it. `resolve` hands this back so a measured-JSON output can be rebuilt from the author's own
   * document rather than from library-interpreted values.
   */
  source: Record<string, unknown>;
}

/** The compiled per-tag registry the loop dispatches against. */
export interface ElementRegistry {
  knownTags: readonly string[];
  validators: Record<string, ValidateFunction>;
  rawSchemas: Record<string, object>;
  kinds: Record<string, ElementKind>;
  /** Dispatched for a tag-less member of the split form's `connections` list, when declared. */
  defaultConnectionTag?: string;
}

export interface ElementPassResult {
  elements: PipelineElement[];
  errors: Issue[];
  warnings: Issue[];
}

/**
 * The single per-element pass: prototype-pollution scan → tag dispatch (with did-you-mean) → ajv
 * schema validation → kind classification from the tag registry (`x-schema-kind`). Merging these
 * keeps one traversal of the input and lets the loop hand back the classified list directly, with
 * no parallel index bookkeeping.
 *
 * An element that fails dispatch or lands in the wrong list is dropped from the output; the errors
 * it produced already guarantee no payload is emitted.
 */
export function processElements(
  lists: readonly ElementList[],
  registry: ElementRegistry,
): ElementPassResult {
  const known = new Set(registry.knownTags);
  const elements: PipelineElement[] = [];
  const errors: Issue[] = [];
  const warnings: Issue[] = [];

  for (const list of lists) {
    // Only the split form's connections list asserts a kind, so only it can default a tag.
    const defaultTag =
      list.expectedKind === 'connection' ? registry.defaultConnectionTag : undefined;

    list.items.forEach((candidate, index) => {
      const path = `${list.prefix}/${index}`;

      scanForbiddenKeys(candidate, path, index, errors);

      const tag = dispatchTag(
        candidate,
        path,
        index,
        known,
        registry.knownTags,
        errors,
        defaultTag,
        list.expectedKind,
      );

      if (tag === undefined) {
        return;
      }

      // The per-tag schemas require `tag`, so a defaulted element validates (and its pipeline
      // clone carries the tag) via an augmented object; `source` below stays the author's own.
      const record = candidate as Record<string, unknown>;
      const forValidation = Object.hasOwn(record, 'tag') ? record : { tag, ...record };

      const schemaResult = stageSchema(
        forValidation,
        path,
        index,
        tag,
        registry.validators[tag]!,
        registry.rawSchemas[tag]!,
      );
      errors.push(...schemaResult.errors);
      warnings.push(...schemaResult.warnings);

      const kind = registry.kinds[tag]!;

      if (list.expectedKind !== undefined && kind !== list.expectedKind) {
        errors.push({
          code: ERROR_CODE.KIND_MISMATCH,
          severity: SEVERITY.ERROR,
          path,
          elementIndex: index,
          tag,
          message: `Tag ${quote(tag)} is a ${kind}, but it appears in "${list.expectedKind === 'entity' ? 'entities' : 'connections'}"; move it to "${kind === 'entity' ? 'entities' : 'connections'}".`,
        });

        return;
      }

      elements.push({
        index,
        path,
        tag,
        kind,
        element: schemaResult.clone,
        source: candidate as Record<string, unknown>,
      });
    });
  }

  return { elements, errors, warnings };
}

/**
 * Resolve one element's tag against the registry using own-key checks only (null-proto safe).
 * Unknown tags get a did-you-mean suggestion.
 */
function dispatchTag(
  candidate: unknown,
  path: string,
  index: number,
  known: ReadonlySet<string>,
  knownTags: readonly string[],
  errors: Issue[],
  defaultTag?: string,
  expectedKind?: ElementKind,
): string | undefined {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    errors.push({
      code: ERROR_CODE.MISSING_TAG,
      severity: SEVERITY.ERROR,
      path,
      elementIndex: index,
      message: 'Element must be an object with a "tag" property.',
    });

    return undefined;
  }

  const rec = candidate as Record<string, unknown>;

  if (!Object.hasOwn(rec, 'tag') || typeof rec.tag !== 'string') {
    if (defaultTag !== undefined && !Object.hasOwn(rec, 'tag')) {
      return defaultTag;
    }

    const hint =
      expectedKind === 'connection' ? ' This library declares no default connection tag.' : '';
    errors.push({
      code: ERROR_CODE.MISSING_TAG,
      severity: SEVERITY.ERROR,
      path: `${path}/tag`,
      elementIndex: index,
      message: `Element is missing a string "tag" property.${hint}`,
    });

    return undefined;
  }

  const tag = rec.tag;

  if (!known.has(tag)) {
    const issue: Issue = {
      code: ERROR_CODE.UNKNOWN_TAG,
      severity: SEVERITY.ERROR,
      path,
      elementIndex: index,
      tag,
      message: `Unknown tag ${quote(tag)}.`,
    };
    const s = suggest(tag, knownTags);

    if (s !== undefined) {
      issue.suggestion = s;
    }

    errors.push(issue);

    return undefined;
  }

  return tag;
}

/** Rejects prototype-pollution keys anywhere inside one element before it is cloned or read. */
function scanForbiddenKeys(
  value: unknown,
  path: string,
  elementIndex: number,
  errors: Issue[],
): void {
  if (!value || typeof value !== 'object') {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, i) => scanForbiddenKeys(item, `${path}/${i}`, elementIndex, errors));

    return;
  }

  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      errors.push({
        code: ERROR_CODE.FORBIDDEN_KEY,
        severity: SEVERITY.ERROR,
        path: `${path}/${key}`,
        elementIndex,
        message: `Forbidden key "${key}" is not allowed anywhere in the input.`,
      });
      continue;
    }

    scanForbiddenKeys(
      (value as Record<string, unknown>)[key],
      `${path}/${key}`,
      elementIndex,
      errors,
    );
  }
}
