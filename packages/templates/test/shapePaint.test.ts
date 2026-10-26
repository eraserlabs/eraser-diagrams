import { describe, expect, it } from 'vitest';
import { colorToRgba } from '@eraserlabs/resolve';
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
});
