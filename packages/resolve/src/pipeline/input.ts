import type { ElementKind } from '@eraserlabs/protocol/schema';
import type { Issue } from '../result-types.js';
import { ERROR_CODE, SEVERITY, WARNING_CODE } from '../result-types.js';

/** One submitted list of candidate elements, with the JSON pointer it lives at. */
export interface ElementList {
  items: unknown[];
  /** Pointer prefix for members: '/elements', '/entities', or '/connections'. */
  prefix: string;
  /** Set only for the split form, where the list itself asserts the kind of its members. */
  expectedKind?: ElementKind;
}

export interface NormalizedInput {
  lists: ElementList[];
  errors: Issue[];
  warnings: Issue[];
}

/** Recognized but inert at this layer: carried by fixtures and app exports, never rendered. */
const DOCUMENT_KEYS = new Set(['title']);

/**
 * Keys a render call may set on the same object. `resolve` ignores them silently so a complete
 * render request validates as-is, with no warning noise.
 */
const RESERVED_KEYS = new Set(['outputs']);

const ENVELOPE_ADVICE = 'Expected { elements: [...] } or { entities: [...], connections: [...] }.';

function envelopeError(message: string): Issue {
  return { code: ERROR_CODE.ENVELOPE, severity: SEVERITY.ERROR, path: '/', message };
}

/**
 * Decide which arrays to iterate and what pointer prefix each carries. This is argument parsing,
 * not a pipeline stage: a document is always an object envelope, so every member pointer is
 * rooted at the key that named its list — `/elements/N…`, `/entities/N…`, `/connections/N…`.
 * A bare array is an envelope error, not a shorthand.
 */
export function normalizeInput(input: unknown): NormalizedInput {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];

  if (Array.isArray(input)) {
    return {
      lists: [],
      errors: [envelopeError('Input must be an object: wrap the array in { "elements": [...] }.')],
      warnings,
    };
  }

  if (!input || typeof input !== 'object') {
    return {
      lists: [],
      errors: [envelopeError(`Input must be a document. ${ENVELOPE_ADVICE}`)],
      warnings,
    };
  }

  const doc = input as Record<string, unknown>;
  const hasElements = Object.hasOwn(doc, 'elements');
  const hasEntities = Object.hasOwn(doc, 'entities');
  const hasConnections = Object.hasOwn(doc, 'connections');

  for (const key of Object.keys(doc)) {
    if (
      DOCUMENT_KEYS.has(key) ||
      RESERVED_KEYS.has(key) ||
      key === 'elements' ||
      key === 'entities' ||
      key === 'connections'
    ) {
      continue;
    }

    warnings.push({
      code: WARNING_CODE.UNKNOWN_KEY,
      severity: SEVERITY.WARNING,
      path: `/${key}`,
      message: `Unknown document key "${key}" was ignored.`,
    });
  }

  if (hasElements && (hasEntities || hasConnections)) {
    return {
      lists: [],
      errors: [
        envelopeError(
          'A document uses either "elements" or "entities" + "connections", never both.',
        ),
      ],
      warnings,
    };
  }

  if (hasElements) {
    if (!Array.isArray(doc['elements'])) {
      errors.push(envelopeError('Document key "elements" must be an array of tagged elements.'));

      return { lists: [], errors, warnings };
    }

    return { lists: [{ items: doc['elements'], prefix: '/elements' }], errors, warnings };
  }

  if (hasEntities !== hasConnections) {
    const present = hasEntities ? 'entities' : 'connections';
    const missing = hasEntities ? 'connections' : 'entities';

    return {
      lists: [],
      errors: [
        envelopeError(
          `A document with "${present}" must also declare "${missing}" (use "${missing}": [] when there are none), or use "elements" instead.`,
        ),
      ],
      warnings,
    };
  }

  if (!hasEntities) {
    return {
      lists: [],
      errors: [envelopeError(`Unrecognized document. ${ENVELOPE_ADVICE}`)],
      warnings,
    };
  }

  for (const key of ['entities', 'connections'] as const) {
    if (!Array.isArray(doc[key])) {
      errors.push(envelopeError(`Document key "${key}" must be an array.`));
    }
  }

  if (errors.length > 0) {
    return { lists: [], errors, warnings };
  }

  return {
    lists: [
      { items: doc['entities'] as unknown[], prefix: '/entities', expectedKind: 'entity' },
      {
        items: doc['connections'] as unknown[],
        prefix: '/connections',
        expectedKind: 'connection',
      },
    ],
    errors,
    warnings,
  };
}
