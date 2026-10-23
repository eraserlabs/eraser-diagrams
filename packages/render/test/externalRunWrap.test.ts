import { describe, expect, it } from 'vitest';
import { evenLetterRuns, externalRunWrapWidth } from '../src/browser/externalRunWrap.js';

// an icon caption at a 50px glyph, as the canvas wraps it: 1.8 × 50 = 90, two lines, aspect 1.8, allowance 1.2
const caption = { start: 90, fontBox: 16, maxLines: 2, aspect: 1.8, allowance: 1.2 };

describe('externalRunWrapWidth: the canvas rule for an icon caption line', () => {
  it('a run that fits on one line keeps the start width', () => {
    expect(externalRunWrapWidth({ ...caption, natural: 60, linesAtStart: 1, oneWord: false })).toBe(90);
  });

  it('words over two lines or fewer wrap at the start width', () => {
    expect(externalRunWrapWidth({ ...caption, natural: 170, linesAtStart: 2, oneWord: false })).toBe(90);
  });

  it('words past two lines widen to √(width × font box) × aspect × allowance', () => {
    const natural = 400;
    const widened = Math.ceil(Math.sqrt(natural * 16) * 1.8 * 1.2);
    expect(externalRunWrapWidth({ ...caption, natural, linesAtStart: 5, oneWord: false })).toBe(widened);
  });

  it('never narrower than the start width', () => {
    expect(
      externalRunWrapWidth({ ...caption, natural: 100, linesAtStart: 3, oneWord: false, fontBox: 1 }),
    ).toBe(90);
  });

  it('one word wider than the width splits into even parts: the widest part is the width', () => {
    // 160px of letters at 90: two parts of about 80, not 90 and 70
    const width = externalRunWrapWidth({
      ...caption,
      natural: 160,
      linesAtStart: 1,
      oneWord: true,
      widestPart: (parts) => 160 / parts + 1,
    });
    expect(width).toBe(81);
  });

  it('one long word past two parts widens first, then splits evenly at the widened width', () => {
    const natural = 400;
    const widened = Math.sqrt(natural * 16) * 1.8 * 1.2;
    const parts = Math.ceil(natural / widened);
    const width = externalRunWrapWidth({
      ...caption,
      natural,
      linesAtStart: 1,
      oneWord: true,
      widestPart: (n) => natural / n + 1,
    });
    expect(width).toBe(Math.ceil(natural / parts + 1));
  });

  it('a no-layout read (zero start) leaves it', () => {
    expect(externalRunWrapWidth({ ...caption, start: 0, natural: 100, linesAtStart: 1, oneWord: true })).toBe(0);
  });
});

describe('evenLetterRuns: the canvas splitIntoNChunks', () => {
  it('cuts the letters into even runs', () => {
    expect(evenLetterRuns('abcdefgh', 2)).toEqual(['abcd', 'efgh']);
    expect(evenLetterRuns('abcdefg', 3)).toEqual(['ab', 'cd', 'efg']);
    expect(evenLetterRuns('abc', 1)).toEqual(['abc']);
  });
});
