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
