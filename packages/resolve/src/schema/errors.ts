import type { ErrorObject } from 'ajv';
import { distance } from 'fastest-levenshtein';
import type { Issue } from '../result-types.js';
import { ERROR_CODE, SEVERITY } from '../result-types.js';

/** Suggest the closest candidate within an edit-distance budget (≤2 absolute or ≤40% of length). */
export function suggest(value: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;

  for (const c of candidates) {
    const d = distance(value.toLowerCase(), c.toLowerCase());

    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }

  if (best === undefined) {
    return undefined;
  }

  const budget = Math.max(2, Math.floor(value.length * 0.4));

  return bestDist <= budget ? best : undefined;
}

/** Quote and truncate an offending value for a one-sentence message. */
export function quote(value: unknown): string {
  let s: string;

  if (typeof value === 'string') {
    s = value;
  } else {
    try {
      s = JSON.stringify(value) ?? String(value);
    } catch {
      s = String(value);
    }
  }

  if (s.length > 60) {
    s = `${s.slice(0, 57)}…`;
  }

  return `"${s}"`;
}

/** Convert one AJV error (already known NOT to be additionalProperties) into an Issue. */
export function formatAjvError(
  err: ErrorObject,
  elementPath: string,
  elementIndex: number,
  elementId: string | undefined,
  tag: string,
  data: unknown,
  rawSchema?: object,
): Issue {
  // AJV instancePath is relative to the validated element; prefix with the element's own pointer.
  const path = `${elementPath}${err.instancePath}`;
  const base = { severity: SEVERITY.ERROR, path, elementIndex, tag, code: ERROR_CODE.SCHEMA };

  if (elementId !== undefined) {
    Object.assign(base, { elementId });
  }

  switch (err.keyword) {
    case 'enum': {
      const allowed = (err.params.allowedValues as string[] | undefined) ?? [];
      const actual = valueAtInstancePath(data, err.instancePath);
      const issue: Issue = {
        ...base,
        message: `Invalid value ${quote(actual)} at ${path}; expected one of ${allowed.map((v) => `"${v}"`).join(', ')}.`,
      };

      if (typeof actual === 'string') {
        const s = suggest(actual, allowed);

        if (s !== undefined) {
          issue.suggestion = s;
        }
      }

      return issue;
    }

    case 'required': {
      const missing = err.params.missingProperty as string;

      return { ...base, message: `Missing required property "${missing}" at ${path || '/'}.` };
    }

    case 'type': {
      const actual = valueAtInstancePath(data, err.instancePath);

      return {
        ...base,
        message: `Property at ${path} must be ${String(err.params.type)}, got ${quote(actual)}.`,
      };
    }

    case 'const': {
      const actual = valueAtInstancePath(data, err.instancePath);

      return {
        ...base,
        message: `Property at ${path} must equal ${quote(err.params.allowedValue)}, got ${quote(actual)}.`,
      };
    }

    case 'not': {
      const forbidden = forbiddenProperties(rawSchema, err.schemaPath);
      const value = valueAtInstancePath(data, err.instancePath);
      const hit = forbidden.find(
        (name) => value !== null && typeof value === 'object' && Object.hasOwn(value, name),
      );

      if (hit === undefined) {
        break;
      }

      return {
        ...base,
        message: `Property "${hit}" is not allowed on tag "${tag}" at ${path || '/'}.`,
      };
    }
  }

  return {
    ...base,
    message: `Schema violation at ${path || '/'}: ${err.message ?? err.keyword}.`,
  };
}

/**
 * Single properties a failed `not` forbids. Kind exclusions are `not.anyOf` of one-name
 * `required` schemas; a multi-name `required` inside `not` is ignored here and falls through to
 * the generic AJV message. The bare AJV text ("must NOT be valid") never names the property.
 */
function forbiddenProperties(rawSchema: object | undefined, schemaPath: string): string[] {
  const node = resolveSchemaPath(rawSchema, schemaPath);

  if (node === undefined) {
    return [];
  }

  const branches = Array.isArray(node['anyOf']) ? (node['anyOf'] as unknown[]) : [node];

  return branches
    .filter(
      (branch): branch is Record<string, unknown> => branch !== null && typeof branch === 'object',
    )
    .map((branch) => (Array.isArray(branch['required']) ? (branch['required'] as string[]) : []))
    .filter((group) => group.length === 1)
    .map((group) => group[0]!);
}

/** Resolve an AJV `schemaPath` ("#/properties/texts/items/not") against the raw tag schema. */
function resolveSchemaPath(
  rawSchema: object | undefined,
  schemaPath: string,
): Record<string, unknown> | undefined {
  if (rawSchema === undefined || !schemaPath.startsWith('#/')) {
    return undefined;
  }

  let node: unknown = rawSchema;

  for (const part of schemaPath.slice(2).split('/')) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');

    if (node === null || typeof node !== 'object') {
      return undefined;
    }

    node = (node as Record<string, unknown>)[key];
  }

  return node !== null && typeof node === 'object' ? (node as Record<string, unknown>) : undefined;
}

function valueAtInstancePath(root: unknown, instancePath: string): unknown {
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
