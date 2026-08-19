import type { Issue } from '../result-types.js';
import { ERROR_CODE, WARNING_CODE, SEVERITY } from '../result-types.js';
import type { PolicyEntry, IconLoader } from '../types.js';
import { suggest, quote } from '../schema/errors.js';
import { sanitizeSvg } from '../icons/svg-sanitize.js';
import type { PipelineElement } from './element.js';
import { resolvePointer } from './pointer.js';

/** A neutral placeholder shown when an icon name is unknown (default `onUnknownIcon`). */
export const PLACEHOLDER_GLYPH =
  '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="18" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 8l8 8M16 8l-8 8" stroke="currentColor" stroke-width="2"/></svg>';

/** Concurrent icon loads per call — a slow icon host must not serialize the whole batch. */
const LOAD_CONCURRENCY = 8;

/**
 * Resolver-level icon cache. Positive entries hold sanitized SVG; negative entries (`null`) record
 * a name the loader failed on (missing, network error, or rejected by the SVG sanitizer) so it is
 * never refetched.
 */
export type IconCache = Map<string, string | null>;

export interface IconStageResult {
  errors: Issue[];
  warnings: Issue[];
  /** Unique icon names shipped in the sidecar (placeholders included). */
  inlined: number;
  /** Icon-name → sanitized SVG sidecar for this call. */
  icons: Record<string, string>;
}

export type IconMode = 'validate' | 'resolve';

interface IconHit {
  index: number;
  tag: string;
  name: string;
  path: string;
}

/**
 * Element props keep the icon *name*; the SVG travels once per name in the
 * `icons` sidecar. In `resolve` mode, names missing from the cache are loaded concurrently
 * (capped), sanitized fail-closed, and cached — including negative entries. In `validate` mode the
 * loader is never called: only cache-known-missing names are reported, anything else is skipped.
 */
export async function stageIcons(
  items: readonly PipelineElement[],
  policyTables: Record<string, PolicyEntry[]>,
  cache: IconCache,
  loader: IconLoader | undefined,
  mode: IconMode,
  onUnknownIcon: 'placeholder' | 'error',
): Promise<IconStageResult> {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const icons: Record<string, string> = Object.create(null);

  const hits: IconHit[] = [];

  for (const { index, path: elementPath, tag, element } of items) {
    const iconEntries = (policyTables[tag] ?? []).filter((e) => e.kind === 'icon-name');

    for (const entry of iconEntries) {
      for (const hit of resolvePointer(element, entry.pointer)) {
        if (typeof hit.value === 'string') {
          hits.push({ index, tag, name: hit.value, path: `${elementPath}${hit.path}` });
        }
      }
    }
  }

  if (mode === 'resolve' && loader) {
    const missing = [...new Set(hits.map((h) => h.name))].filter((name) => !cache.has(name));
    await loadInBatches(missing, loader, cache);
  }

  for (const { index, tag, name, path } of hits) {
    const cached = cache.get(name);

    if (typeof cached === 'string') {
      if (mode === 'resolve') {
        icons[name] = cached;
      }

      continue;
    }

    if (mode === 'validate' && cached === undefined) {
      // Not in the cache and validate never fetches — skip rather than guess.
      continue;
    }

    if (onUnknownIcon === 'error') {
      errors.push(
        unknownIconIssue(ERROR_CODE.UNKNOWN_ICON, SEVERITY.ERROR, cache, {
          index,
          tag,
          name,
          path,
        }),
      );
      continue;
    }

    warnings.push(
      unknownIconIssue(WARNING_CODE.UNKNOWN_ICON, SEVERITY.WARNING, cache, {
        index,
        tag,
        name,
        path,
      }),
    );

    if (mode === 'resolve') {
      icons[name] = PLACEHOLDER_GLYPH;
    }
  }

  return { errors, warnings, inlined: Object.keys(icons).length, icons };
}

async function loadInBatches(names: string[], loader: IconLoader, cache: IconCache): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(LOAD_CONCURRENCY, names.length) }, async () => {
    while (next < names.length) {
      const name = names[next]!;
      next += 1;
      cache.set(name, await loadOne(name, loader));
    }
  });
  await Promise.all(workers);
}

async function loadOne(name: string, loader: IconLoader): Promise<string | null> {
  let raw: string;

  try {
    raw = await loader(name);
  } catch {
    return null;
  }

  const result = sanitizeSvg(raw);

  return result.ok ? result.svg! : null;
}

function unknownIconIssue(
  code: Issue['code'],
  severity: Issue['severity'],
  cache: IconCache,
  hit: IconHit,
): Issue {
  const issue: Issue = {
    code,
    severity,
    path: hit.path,
    elementIndex: hit.index,
    tag: hit.tag,
    message:
      severity === 'error'
        ? `Unknown icon ${quote(hit.name)}.`
        : `Unknown icon ${quote(hit.name)}; using a placeholder glyph.`,
  };
  const known = [...cache.entries()].filter(([, svg]) => svg !== null).map(([name]) => name);
  const s = suggest(hit.name, known);

  if (s !== undefined) {
    issue.suggestion = s;
  }

  return issue;
}
