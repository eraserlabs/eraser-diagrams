import type { PipelineElement } from './element.js';

const SYNTHETIC_CONNECTION_PREFIX = '@connection';

/**
 * Assign ids to authored connections that omitted them. This runs after schema validation (so a
 * profile may still require an authored id) and before every mutating/semantic resolver stage.
 *
 * The endpoint-derived base is stable for a stable authored document. A per-(tag, from, to)
 * occurrence distinguishes parallel edges, while the final probe protects explicit ids — including
 * explicit ids that appear later in the document — from ever being shadowed by generated ones.
 */
export function assignMissingConnectionIds(items: readonly PipelineElement[]): void {
  const usedIds = new Set<string>();
  const occurrences = new Map<string, number>();

  for (const { element } of items) {
    if (typeof element.id === 'string') {
      usedIds.add(element.id);
    }
  }

  for (const { index, tag, kind, element } of items) {
    if (typeof element.id === 'string' || kind !== 'connection') {
      continue;
    }

    // Valid connections have string endpoints. The index fallback keeps later stages safe and
    // deterministic even when schema validation has already recorded an endpoint type error.
    const from = identityPart(element.from, `invalid-from-${index}`);
    const to = identityPart(element.to, `invalid-to-${index}`);
    const encodedTag = encodeIdentityPart(tag);
    const tuple = `${encodedTag}\u0000${from}\u0000${to}`;
    const occurrence = (occurrences.get(tuple) ?? 0) + 1;
    occurrences.set(tuple, occurrence);

    const base = `${SYNTHETIC_CONNECTION_PREFIX}:${encodedTag}:${from}:${to}:${occurrence}`;
    let id = base;
    let probe = 2;

    while (usedIds.has(id)) {
      id = `${base}~${probe}`;
      probe += 1;
    }

    element.id = id;
    usedIds.add(id);
  }
}

function identityPart(value: unknown, fallback: string): string {
  return encodeIdentityPart(typeof value === 'string' ? value : fallback);
}

/** URI encoding keeps the generated form readable without making separators ambiguous. */
function encodeIdentityPart(value: string): string {
  return encodeURIComponent(toWellFormed(value));
}

/** `encodeURIComponent` throws on lone UTF-16 surrogates; JSON strings may legally contain them. */
function toWellFormed(value: string): string {
  let output = '';

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);

      if (next >= 0xdc00 && next <= 0xdfff) {
        output += value.slice(index, index + 2);
        index += 1;
      } else {
        output += '\ufffd';
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      output += '\ufffd';
    } else {
      output += value.charAt(index);
    }
  }

  return output;
}
