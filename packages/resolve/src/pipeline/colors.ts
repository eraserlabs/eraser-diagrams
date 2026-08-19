import type { Issue } from '../result-types.js';
import { ERROR_CODE, SEVERITY } from '../result-types.js';
import type { PolicyEntry } from '../types.js';
import { quote } from '../schema/errors.js';
import type { PipelineElement } from './element.js';
import { resolvePointer } from './pointer.js';

/**
 * CSS named colors (Level 4), each with its canonical hex value (generated from Chromium's own
 * canvas color resolution). The keys are the validation membership; the values let downstream
 * stages (the watercolor pigment, notably) convert a named color without a DOM.
 */
export const NAMED_COLOR_HEX: Readonly<Record<string, string>> = {
  aliceblue: '#f0f8ff',
  antiquewhite: '#faebd7',
  aqua: '#00ffff',
  aquamarine: '#7fffd4',
  azure: '#f0ffff',
  beige: '#f5f5dc',
  bisque: '#ffe4c4',
  black: '#000000',
  blanchedalmond: '#ffebcd',
  blue: '#0000ff',
  blueviolet: '#8a2be2',
  brown: '#a52a2a',
  burlywood: '#deb887',
  cadetblue: '#5f9ea0',
  chartreuse: '#7fff00',
  chocolate: '#d2691e',
  coral: '#ff7f50',
  cornflowerblue: '#6495ed',
  cornsilk: '#fff8dc',
  crimson: '#dc143c',
  cyan: '#00ffff',
  darkblue: '#00008b',
  darkcyan: '#008b8b',
  darkgoldenrod: '#b8860b',
  darkgray: '#a9a9a9',
  darkgreen: '#006400',
  darkgrey: '#a9a9a9',
  darkkhaki: '#bdb76b',
  darkmagenta: '#8b008b',
  darkolivegreen: '#556b2f',
  darkorange: '#ff8c00',
  darkorchid: '#9932cc',
  darkred: '#8b0000',
  darksalmon: '#e9967a',
  darkseagreen: '#8fbc8f',
  darkslateblue: '#483d8b',
  darkslategray: '#2f4f4f',
  darkslategrey: '#2f4f4f',
  darkturquoise: '#00ced1',
  darkviolet: '#9400d3',
  deeppink: '#ff1493',
  deepskyblue: '#00bfff',
  dimgray: '#696969',
  dimgrey: '#696969',
  dodgerblue: '#1e90ff',
  firebrick: '#b22222',
  floralwhite: '#fffaf0',
  forestgreen: '#228b22',
  fuchsia: '#ff00ff',
  gainsboro: '#dcdcdc',
  ghostwhite: '#f8f8ff',
  gold: '#ffd700',
  goldenrod: '#daa520',
  gray: '#808080',
  green: '#008000',
  greenyellow: '#adff2f',
  grey: '#808080',
  honeydew: '#f0fff0',
  hotpink: '#ff69b4',
  indianred: '#cd5c5c',
  indigo: '#4b0082',
  ivory: '#fffff0',
  khaki: '#f0e68c',
  lavender: '#e6e6fa',
  lavenderblush: '#fff0f5',
  lawngreen: '#7cfc00',
  lemonchiffon: '#fffacd',
  lightblue: '#add8e6',
  lightcoral: '#f08080',
  lightcyan: '#e0ffff',
  lightgoldenrodyellow: '#fafad2',
  lightgray: '#d3d3d3',
  lightgreen: '#90ee90',
  lightgrey: '#d3d3d3',
  lightpink: '#ffb6c1',
  lightsalmon: '#ffa07a',
  lightseagreen: '#20b2aa',
  lightskyblue: '#87cefa',
  lightslategray: '#778899',
  lightslategrey: '#778899',
  lightsteelblue: '#b0c4de',
  lightyellow: '#ffffe0',
  lime: '#00ff00',
  limegreen: '#32cd32',
  linen: '#faf0e6',
  magenta: '#ff00ff',
  maroon: '#800000',
  mediumaquamarine: '#66cdaa',
  mediumblue: '#0000cd',
  mediumorchid: '#ba55d3',
  mediumpurple: '#9370db',
  mediumseagreen: '#3cb371',
  mediumslateblue: '#7b68ee',
  mediumspringgreen: '#00fa9a',
  mediumturquoise: '#48d1cc',
  mediumvioletred: '#c71585',
  midnightblue: '#191970',
  mintcream: '#f5fffa',
  mistyrose: '#ffe4e1',
  moccasin: '#ffe4b5',
  navajowhite: '#ffdead',
  navy: '#000080',
  oldlace: '#fdf5e6',
  olive: '#808000',
  olivedrab: '#6b8e23',
  orange: '#ffa500',
  orangered: '#ff4500',
  orchid: '#da70d6',
  palegoldenrod: '#eee8aa',
  palegreen: '#98fb98',
  paleturquoise: '#afeeee',
  palevioletred: '#db7093',
  papayawhip: '#ffefd5',
  peachpuff: '#ffdab9',
  peru: '#cd853f',
  pink: '#ffc0cb',
  plum: '#dda0dd',
  powderblue: '#b0e0e6',
  purple: '#800080',
  rebeccapurple: '#663399',
  red: '#ff0000',
  rosybrown: '#bc8f8f',
  royalblue: '#4169e1',
  saddlebrown: '#8b4513',
  salmon: '#fa8072',
  sandybrown: '#f4a460',
  seagreen: '#2e8b57',
  seashell: '#fff5ee',
  sienna: '#a0522d',
  silver: '#c0c0c0',
  skyblue: '#87ceeb',
  slateblue: '#6a5acd',
  slategray: '#708090',
  slategrey: '#708090',
  snow: '#fffafa',
  springgreen: '#00ff7f',
  steelblue: '#4682b4',
  tan: '#d2b48c',
  teal: '#008080',
  thistle: '#d8bfd8',
  tomato: '#ff6347',
  turquoise: '#40e0d0',
  violet: '#ee82ee',
  wheat: '#f5deb3',
  white: '#ffffff',
  whitesmoke: '#f5f5f5',
  yellow: '#ffff00',
  yellowgreen: '#9acd32',
};

/** Validation membership: every named color plus the two keywords. */
const NAMED_COLORS = new Set(['transparent', 'currentcolor', ...Object.keys(NAMED_COLOR_HEX)]);

// Characters that would let a color escape its CSS context. Any presence is a hard reject.
const INJECTION = /[;{}`\\]|url\(|var\(|expression|attr\(|calc\(|gradient|<|>|\/\*|\*\/|[\n\r\t]/i;

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const NUM = String.raw`-?\d*\.?\d+%?`;
const PCT = String.raw`\d*\.?\d+%`;
const RGB = new RegExp(String.raw`^rgba?\(\s*${NUM}\s*(,\s*${NUM}\s*){2}(,\s*${NUM}\s*)?\)$`, 'i');
// Hue (optionally deg) then saturation% and lightness% (percent required), optional alpha.
const HSL = new RegExp(
  String.raw`^hsla?\(\s*-?\d*\.?\d+(deg)?\s*,\s*${PCT}\s*,\s*${PCT}\s*(,\s*${NUM}\s*)?\)$`,
  'i',
);

/**
 * A color canonicalized to `#rrggbb` for stages that need actual channel values without a DOM
 * (the watercolor pigment, notably): hex in every length (alpha dropped), `rgb()/rgba()`, and
 * the named colors. Null for everything else — `transparent`, `hsl()` and future functions have
 * no channel math here. Lives beside the validation grammar above so the two evolve together.
 */
export function colorToHex(value: string): string | null {
  const raw = value.trim().toLowerCase();
  const named = NAMED_COLOR_HEX[raw];

  if (named) {
    return named;
  }

  const hex = HEX.exec(raw);

  if (hex) {
    const digits = hex[1]!;

    if (digits.length >= 6) {
      return `#${digits.slice(0, 6)}`;
    }

    return `#${digits[0]}${digits[0]}${digits[1]}${digits[1]}${digits[2]}${digits[2]}`;
  }

  const fn = RGB_CHANNELS.exec(raw);

  if (!fn) {
    return null;
  }

  const channel = (part: string): number => {
    const num = Number.parseFloat(part);
    const byte = part.endsWith('%') ? (num / 100) * 255 : num;

    return Math.min(255, Math.max(0, Math.round(byte)));
  };

  const packed = (1 << 24) | (channel(fn[1]!) << 16) | (channel(fn[2]!) << 8) | channel(fn[3]!);

  return `#${packed.toString(16).slice(1)}`;
}

// The validating RGB regex above accepts without capturing channels; this twin captures them.
const RGB_CHANNELS = new RegExp(
  String.raw`^rgba?\(\s*(${NUM})\s*,\s*(${NUM})\s*,\s*(${NUM})\s*(?:,\s*${NUM}\s*)?\)$`,
  'i',
);

/** True iff the value is a color our strict grammar accepts and contains no CSS-injection payload. */
export function isValidColor(value: string): boolean {
  if (INJECTION.test(value)) {
    return false;
  }

  // No leading/trailing whitespace — the value goes verbatim into a CSS context.
  if (value !== value.trim() || value === '') {
    return false;
  }

  if (NAMED_COLORS.has(value.toLowerCase())) {
    return true;
  }

  return HEX.test(value) || RGB.test(value) || HSL.test(value);
}

export interface StageResult {
  errors: Issue[];
  warnings: Issue[];
}

/** Rejects any color value outside the strict grammar (CSS-injection gate). */
export function stageColors(
  items: readonly PipelineElement[],
  policyTables: Record<string, PolicyEntry[]>,
): StageResult {
  const errors: Issue[] = [];

  for (const { index, path: elementPath, tag, element } of items) {
    const colorEntries = (policyTables[tag] ?? []).filter((e) => e.kind === 'css-color');

    for (const entry of colorEntries) {
      for (const hit of resolvePointer(element, entry.pointer)) {
        if (typeof hit.value === 'string' && !isValidColor(hit.value)) {
          errors.push({
            code: ERROR_CODE.INVALID_COLOR,
            severity: SEVERITY.ERROR,
            path: `${elementPath}${hit.path}`,
            elementIndex: index,
            tag,
            message: `Invalid color ${quote(hit.value)} at ${elementPath}${hit.path}.`,
          });
        }
      }
    }
  }

  return { errors, warnings: [] };
}
