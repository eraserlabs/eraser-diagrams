import type { Issue } from '../result-types.js';
import { ERROR_CODE, SEVERITY } from '../result-types.js';
import type { PolicyEntry } from '../types.js';
import { quote, suggest } from '../schema/errors.js';
import { isValidColor } from './colors.js';
import type { PipelineElement } from './element.js';
import { resolvePointer } from './pointer.js';

/**
 * Schema-annotation-driven canonicalization: the annotations that rewrite an authored value into
 * the one canonical form later stages and templates bind. Applied as a stage-3 post-pass, before
 * per-tag normalizers, so `emit` stays a pure concatenation. Mutates the element clone in place —
 * never the authored source, which the measured-JSON output is rebuilt from.
 *
 * - `x-palette` replaces a palette token name with the library's color for it. A value that is not
 *   a token must be a raw CSS color in the strict grammar; anything else is an error carrying a
 *   did-you-mean over the token names. Lookup is exact: a
 *   near-miss should be corrected, not silently reinterpreted.
 */
const GEOMETRY_KEYS = ['x', 'y', 'width', 'height'] as const;

function roundInPlace(record: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === 'number' && Number.isFinite(value)) {
      record[key] = Math.round(value);
    }
  }
}

/**
 * Canonicalize authored geometry to the integer grid: `x`/`y`/`width`/`height` on every element,
 * plus a connection's route `points` and `labelPlacement`. App exports and measured-JSON round
 * trips carry float dust (`y: 14.999999999999886`); the layout engine works on integers anyway,
 * so nearest-integer is a normalization, not a loss. Applied to the working clone — the authored
 * source stays pristine, same as every other canonicalization.
 */
export function roundAuthoredGeometry(element: Record<string, unknown>): void {
  roundInPlace(element, GEOMETRY_KEYS);

  const points = element.points;

  if (Array.isArray(points)) {
    for (const point of points) {
      if (typeof point === 'object' && point !== null && !Array.isArray(point)) {
        roundInPlace(point as Record<string, unknown>, ['x', 'y']);
      }
    }
  }

  const label = element.labelPlacement;

  if (typeof label === 'object' && label !== null && !Array.isArray(label)) {
    roundInPlace(label as Record<string, unknown>, GEOMETRY_KEYS);
  }
}

export function normalizeAnnotatedProps(
  item: PipelineElement,
  entries: PolicyEntry[],
  palette: Record<string, string> | undefined,
): Issue[] {
  const { element, path: elementPath, index, tag } = item;
  const errors: Issue[] = [];

  for (const entry of entries) {
    if (entry.kind !== 'palette') {
      continue;
    }

    // Boot rejects `x-palette` in a library with no palette, so an absent map here means the
    // schema and the library disagree — treat every value as raw rather than inventing tokens.
    const tokens = palette ?? {};

    for (const hit of resolvePointer(element, entry.pointer)) {
      if (typeof hit.value !== 'string') {
        continue;
      }

      if (Object.hasOwn(tokens, hit.value)) {
        hit.set(tokens[hit.value]);
        continue;
      }

      if (isValidColor(hit.value)) {
        continue;
      }

      const issue: Issue = {
        code: ERROR_CODE.INVALID_COLOR,
        severity: SEVERITY.ERROR,
        path: `${elementPath}${hit.path}`,
        elementIndex: index,
        tag,
        message: `${quote(hit.value)} at ${elementPath}${hit.path} is neither a palette token nor a CSS color.`,
      };
      const s = suggest(hit.value, Object.keys(tokens));

      if (s !== undefined) {
        issue.suggestion = s;
      }

      errors.push(issue);
      // Drop the rejected value. The document is already failing, so nothing will be emitted;
      // clearing it keeps the `css-color` half of this annotation from reporting the same string
      // a second time from the colour stage.
      hit.set(undefined);
    }
  }

  return errors;
}
