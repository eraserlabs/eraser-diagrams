import { colorToRgba } from '../pipeline/colors.js';

import type { Theme } from '@eraserlabs/protocol';
export type { Theme } from '@eraserlabs/protocol';

type Rgb = [number, number, number];

/** The darkest neutral produced by the canvas's theme conversion. */
const CANVAS_DARK: Rgb = [0x17 / 255, 0x17 / 255, 0x17 / 255];

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Opaque results use hex; rgba retains alpha without quantizing it to an eight-bit channel. */
function toCss(rgb: Rgb, alpha: number): string {
  const channels = rgb.map((value) => Math.round(clamp01(value) * 255));

  if (alpha < 1) {
    // Our strict CSS grammar uses decimals, not exponential notation, including tiny alpha.
    const [mantissa, exponent] = String(alpha).split('e-');
    const decimal =
      exponent === undefined
        ? mantissa!
        : `0.${'0'.repeat(Number(exponent) - 1)}${mantissa!.replace('.', '')}`;

    return `rgba(${channels.join(', ')}, ${decimal})`;
  }

  return `#${channels.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
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

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
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
 * The canvas theme transform: invert HSL lightness, then scale OKLab lightness so the
 * darkest neutral becomes #171717. Authored HSV saturation eases that scale to preserve
 * vivid colors. Alpha is unchanged. Light mode, semantic keywords and unsupported colors
 * pass through unchanged; this helper does not replace color validation.
 */
export function scaleColorForTheme(color: string, theme: Theme = 'light'): string {
  const parsed = theme === 'dark' ? colorToRgba(color) : null;

  if (!parsed) {
    return color;
  }

  const rgb: Rgb = [parsed.r / 255, parsed.g / 255, parsed.b / 255];
  const [h, s, l] = toHsl(rgb);
  const [L, a, b] = toOklab(fromHsl([h, s, 1 - l]));
  const lowest = BASE_LUMINANCE * (1 - hsvSaturation(rgb));

  return toCss(fromOklab([L - L * lowest + lowest, a, b]), parsed.alpha);
}

/**
 * Replaces HSL lightness (0..1), preserving hue, saturation and alpha. Use this to
 * derive a template's light-mode tint before applying scaleColorForTheme. Semantic
 * keywords and unsupported expressions pass through unchanged.
 */
export function setColorLightness(color: string, lightness: number): string {
  const parsed = colorToRgba(color);

  if (!parsed || !Number.isFinite(lightness)) {
    return color;
  }

  const [h, s] = toHsl([parsed.r / 255, parsed.g / 255, parsed.b / 255]);

  return toCss(fromHsl([h, s, clamp01(lightness)]), parsed.alpha);
}
