import { describe, expect, it } from 'vitest';
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
    'leaves identity paint to the template: %s',
    (color) => {
      const s = shape({ color });
      expect(s.color).toBe(color);
      expect(s.bgColor).toBeUndefined();
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

  it('a faint fill (mostly transparent) picks no ink and no tint: the page under it decides', () => {
    const s = shape({ bgColor: '#00000020' });
    expect([s.bgColor, s.bodyInk, s.tintColor]).toEqual(['#00000020', undefined, undefined]);
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
