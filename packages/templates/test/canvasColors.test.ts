import { describe, expect, it } from 'vitest';
import { alphaOf, borderFromFill, inkForFill, scaleForTheme, tintOf } from '../src/canvasColors.js';

// Each expected value is what the Eraser canvas computes with chroma-js (colorRules.ts scaleColorForTheme,
// textColorFromPrimary, getColorAtLightScale step 1; paletteColors.ts deriveBorderFromFill).
const CANVAS: Record<string, { dark: string; ink: string; tint: string }> = {
  '#1168BD': { dark: '#449bf0', ink: '#ffffff', tint: '#f6fafe' },
  '#08427B': { dark: '#85bff8', ink: '#ffffff', tint: '#f5fafe' },
  '#F2C94C': { dark: '#ba911c', ink: '#242424', tint: '#fefcf5' },
  '#c7dcfc': { dark: '#21385b', ink: '#242424', tint: '#f5f9fe' },
  '#2866c4': { dark: '#407edd', ink: '#ffffff', tint: '#f7f9fd' },
  '#242424': { dark: '#e2e2e2', ink: '#ffffff', tint: '#fafafa' },
  '#ffffff': { dark: '#171717', ink: '#242424', tint: '#ffffff' },
  '#e8e8e8': { dark: '#3f3f3f', ink: '#242424', tint: '#fafafa' },
  '#fde68a': { dark: '#866e1e', ink: '#242424', tint: '#fffdf5' },
  '#ff0000': { dark: '#ff0000', ink: '#ffffff', tint: '#fff5f5' },
  '#c0f8d0': { dark: '#2a5d33', ink: '#242424', tint: '#f6fef8' },
  '#30a050': { dark: '#64d483', ink: '#ffffff', tint: '#f7fdf9' },
  '#000000': { dark: '#ffffff', ink: '#ffffff', tint: '#fafafa' },
  '#808080': { dark: '#989898', ink: '#ffffff', tint: '#fafafa' },
  '#e4e4e4': { dark: '#434343', ink: '#242424', tint: '#fafafa' },
  '#f7f8c0': { dark: '#595b27', ink: '#242424', tint: '#fefef6' },
  '#bd413a': { dark: '#ce524a', ink: '#ffffff', tint: '#fdf7f7' },
};

describe('the canvas colour rules', () => {
  for (const [color, expected] of Object.entries(CANVAS)) {
    it(`${color}: dark ${expected.dark}, ink ${expected.ink}, tint ${expected.tint}`, () => {
      expect(scaleForTheme(color, 'dark')).toBe(expected.dark);
      expect(inkForFill(color)).toBe(expected.ink);
      expect(tintOf(color)).toBe(expected.tint);
    });
  }

  it('light draws a colour as written; a colour with no channels here comes back as given', () => {
    expect(scaleForTheme('#1168BD', 'light')).toBe('#1168BD');
    expect(scaleForTheme('transparent', 'dark')).toBe('transparent');
    expect(scaleForTheme('var(--x)', 'dark')).toBe('var(--x)');
    expect(inkForFill('transparent')).toBeUndefined();
  });

  it('a border in a fill hue, at most 45% light (deriveBorderFromFill)', () => {
    expect(borderFromFill('#1168BD')).toBe('#2267ac');
  });

  it('dark keeps a colour alpha, as chroma-js keeps it (two decimals)', () => {
    expect(alphaOf('#00000020')).toBe(0.13);
    expect(alphaOf('rgba(0, 0, 0, 0.5)')).toBe(0.5);
    expect(alphaOf('#1168BD')).toBe(1);
    expect(scaleForTheme('#00000020', 'dark')).toBe('#ffffff21');
    expect(scaleForTheme('rgba(0,0,0,0.5)', 'dark')).toBe('#ffffff80');
  });
});
