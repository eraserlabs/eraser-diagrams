import { describe, it, expect } from 'vitest';
import { isTextRun, primaryTextRun } from '../src/pipeline/derive.js';

describe('primaryTextRun', () => {
  it('finds the first run in a run array, whatever the field is called', () => {
    expect(primaryTextRun({ texts: [{ text: 'a', color: '#123456' }, { text: 'b' }] })?.color).toBe(
      '#123456',
    );
    expect(primaryTextRun({ captions: [{ text: 'a', color: '#123456' }] })?.color).toBe('#123456');
  });

  it('accepts a single run object and the element itself', () => {
    expect(primaryTextRun({ title: { text: 'Backend', color: '#7a1f1f' } })?.color).toBe('#7a1f1f');
    expect(primaryTextRun({ text: 'note', color: '#000' })?.text).toBe('note');
  });

  it('takes fields in authored order and skips non-runs', () => {
    expect(
      primaryTextRun({ icon: 'star', badge: { icon: 'x' }, texts: [{ text: 'a' }] })?.text,
    ).toBe('a');
    expect(primaryTextRun({ x: 0, y: 0, width: 10 })).toBeUndefined();
  });

  it('isTextRun requires a string text', () => {
    expect(isTextRun({ text: 'a' })).toBe(true);
    expect(isTextRun({ text: 1 })).toBe(false);
    expect(isTextRun(null)).toBe(false);
    expect(isTextRun('a')).toBe(false);
  });
});
