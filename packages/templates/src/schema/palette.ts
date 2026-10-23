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

/**
 * The canvas's shape fill for each palette token (the pastel swatch a Shape is filled with on the Eraser canvas): a
 * Shape whose `color` is a token is filled with this, not with the identity colour.
 */
export const STOCK_PASTEL: Record<string, string> = {
  white: '#ffffff',
  yellow: '#f7f8c0',
  green: '#c0f8d0',
  blue: '#c7dcfc',
  purple: '#f4c0f8',
  red: '#f8c0c0',
  orange: '#f8d8c0',
  black: '#e4e4e4',
};
