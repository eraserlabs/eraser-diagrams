import type { TemplateFile } from '@eraserlabs/protocol';

/**
 * Merge override templates over stock by name (later wins). Stock order is preserved; a replaced
 * entry keeps its position; genuinely new override names are appended.
 */
export function mergeTemplates(stock: TemplateFile[], overrides: TemplateFile[]): TemplateFile[] {
  const overrideByName = new Map(overrides.map((o) => [o.name, o]));
  const seen = new Set<string>();
  const merged: TemplateFile[] = stock.map((s) => {
    seen.add(s.name);

    return overrideByName.get(s.name) ?? s;
  });

  for (const o of overrides) {
    if (!seen.has(o.name)) {
      merged.push(o);
    }
  }

  return merged;
}
