/**
 * Palette identities: token → one CSS color bound to `--er-color`. Templates derive body fill,
 * hairline, and tints via relative-color formulas over this value, e.g.
 * `hsl(from var(--er-color) h s 85%)`. Author `bgColor` / `borderColor` outrank the formulas.
 *
 * The `white` token is near-black (hairline); for an opaque white body set `bgColor: '#ffffff'`.
 */
export const STOCK_PALETTE: Record<string, string> = {
  white: '#242424',
  yellow: '#d3d61e',
  green: '#30a050',
  blue: '#2866c4',
  purple: '#c43dcf',
  red: '#bd413a',
  orange: '#c38424',
  black: '#3a3a3a',
};

export const STOCK_PALETTE_TOKENS: readonly string[] = Object.keys(STOCK_PALETTE);
