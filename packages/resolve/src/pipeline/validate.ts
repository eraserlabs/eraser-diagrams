import type { ValidateFunction } from 'ajv';
import type { Issue } from '../result-types.js';
import { WARNING_CODE, SEVERITY } from '../result-types.js';
import { formatAjvError, suggest } from '../schema/errors.js';

export interface SchemaStageResult {
  /** The element with unknown properties stripped; safe to pass downstream. */
  clone: Record<string, unknown>;
  errors: Issue[];
  warnings: Issue[];
}

/**
 * Validates one element against its tag schema. `additionalProperties` violations
 * become `W_UNKNOWN_PROP` warnings and the offending keys are stripped from a clone; every other
 * violation is an `E_SCHEMA` error. Schemas forbid `dependentRequired`, so stripping is always safe.
 */
export function stageSchema(
  element: Record<string, unknown>,
  elementPath: string,
  index: number,
  tag: string,
  validator: ValidateFunction,
  rawSchema: object,
): SchemaStageResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  // Validate the clone so `useDefaults` cannot write schema defaults onto the authored source.
  const clone = structuredClone(element);
  const elementId = typeof element.id === 'string' ? element.id : undefined;

  const valid = validator(clone);

  if (valid) {
    return { clone, errors, warnings };
  }

  for (const err of validator.errors ?? []) {
    if (err.keyword === 'additionalProperties') {
      const extra = err.params.additionalProperty as string;
      const path = `${elementPath}${err.instancePath}/${extra}`;
      const parent = navigate(clone, err.instancePath);

      if (parent && typeof parent === 'object') {
        delete (parent as Record<string, unknown>)[extra];
      }

      const warning: Issue = {
        code: WARNING_CODE.UNKNOWN_PROP,
        severity: SEVERITY.WARNING,
        path,
        elementIndex: index,
        tag,
        message: `Unknown property "${extra}" was ignored.`,
      };
      const candidates = propsAt(rawSchema, err.instancePath);
      const s = suggest(extra, candidates);

      if (s !== undefined) {
        warning.suggestion = s;
      }

      if (elementId !== undefined) {
        warning.elementId = elementId;
      }

      warnings.push(warning);
      continue;
    }

    errors.push(formatAjvError(err, elementPath, index, elementId, tag, element, rawSchema));
  }

  return { clone, errors, warnings };
}

function navigate(root: unknown, instancePath: string): unknown {
  if (instancePath === '') {
    return root;
  }

  const parts = instancePath
    .split('/')
    .slice(1)
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur: unknown = root;

  for (const part of parts) {
    if (cur && typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }

  return cur;
}

/** Candidate property names at a given instancePath within the schema (best-effort, for suggestions). */
function propsAt(schema: object, instancePath: string): string[] {
  let node = schema as Record<string, unknown>;
  const parts = instancePath === '' ? [] : instancePath.split('/').slice(1);

  for (const part of parts) {
    const props = node.properties as Record<string, Record<string, unknown>> | undefined;

    if (/^\d+$/.test(part)) {
      const items = node.items as Record<string, unknown> | undefined;

      if (!items) {
        return [];
      }

      node = items;
    } else if (props?.[part]) {
      node = props[part];
    } else {
      return [];
    }
  }

  const props = node.properties as Record<string, unknown> | undefined;

  return props ? Object.keys(props) : [];
}
