/**
 * Preserve diagram paragraph spacing before Markdown parsing.
 *
 * Eraser's canvas text editor reads a newline inside a paragraph, a list item or a quote as a line
 * break; two newlines as a paragraph break with no blank line; each newline past two as one empty
 * paragraph; and each newline at the end as one trailing empty paragraph. GFM alone reads one
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
  let out = '';
  // the newlines since the last block, and how many blocks so far (newlines before the first are not drawn)
  let gap = 0;
  let blocks = 0;
  for (const token of lexer.lexer(text)) {
    if (token.type === 'space') {
      gap += newlines(token.raw);
      continue;
    }
    const body = token.raw.replace(/\n+$/, '');
    if (blocks > 0) {
      out += separator(gap);
    }
    out += body;
    gap = token.raw.length - body.length;
    blocks += 1;
  }
  return blocks > 0 ? out + `\n\n${EMPTY_LINE}`.repeat(gap) : out;
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
 * line; newlines at the end are one empty line each.
 */
export function inlineLines(markdown: string): string[] {
  const text = unescapeNewlines(markdown).replace(/\r\n?/g, '\n');
  const trailing = /\n*$/.exec(text)?.[0].length ?? 0;
  const body = text.slice(0, text.length - trailing);
  const lines: string[] = [];
  if (body.length > 0) {
    let line = '';
    let cursor = 0;
    for (const run of body.matchAll(/\n+/g)) {
      const at = run.index ?? 0;
      const count = run[0].length;
      line += body.slice(cursor, at);
      cursor = at + count;
      if (count === 1) {
        lines.push(line);
        line = '';
        continue;
      }
      // a paragraph break at the very start leaves no empty paragraph before the text
      if (at > 0) {
        lines.push(line);
        line = '';
      }
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
