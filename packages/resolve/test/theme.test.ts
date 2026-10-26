import { describe, expect, it } from 'vitest';
import { colorToHex, colorToRgba, isValidColor } from '../src/pipeline/colors.js';
import { scaleColorForTheme, setColorLightness } from '../src/colors/theme.js';

// Golden values from the workspace canvas's chroma-js scaleColorForTheme implementation.
const CANVAS_DARK: Record<string, string> = {
  '#1168BD': '#449bf0',
  '#08427B': '#85bff8',
  '#F2C94C': '#ba911c',
  '#c7dcfc': '#21385b',
  '#2866c4': '#407edd',
  '#242424': '#e2e2e2',
  '#ffffff': '#171717',
  '#e8e8e8': '#3f3f3f',
  '#fde68a': '#866e1e',
  '#ff0000': '#ff0000',
  '#c0f8d0': '#2a5d33',
  '#30a050': '#64d483',
  '#000000': '#ffffff',
  '#808080': '#989898',
  '#e4e4e4': '#434343',
  '#f7f8c0': '#595b27',
  '#bd413a': '#ce524a',
};

const WHITE = [
  '#fff',
  '#ffff',
  '#ffffff',
  '#ffffffff',
  'white',
  'WHITE',
  'rgb(255,255,255)',
  'rgba(100%,100%,100%,100%)',
  'hsl(0, 0%, 100%)',
  'HSLA(-720deg, 0%, 100%, 1)',
];

const CYAN = [
  '#0ff',
  '#00ffff',
  'cyan',
  'aqua',
  'rgb(0%, 100%, 100%)',
  'hsl(180, 100%, 50%)',
  'hsl(-180deg, 100%, 50%)',
  'hsl(540, 100%, 50%)',
];

describe('canvas theme color conversion', () => {
  for (const [color, expected] of Object.entries(CANVAS_DARK)) {
    it(`matches canvas dark rendering for ${color}`, () => {
      expect(scaleColorForTheme(color, 'dark')).toBe(expected);
    });
  }

  it('handles equivalent colors identically in every accepted concrete syntax', () => {
    for (const color of WHITE) {
      expect(isValidColor(color), color).toBe(true);
      expect(colorToHex(color), color).toBe('#ffffff');
      expect(scaleColorForTheme(color, 'dark'), color).toBe('#171717');
    }

    for (const color of CYAN) {
      expect(isValidColor(color), color).toBe(true);
      expect(colorToHex(color), color).toBe('#00ffff');
      expect(scaleColorForTheme(color, 'dark'), color).toBe('#00ffff');
    }
  });

  it('preserves authored spelling in light mode and semantic values in either mode', () => {
    for (const color of [...WHITE, ...CYAN]) {
      expect(scaleColorForTheme(color)).toBe(color);
      expect(scaleColorForTheme(color, 'light')).toBe(color);
    }

    for (const color of [
      'transparent',
      'currentColor',
      'CurrentColor',
      'var(--custom)',
      'invalid',
    ]) {
      expect(scaleColorForTheme(color, 'dark')).toBe(color);
      expect(setColorLightness(color, 0.85)).toBe(color);
      expect(colorToHex(color)).toBeNull();
    }
  });

  it('preserves fractional alpha without the old two-decimal or hex quantization', () => {
    const cases: [string, number][] = [
      ['#00000020', 32 / 255],
      ['#0001', 17 / 255],
      ['rgba(0, 0, 0, 0.12345)', 0.12345],
      ['rgb(0, 0, 0, 50%)', 0.5],
      ['hsla(0deg, 0%, 0%, 0.12345)', 0.12345],
      ['hsl(0, 0%, 0%, 50%)', 0.5],
      ['rgba(0, 0, 0, 0)', 0],
      ['rgba(0, 0, 0, 0.000000012345)', 0.000000012345],
    ];

    for (const [color, alpha] of cases) {
      const dark = scaleColorForTheme(color, 'dark');
      expect(isValidColor(dark), dark).toBe(true);
      expect(colorToRgba(dark)).toEqual({ r: 255, g: 255, b: 255, alpha });
      expect(colorToRgba(setColorLightness(color, 0.85))?.alpha).toBe(alpha);
    }
  });
});

describe('concrete color channels', () => {
  it('keeps colorToHex rounding and ignores alpha for pigment callers', () => {
    expect(colorToHex('#0a7f')).toBe('#00aa77');
    expect(colorToHex('#12AB34CD')).toBe('#12ab34');
    expect(colorToHex('rgba(50%, 50%, 50%, 0.123)')).toBe('#808080');
    expect(colorToHex('rgb(-2, 999, 0.5)')).toBe('#00ff01');
    expect(colorToHex('hsl(120deg, 50%, 50%)')).toBe('#40bf40');
    expect(colorToHex('hsla(120, 50%, 50%, 0.3)')).toBe('#40bf40');
  });

  it('preserves fractional channels and clamps CSS channel ranges', () => {
    expect(colorToRgba('rgba(10.25, 50%, 999, 150%)')).toEqual({
      r: 10.25,
      g: 127.5,
      b: 255,
      alpha: 1,
    });
    expect(colorToRgba('hsla(120, 200%, 50%, -1)')).toEqual({
      r: 0,
      g: 255,
      b: 0,
      alpha: 0,
    });
    expect(colorToRgba('hsl(120, 100%, 200%)')).toEqual({
      r: 255,
      g: 255,
      b: 255,
      alpha: 1,
    });
  });

  it('derives the template tint before dark-mode conversion', () => {
    expect(setColorLightness('#00ffff', 0.85)).toBe('#b3ffff');
    expect(setColorLightness('#00ffff', 0.98)).toBe('#f5ffff');
    expect(setColorLightness('hsl(30, 100%, 50%)', 0.85)).toBe('#ffd9b3');
    expect(scaleColorForTheme(setColorLightness('#00ffff', 0.85), 'dark')).not.toBe(
      setColorLightness(scaleColorForTheme('#00ffff', 'dark'), 0.85),
    );
  });
});
