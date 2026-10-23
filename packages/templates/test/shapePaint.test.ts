import { describe, expect, it } from 'vitest';
import type { NormalizerContext, Theme } from '@eraserlabs/resolve';
import { stockNormalizers } from '../src/normalizers.js';
import { STOCK_PALETTE } from '../src/schema/palette.js';
import { scaleForTheme } from '../src/canvasColors.js';

/**
 * A Shape as the resolver hands it to the normalizer: `x-palette` has swapped an authored token for its identity
 * colour on the clone, and the context still knows the token from the authored source.
 */
function shape(authored: Record<string, unknown>, theme: Theme = 'light'): Record<string, unknown> {
  const element: Record<string, unknown> = {
    tag: 'Shape',
    id: 's',
    x: 0,
    y: 0,
    width: 180,
    height: 80,
    texts: [{ text: 'API' }],
    ...structuredClone(authored),
  };
  if (typeof authored.color === 'string' && authored.color in STOCK_PALETTE) {
    element.color = STOCK_PALETTE[authored.color];
  }
  const context: NormalizerContext = {
    theme,
    paletteToken: (key) => {
      const value = authored[key];
      return typeof value === 'string' && value in STOCK_PALETTE ? value : undefined;
    },
  };
  stockNormalizers.Shape!(element, context);
  return element;
}

describe('Shape paint, as the Eraser canvas paints a shape', () => {
  it('a hex colour is a solid fill with a darker border in its hue, and white ink on it', () => {
    const s = shape({ color: '#1168BD' });
    expect([s.bgColor, s.borderColor, s.bodyInk, s.textInk]).toEqual([
      '#1168BD',
      '#2267ac',
      '#ffffff',
      '#242424',
    ]);
  });

  it("a palette colour is the canvas pastel, the stylesheet's identity hairline, the default ink", () => {
    const s = shape({ color: 'blue' });
    expect([s.color, s.bgColor, s.borderColor, s.bodyInk]).toEqual([
      '#2866c4',
      '#c7dcfc',
      undefined,
      '#242424',
    ]);
  });

  it('the same colour written as hex is solid: the token, not the value, makes the pastel', () => {
    expect(shape({ color: '#2866c4' }).bgColor).toBe('#2866c4');
  });

  it('an authored fill and border win, raw CSS as the schema reads them; a dark fill inks white', () => {
    expect(shape({ color: '#1168BD', bgColor: '#ffffff', borderColor: '#ff0000' })).toMatchObject({
      bgColor: '#ffffff',
      borderColor: '#ff0000',
      bodyInk: '#242424',
    });
    expect(shape({ bgColor: 'red' }).bgColor).toBe('red');
    expect(shape({ bgColor: '#08427B' }).bodyInk).toBe('#ffffff');
  });

  it("a run's own colour is every uncoloured run's ink and the badge's", () => {
    const s = shape({ color: '#1168BD', texts: [{ text: 'A', color: '#000000' }, { text: 'b' }] });
    expect([s.bodyInk, s.textInk]).toEqual(['#000000', '#000000']);
  });

  it('a faint fill (mostly transparent) picks no ink and no tint: the page under it decides', () => {
    const s = shape({ bgColor: '#00000020' });
    expect([s.bgColor, s.bodyInk, s.tintColor]).toEqual(['#00000020', undefined, undefined]);
  });

  it('no colour: nothing written in light mode, the template defaults draw it', () => {
    const s = shape({});
    expect([s.bgColor, s.borderColor, s.bodyInk, s.textInk, s.tintColor, s.shadowColor]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('dark: every colour, the defaults among them, scaled as the canvas scales it', () => {
    const navy = shape({ bgColor: '#08427B', texts: [{ text: 'A' }, { text: 'b', color: '#000000' }] }, 'dark');
    expect(navy).toMatchObject({
      bgColor: '#85bff8',
      // the ink is chosen on the authored fill (white on navy), then scaled: dark on the scaled light blue
      bodyInk: scaleForTheme('#ffffff', 'dark'),
      borderColor: scaleForTheme('#242424', 'dark'),
      shadowColor: scaleForTheme('#e8e8e8', 'dark'),
    });
    expect((navy.texts as { color?: string }[])[1]!.color).toBe('#ffffff');
    // a hex shape in dark mode, against the canvas (chroma-js): the solid fill scaled, the border derived on the
    // authored fill then scaled, the white ink scaled
    const hex = shape({ color: '#1168BD' }, 'dark');
    expect([hex.bgColor, hex.borderColor, hex.bodyInk]).toEqual(['#449bf0', '#579ce2', '#171717']);
    const palette = shape({ color: 'blue' }, 'dark');
    expect([palette.bgColor, palette.borderColor]).toEqual(['#21385b', '#407edd']);
    const plain = shape({}, 'dark');
    expect([plain.bgColor, plain.bodyInk, plain.tintColor]).toEqual([
      undefined,
      '#e2e2e2',
      '#171717',
    ]);
  });
});
