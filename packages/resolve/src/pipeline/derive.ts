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
export type ElementNormalizer = (
  element: Record<string, unknown>,
  context: NormalizerContext,
) => void;

/**
 * The theme a document is resolved for. `light` draws every authored colour as written; `dark` draws each colour the
 * way the Eraser canvas draws it in dark mode. A normalizer that writes colours writes them for this theme.
 */
export type Theme = 'light' | 'dark';

/** What a normalizer may read besides the element clone. */
export interface NormalizerContext {
  readonly theme: Theme;
  /**
   * The library palette token the author wrote at a top-level key (`color: 'blue'`), or undefined when the authored
   * value is no token. The `x-palette` step has already swapped such a token for its colour on the clone, so this is
   * the one way a normalizer can tell `blue` from the same colour written as hex. Read from the authored source,
   * which no stage mutates.
   */
  paletteToken(key: string): string | undefined;
}

/** The context for one element: its authored source, the library palette, the theme. */
export function normalizerContext(
  source: Record<string, unknown>,
  palette: Record<string, string> | undefined,
  theme: Theme,
): NormalizerContext {
  return {
    theme,
    paletteToken(key) {
      const value = source[key];

      return typeof value === 'string' && palette !== undefined && Object.hasOwn(palette, value)
        ? value
        : undefined;
    },
  };
}

export function deriveProps(
  element: Record<string, unknown>,
  tag: string,
  normalizers: Record<string, ElementNormalizer> | undefined,
  context: NormalizerContext,
): void {
  normalizers?.[tag]?.(element, context);
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
