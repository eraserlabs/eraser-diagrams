import { describe, expect, it } from 'vitest';
import { alphaOf, inkForFill, tintOf } from '../src/canvasColors.js';

// Expected values from the canvas textColorFromPrimary and getColorAtLightScale step 1.
const CANVAS: Record<string, { ink: string; tint: string }> = {
  '#1168BD': { ink: '#ffffff', tint: '#f6fafe' },
  '#08427B': { ink: '#ffffff', tint: '#f5fafe' },
  '#F2C94C': { ink: '#242424', tint: '#fefcf5' },
  '#c7dcfc': { ink: '#242424', tint: '#f5f9fe' },
  '#2866c4': { ink: '#ffffff', tint: '#f7f9fd' },
  '#242424': { ink: '#ffffff', tint: '#fafafa' },
  '#ffffff': { ink: '#242424', tint: '#ffffff' },
  '#e8e8e8': { ink: '#242424', tint: '#fafafa' },
  '#fde68a': { ink: '#242424', tint: '#fffdf5' },
  '#ff0000': { ink: '#ffffff', tint: '#fff5f5' },
  '#c0f8d0': { ink: '#242424', tint: '#f6fef8' },
  '#30a050': { ink: '#ffffff', tint: '#f7fdf9' },
  '#000000': { ink: '#ffffff', tint: '#fafafa' },
  '#808080': { ink: '#ffffff', tint: '#fafafa' },
  '#e4e4e4': { ink: '#242424', tint: '#fafafa' },
  '#f7f8c0': { ink: '#242424', tint: '#fefef6' },
  '#bd413a': { ink: '#ffffff', tint: '#fdf7f7' },
};

describe('the canvas colour rules', () => {
  for (const [color, expected] of Object.entries(CANVAS)) {
    it(`${color}: ink ${expected.ink}, tint ${expected.tint}`, () => {
      expect(inkForFill(color)).toBe(expected.ink);
      expect(tintOf(color)).toBe(expected.tint);
    });
  }

  it('HSL and RGB spellings derive the same readable ink', () => {
    expect(inkForFill('hsl(0, 0%, 100%)')).toBe(inkForFill('#ffffff'));
    expect(inkForFill('hsl(0, 100%, 50%)')).toBe(inkForFill('#ff0000'));
    expect(alphaOf('hsla(120, 100%, 50%, 0.25)')).toBe(0.25);
  });

  it('a color with no channels has no derived ink', () => {
    expect(inkForFill('transparent')).toBeUndefined();
  });

  it('reads fill opacity to avoid choosing ink for nearly transparent fills', () => {
    expect(alphaOf('#00000020')).toBe(0.13);
    expect(alphaOf('rgba(0, 0, 0, 0.5)')).toBe(0.5);
    expect(alphaOf('#1168BD')).toBe(1);
  });
});
