/**
 * The wrap width of one external text run (an icon's caption line) under the balanced rule, as the
 * Eraser workspace canvas chooses it (canvasTextMeasurer measureText with scaleOptions): pure, so it
 * is tested without a page. The DOM side (textSizing.ts fitExternalRuns) reads the inputs from the
 * filled template and applies the result.
 *
 * - A run no wider than its start width stays on one line at the start width.
 * - Past `maxLines` lines at the start width, the width widens to
 *   √(one-line width × font box height) × aspect × allowance, never below the start width.
 * - A run that is one word wider than the chosen width splits into N even runs of letters,
 *   N = ⌈word width ÷ chosen width⌉ (the canvas's splitIntoNChunks), so the width is the widest
 *   run's, not full lines and a short last one.
 */
export interface ExternalRunWrapInput {
  /** The width the run starts from: the template's default (an icon caption: 1.8 × the glyph). */
  start: number;
  /** The run's one-line (max-content) width. */
  natural: number;
  /** The font's box height (ascent + descent), the height the canvas widens by. */
  fontBox: number;
  /** The lines the run takes at the start width, as laid out (words wrap between them). */
  linesAtStart: number;
  /** The run is one word: no space to wrap at, so it breaks into even parts. */
  oneWord: boolean;
  /** For a one-word run: the widest of `parts` even letter runs, plus the canvas's 1px. */
  widestPart?: (parts: number) => number;
  /** Lines past which the width widens toward the aspect. */
  maxLines: number;
  /** The width : height the widened block aims for. */
  aspect: number;
  /** The canvas's allowance on the aspect width. */
  allowance: number;
}

export function externalRunWrapWidth(input: ExternalRunWrapInput): number {
  const { start, natural, fontBox, oneWord, maxLines, aspect, allowance } = input;
  if (!(start > 0) || !(natural > start)) {
    return Math.ceil(start);
  }
  const lines = oneWord ? Math.ceil(natural / start) : input.linesAtStart;
  let target = start;
  if (lines > maxLines) {
    target = Math.max(start, Math.sqrt(natural * fontBox) * aspect * allowance);
  }
  if (oneWord && input.widestPart && natural > target) {
    target = Math.min(target, input.widestPart(Math.ceil(natural / target)));
  }
  return Math.ceil(target);
}

/** `word` in `parts` even runs of letters, as the canvas's splitIntoNChunks cuts it. */
export function evenLetterRuns(word: string, parts: number): string[] {
  const letters = Array.from(word);
  if (parts <= 1 || letters.length === 0) {
    return [word];
  }
  return Array.from({ length: parts }, (_, i) =>
    letters
      .slice(Math.floor((i * letters.length) / parts), Math.floor(((i + 1) * letters.length) / parts))
      .join(''),
  );
}
