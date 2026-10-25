import type { Theme } from '@eraserlabs/protocol';
import type { PolicyEntry } from '../types.js';
import type { PipelineElement } from './element.js';
import { resolvePointer } from './pointer.js';
import { scaleColorForTheme } from '../colors/theme.js';

/**
 * Transform final paints after palette lookup, all derivations, and color validation. The schema
 * identifies colors, including nested runs and badges; template names and arbitrary SVG/content
 * strings have no role here. Each path is converted once even when schema branches overlap.
 */
export function applyColorTheme(
  elements: readonly PipelineElement[],
  tables: Record<string, PolicyEntry[]>,
  theme: Theme,
): void {
  if (theme === 'light') {
    return;
  }
  for (const { tag, element } of elements) {
    const converted = new Set<string>();
    for (const entry of tables[tag] ?? []) {
      if (entry.kind !== 'css-color') {
        continue;
      }
      for (const hit of resolvePointer(element, entry.pointer)) {
        if (typeof hit.value === 'string' && !converted.has(hit.path)) {
          hit.set(scaleColorForTheme(hit.value, theme));
          converted.add(hit.path);
        }
      }
    }
  }
}
