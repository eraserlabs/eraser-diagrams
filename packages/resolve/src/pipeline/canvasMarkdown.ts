/**
 * Preserve diagram paragraph spacing before Markdown parsing.
 *
 * Eraser's canvas text editor reads a newline inside a paragraph, a list item or a quote as a line
 * break; two newlines as a paragraph break with no blank line; each newline past two as one empty
 * paragraph; and each newline at the start or the end as one empty paragraph. GFM alone reads one
 * newline as a space and draws no empty lines, so paragraph gaps are made explicit here.
 * Marked handles soft breaks with its `breaks` option, which recognizes code spans and links
 * before breaking prose. Stored text never changes.
 *
 * A literal `\n` (two characters, as AI-written JSON carries it) is a newline.
 */
import { Marked } from 'marked';

/** Holds an empty line open (a paragraph with nothing in it is not drawn): zero-width, so it adds no width. */
export const EMPTY_LINE = '​';

/**
 * Four leading spaces are text, not a code block: on the canvas only a fence makes code, and a text run's leading
 * spaces count for layout (pre-wrap). Shared by the lexer here and the parser in sanitize.ts.
 */
export const NO_INDENTED_CODE = {
  tokenizer: {
    code(): undefined {
      return undefined;
    },
  },
};

const lexer = new Marked({ gfm: true }).use(NO_INDENTED_CODE);

/** Block markdown (a text run, a text box) with empty paragraphs preserved; Marked handles soft line breaks. */
export function canvasBlockMarkdown(markdown: string): string {
  const text = unescapeNewlines(markdown).replace(/\r\n?/g, '\n');
  if (/^\n+$/.test(text)) {
    // a text of newlines only (Enter in an empty text box): an empty paragraph each, as the canvas editor reads them
    return Array.from({ length: text.length }, () => EMPTY_LINE).join('\n\n');
  }
  const leading = leadingNewlines(text);
  let out = `${EMPTY_LINE}\n\n`.repeat(leading);
  // the newlines since the last block, and how many blocks so far
  let gap = 0;
  let blocks = 0;
  const block = (body: string): void => {
    if (blocks > 0) {
      out += separator(gap);
    }
    out += body;
    blocks += 1;
  };
  const body = text.slice(leading, text.length - trailingNewlines(text));
  for (const piece of splitAtEmptyLines(body)) {
    if (blocks > 0) {
      gap = piece.newlinesBefore;
    }
    let pieceStart = true;
    for (const token of lexer.lexer(piece.text)) {
      if (token.type === 'space') {
        // between blocks: newlines, and lines of spaces, which the editor shows as lines of their own. Spaces right
        // after a block, on its line, are that line's own (Marked can split an empty list item's `- ` that way), unless a piece starts with them
        for (const [i, part] of token.raw.split('\n').entries()) {
          if (i > 0) {
            gap += 1;
          }
          if (part !== '' && (i > 0 || blocks === 0 || pieceStart)) {
            block(spacesLine(part));
            gap = 0;
          }
        }
        pieceStart = false;
        continue;
      }
      pieceStart = false;
      const raw = token.raw.replace(/\n+$/, '');
      block(raw);
      gap = token.raw.length - raw.length;
    }
  }
  // newlines at the end: an empty paragraph each, counted in the text, not in the last token, which Marked can end with
  // a newline the text does not have (a list whose last item is an empty `- `)
  return blocks > 0 ? out + `\n\n${EMPTY_LINE}`.repeat(trailingNewlines(text)) : '';
}

/**
 * The text in pieces, cut at each run of three or more newlines outside a code fence, with the count of newlines
 * before each piece. Marked keeps a list going across empty lines (one loose list, the empty lines gone), where the
 * text has two lists with empty paragraphs between them: each piece is lexed alone, and the run is the gap between.
 */
function splitAtEmptyLines(text: string): Array<{ text: string; newlinesBefore: number }> {
  const pieces: Array<{ text: string; newlinesBefore: number }> = [];
  let lines: string[] = [];
  let newlinesBefore = 0;
  let empty = 0;
  let fenced = false;
  for (const line of text.split('\n')) {
    if (line === '' && !fenced) {
      empty += 1;
      continue;
    }
    if (empty >= 2 && lines.length > 0) {
      pieces.push({ text: lines.join('\n'), newlinesBefore });
      lines = [];
      newlinesBefore = empty + 1;
    } else {
      lines.push(...Array.from({ length: empty }, () => ''));
    }
    empty = 0;
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) {
      fenced = !fenced;
    }
    lines.push(line);
  }
  pieces.push({ text: lines.join('\n'), newlinesBefore });
  return pieces;
}

/**
 * A line of spaces (or tabs) as text Markdown keeps: entities, which it does not trim, held open by an EMPTY_LINE after
 * them (a space at the end of a line does not widen it).
 */
function spacesLine(spaces: string): string {
  return `${[...spaces].map((c) => `&#${c.codePointAt(0)};`).join('')}${EMPTY_LINE}`;
}

/**
 * One paragraph of inline markdown (a label, a title, a badge): its lines as the canvas breaks them,
 * joined by newlines; Marked recognizes code spans and links before line breaks. An empty text stays empty.
 */
export function canvasInlineMarkdown(markdown: string): string {
  if (markdown === '') {
    return '';
  }
  return inlineLines(markdown)
    .map((line) => line || EMPTY_LINE)
    .join('\n');
}

/**
 * The lines of a one-paragraph text as the canvas draws them. One newline is a line break; two or
 * more start a new paragraph, which is one line break too, and each newline past two is an empty
 * line; newlines at the start or the end are one empty line each.
 */
export function inlineLines(markdown: string): string[] {
  const text = unescapeNewlines(markdown).replace(/\r\n?/g, '\n');
  const trailing = /\n*$/.exec(text)?.[0].length ?? 0;
  const leading = leadingNewlines(text);
  const body = text.slice(leading, text.length - trailing);
  const lines: string[] = [];
  for (let i = 0; i < leading; i += 1) {
    lines.push('');
  }
  if (body.length > 0) {
    let line = '';
    let cursor = 0;
    for (const run of body.matchAll(/\n+/g)) {
      const at = run.index ?? 0;
      const count = run[0].length;
      line += body.slice(cursor, at);
      cursor = at + count;
      lines.push(line);
      line = '';
      for (let i = 2; i < count; i += 1) {
        lines.push('');
      }
    }
    lines.push(line + body.slice(cursor));
  }
  for (let i = 0; i < trailing; i += 1) {
    lines.push('');
  }
  return lines.length > 0 ? lines : [''];
}

export function unescapeNewlines(markdown: string): string {
  return markdown.replace(/\\n/g, '\n');
}

/**
 * The newlines before the first character that is not a newline: an empty line each, as the canvas editor reads them
 * (its countLeadingLineBreaks). A text of newlines only has none: those are trailing.
 */
/** The newlines after the last character that is not a newline. */
function trailingNewlines(text: string): number {
  return /\n*$/.exec(text)?.[0].length ?? 0;
}

function leadingNewlines(text: string): number {
  return /^\n+(?=[^\n])/.exec(text)?.[0].length ?? 0;
}

function newlines(text: string): number {
  return text.split('\n').length - 1;
}

/** Between two blocks: one newline stays one (a list straight after a paragraph); past two, an empty paragraph each. */
function separator(gap: number): string {
  if (gap <= 1) {
    return '\n'.repeat(gap);
  }
  return `\n\n${`${EMPTY_LINE}\n\n`.repeat(gap - 2)}`;
}
