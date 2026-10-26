import { colorToRgba } from '@eraserlabs/resolve';

/** Readable text ink and near-white badge tints for explicit shape fills. */

type Rgb = [number, number, number];

/** The canvas's default ink and stroke. */
export const CANVAS_INK = '#242424';

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** Channels 0..1, or null for a colour with no channel values here. */
function rgbOf(color: string): Rgb | null {
  const rgba = colorToRgba(color);
  if (rgba === null || rgba.alpha === 0) {
    return null;
  }
  return [rgba.r / 255, rgba.g / 255, rgba.b / 255];
}

/** Fill opacity, rounded like the canvas's chroma-js helper. */
export function alphaOf(color: string): number {
  return Math.round((colorToRgba(color)?.alpha ?? 1) * 100) / 100;
}

function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b]
    .map((v) =>
      Math.round(clamp01(v) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
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

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
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
