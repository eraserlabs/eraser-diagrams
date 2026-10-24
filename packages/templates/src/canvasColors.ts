import { colorToHex, type Theme } from '@eraserlabs/resolve';

/**
 * The Eraser canvas's colour rules, ported without a colour library so a normalizer can write the colours a template
 * draws: the dark-mode scaling (colorRules.ts scaleColorForTheme), the black-or-white ink on a fill
 * (textColorFromPrimary), the near-white tint of a fill (getColorAtLightScale, step 1) and the border derived from a
 * fill (paletteColors.ts deriveBorderFromFill). canvasColors.test.ts pins each against values the canvas computes.
 *
 * Every function takes any colour `colorToHex` reads (hex, `rgb()`, a named colour) and returns `#rrggbb`; a colour
 * it cannot read (`transparent`, `hsl()`, a CSS variable) comes back as given.
 */

type Rgb = [number, number, number];

/** The canvas's default ink and stroke. */
export const CANVAS_INK = '#242424';
/** The canvas's hard shadow behind a shape. */
export const CANVAS_SHADOW = '#e8e8e8';
/** The canvas background in dark mode: the darkest colour dark-mode scaling gives. */
const CANVAS_DARK: Rgb = [0x17 / 255, 0x17 / 255, 0x17 / 255];

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** Channels 0..1, or null for a colour with no channel values here. */
function rgbOf(color: string): Rgb | null {
  const hex = colorToHex(color);

  if (!hex) {
    return null;
  }

  const n = Number.parseInt(hex.slice(1), 16);

  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

/**
 * A colour's alpha 0..1, as chroma-js keeps it (two decimals): from a 4- or 8-digit hex or the 4th channel of
 * `rgb()`/`rgba()`; 1 for every other form.
 */
export function alphaOf(color: string): number {
  const raw = color.trim().toLowerCase();
  const hex = /^#(?:[0-9a-f]{3}([0-9a-f])|[0-9a-f]{6}([0-9a-f]{2}))$/.exec(raw);
  let alpha = 1;

  if (hex) {
    const digits = hex[1] !== undefined ? hex[1] + hex[1] : hex[2]!;
    alpha = Number.parseInt(digits, 16) / 255;
  } else {
    const fn = /^rgba?\(([^)]*)\)$/.exec(raw);
    const part = fn?.[1]!.split(/[\s,/]+/).filter(Boolean)[3];

    if (part !== undefined) {
      alpha = part.endsWith('%') ? Number.parseFloat(part) / 100 : Number.parseFloat(part);
    }
  }

  return Number.isFinite(alpha) ? Math.round(clamp01(alpha) * 100) / 100 : 1;
}

function toHex([r, g, b]: Rgb, alpha = 1): string {
  return `#${[r, g, b]
    .map((v) =>
      Math.round(clamp01(v) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}${alpha < 1 ? Math.round(alpha * 255).toString(16).padStart(2, '0') : ''}`;
}

/** Hue 0..360 (0 for a grey), saturation and lightness 0..1. */
function toHsl([r, g, b]: Rgb): Rgb {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;

  if (d === 0) {
    return [0, 0, l];
  }

  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;

  if (max === r) {
    h = (g - b) / d + (g < b ? 6 : 0);
  } else if (max === g) {
    h = (b - r) / d + 2;
  } else {
    h = (r - g) / d + 4;
  }

  return [h * 60, s, l];
}

function fromHsl([h, s, l]: Rgb): Rgb {
  if (s === 0) {
    return [l, l, l];
  }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hn = (((h % 360) + 360) % 360) / 360;
  const channel = (t: number): number => {
    const tn = t < 0 ? t + 1 : t > 1 ? t - 1 : t;

    if (tn < 1 / 6) {
      return p + (q - p) * 6 * tn;
    }

    if (tn < 1 / 2) {
      return q;
    }

    if (tn < 2 / 3) {
      return p + (q - p) * (2 / 3 - tn) * 6;
    }

    return p;
  };

  return [channel(hn + 1 / 3), channel(hn), channel(hn - 1 / 3)];
}

/** HSV saturation. */
function hsvSaturation([r, g, b]: Rgb): number {
  const max = Math.max(r, g, b);

  return max === 0 ? 0 : (max - Math.min(r, g, b)) / max;
}

const toLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const fromLinear = (c: number): number =>
  c <= 0.0031308 ? 12.92 * c : 1.055 * Math.abs(c) ** (1 / 2.4) * Math.sign(c) - 0.055;

/** OKLab (L, a, b) of an sRGB colour. */
function toOklab(rgb: Rgb): Rgb {
  const [r, g, b] = rgb.map(toLinear) as Rgb;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab([L, a, b]: Rgb): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return [
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

const BASE_LUMINANCE = toOklab(CANVAS_DARK)[0];

/**
 * The colour to draw for an authored colour in a theme (canvas scaleColorForTheme). Light: as written. Dark: the HSL
 * lightness inverted, then scaled in OKLab so the darkest result is the dark canvas, eased by the authored HSV
 * saturation so a vivid colour keeps its strength.
 */
export function scaleForTheme(color: string, theme: Theme): string {
  const rgb = theme === 'dark' ? rgbOf(color) : null;

  if (!rgb) {
    return color;
  }

  const [h, s, l] = toHsl(rgb);
  const [L, a, b] = toOklab(fromHsl([h, s, 1 - l]));
  const lowest = BASE_LUMINANCE * (1 - hsvSaturation(rgb));

  return toHex(fromOklab([L - L * lowest + lowest, a, b]), alphaOf(color));
}

/** The ink the canvas writes on a fill (textColorFromPrimary): dark above 67% OKLCH lightness, else white. */
export function inkForFill(fill: string): string | undefined {
  const rgb = rgbOf(fill);

  if (!rgb) {
    return undefined;
  }

  return toOklab(rgb)[0] > 0.67 ? CANVAS_INK : '#ffffff';
}

/** A fill's near-white tint (getColorAtLightScale step 1): the hue rounded, the saturation kept, 98% lightness. */
export function tintOf(fill: string): string | undefined {
  const rgb = rgbOf(fill);

  if (!rgb) {
    return undefined;
  }

  if (toHex(rgb) === '#ffffff') {
    return '#ffffff';
  }

  const [h, s] = toHsl(rgb);

  return toHex(fromHsl([Math.round(h), s, 0.98]));
}

/** Border lightness and the saturation boost the canvas undoes (paletteColors.ts L_BORDER, SAT_BOOST). */
const L_BORDER = 0.45;
const SAT_BOOST = 1.25;

/**
 * A border in a fill's hue (deriveBorderFromFill): the hue kept, the saturation boost undone, the lightness at most
 * 45%, so a pale fill never becomes its own border.
 */
export function borderFromFill(fill: string): string {
  const rgb = rgbOf(fill);

  if (!rgb) {
    return fill;
  }

  const [h, s, l] = toHsl(rgb);

  return toHex(fromHsl([Math.round(h), s / SAT_BOOST, Math.min(L_BORDER, l)]));
}
