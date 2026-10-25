import { describe, expect, it } from 'vitest';
import { colorToRgba, setColorLightness } from '@eraserlabs/resolve';
import { stockNormalizers } from '../src/normalizers.js';

function shape(authored: Record<string, unknown>): Record<string, unknown> {
  const element = {
    tag: 'Shape',
    id: 's',
    width: 180,
    height: 80,
    texts: [{ text: 'API' }],
    ...structuredClone(authored),
  };
  stockNormalizers.Shape!(element);
  return element;
}

describe('Shape paint', () => {
  it.each(['#00FFFF', '#2866c4', 'hsl(180, 100%, 50%)', 'rgb(0, 255, 255)'])(
    'derives the final fill without changing authored identity paint: %s',
    (color) => {
      const s = shape({ color });
      expect(s.color).toBe(color);
      expect(s.bgColor).toBeUndefined();
      expect(s.fillColor).toBe(setColorLightness(color, 0.85));
      expect(s.borderColor).toBeUndefined();
      expect(s.bodyInk).toBeUndefined();
    },
  );

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

  it('a faint fill picks no ink and its derived tint preserves opacity', () => {
    const s = shape({ bgColor: '#00000020' });
    expect([s.bgColor, s.bodyInk]).toEqual(['#00000020', undefined]);
    expect(colorToRgba(s.tintColor as string)?.alpha).toBe(32 / 255);
  });

  it('no colour: nothing written in light mode, the template defaults draw it', () => {
    const s = shape({});
    expect([s.bgColor, s.borderColor, s.bodyInk, s.textInk, s.tintColor]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});
