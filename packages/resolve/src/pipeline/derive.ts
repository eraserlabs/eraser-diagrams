/**
 * Injected per-tag derivations. The resolver is tag-agnostic: the library supplies a normalizer
 * table (`ResolverSetup.normalizers`) and this stage applies the matching entry to the validated
 * clone — in place, no return value, mirroring normalize.ts — before the cross-ref / sanitize /
 * icon / color stages, so derived output is validated by those stages for free.
 *
 * Contract for normalizer authors: every prop a normalizer writes must be declared in the tag
 * schema (the template linter derives allowed placeholders from schema properties), and brand-new
 * top-level keys must be assigned directly on the element — the pointer machinery only resolves
 * keys that already exist.
 */
export type ElementNormalizer = (element: Record<string, unknown>) => void;

export function deriveProps(
  element: Record<string, unknown>,
  tag: string,
  normalizers: Record<string, ElementNormalizer> | undefined,
): void {
  normalizers?.[tag]?.(element);
}

/** A text run: any object with a string `text` (a `texts[]` entry, a group `title`, a Textbox). */
export type TextRun = Record<string, unknown> & { text: string };

export function isTextRun(value: unknown): value is TextRun {
  return value !== null && typeof value === 'object' && typeof (value as TextRun).text === 'string';
}

/**
 * The element's primary text run — the first text-like field in authored order: a run array,
 * a single run object, or the element itself when its text sits at the root. Reads the data, not
 * a field name, so a normalizer written against it works for any library's schema.
 */
export function primaryTextRun(element: Record<string, unknown>): TextRun | undefined {
  for (const value of Object.values(element)) {
    if (Array.isArray(value)) {
      const first = value.find(isTextRun);

      if (first !== undefined) {
        return first;
      }
    } else if (isTextRun(value)) {
      return value;
    }
  }

  return isTextRun(element) ? element : undefined;
}
