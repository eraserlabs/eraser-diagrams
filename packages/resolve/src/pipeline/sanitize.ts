import sanitizeHtml from 'sanitize-html';
import { Marked } from 'marked';
import type { Issue } from '../result-types.js';
import { WARNING_CODE, SEVERITY } from '../result-types.js';
import type { PolicyEntry } from '../types.js';
import type { ContentPolicy } from '../schema/keywords.js';
import type { PipelineElement } from './element.js';
import { resolvePointer } from './pointer.js';
import { canvasBlockMarkdown, canvasInlineMarkdown, NO_INDENTED_CODE } from './canvasMarkdown.js';

const SAFE_SCHEMES = ['http', 'https', 'mailto'];

/** The deepest heading drawn; `####` and below are drawn as this level (the canvas text contract). */
const MAX_HEADING_DEPTH = 3;

/** The hook the host may listen on; the markup itself is never edited. */
const MD_HOOK = 'data-md';

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p',
    'br',
    'b',
    'i',
    'em',
    'strong',
    'del',
    'code',
    'pre',
    'ul',
    'ol',
    'li',
    'blockquote',
    'hr',
    'a',
    'span',
    'h1',
    'h2',
    'h3',
  ],
  // `ol.start` keeps ordered lists numbered as authored: each text run parses as its own
  // single-item list, so dropping `start` renumbered every one of them to "1." — and made
  // sanitized output differ from parser output, firing a spurious W_CONTENT_SANITIZED.
  // `data-md` is the host's hook on a link and a code block; `code.language-*` is the fence's language.
  allowedAttributes: { a: ['href', MD_HOOK], pre: [MD_HOOK], ol: ['start'], code: ['class'] },
  allowedClasses: { code: ['language-*'] },
  allowedSchemes: SAFE_SCHEMES,
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
};

/** Markdown policy output: the sanitized HTML plus whether sanitizing removed parser output. */
export interface SanitizedMarkdown {
  html: string;
  /**
   * True when the sanitizer stripped markup the parser produced — raw HTML smuggled through the
   * markdown source. Benign markdown transforms (text → tags) do not set it.
   */
  stripped: boolean;
}

/** Sanitizers are constructed once at boot (Constitution VI) and reused across calls. */
export interface Sanitizers {
  html(dirty: string): string;
  markdown(md: string): SanitizedMarkdown;
  inlineMarkdown(md: string): SanitizedMarkdown;
  plain(text: string): string;
}

export function buildSanitizers(): Sanitizers {
  const marked = new Marked({ async: false, gfm: true }).use(NO_INDENTED_CODE);

  marked.use({
    renderer: {
      // Raw HTML in markdown source renders as literal text, never as markup.
      html: (token: { text: string } | string) =>
        escapePlain(typeof token === 'string' ? token : token.text),
      // A heading past h3 is drawn as h3: the editor shows six levels, the canvas draws three.
      heading({ tokens, depth }) {
        const level = Math.min(depth, MAX_HEADING_DEPTH);

        return `<h${level}>${this.parser.parseInline(tokens)}</h${level}>\n`;
      },
      // A link carries the host's hook; the host attaches hover and click there and edits nothing.
      link({ href, tokens }) {
        return `<a href="${escapePlain(href)}" ${MD_HOOK}="link">${this.parser.parseInline(tokens)}</a>`;
      },
      // Written as the sanitizer writes them, so a benign parse never reads as stripped.
      br: () => '<br />',
      hr: () => '<hr />\n',
      // A fenced block keeps its language as a class and carries the hook.
      code({ text, lang }) {
        const language = (lang ?? '').trim().split(/\s+/)[0];
        const cls = language ? ` class="language-${escapePlain(language)}"` : '';

        return `<pre ${MD_HOOK}="code-block"><code${cls}>${escapePlain(text)}</code></pre>\n`;
      },
    },
  });

  const sanitizeParsed = (parsed: string): SanitizedMarkdown => {
    const html = sanitizeHtml(parsed, SANITIZE_OPTIONS);

    return { html: withoutLayoutNewlines(html), stripped: html !== parsed };
  };

  return {
    html: (dirty) => sanitizeHtml(dirty, SANITIZE_OPTIONS),
    // The canvas newline rule is written into the text first (canvasMarkdown.ts).
    markdown: (md) => sanitizeParsed(marked.parse(canvasBlockMarkdown(md)) as string),
    // Inline marks only; block starters like `#` / `1.` stay literal.
    inlineMarkdown: (md) => sanitizeParsed(marked.parseInline(canvasInlineMarkdown(md)) as string),
    plain: escapePlain,
  };
}

/**
 * The newlines marked writes between and after its blocks (`<p>a</p>\n<p>b</p>\n`) are layout, not text: a run drawn
 * with `white-space: pre` (a text box with no fixed width) would draw each as an empty line. A code block's own
 * newlines stay: they sit inside `<pre>`, never between a closing and an opening tag.
 */
function withoutLayoutNewlines(html: string): string {
  return html.replace(/>\n+(?=<)/g, '>').replace(/\n+$/, '');
}

function escapePlain(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface StageResult {
  errors: Issue[];
  warnings: Issue[];
}

/**
 * Applies each text property's content policy. All output strings are safe to inject.
 * Mutates the element clones in place.
 */
export function stageSanitize(
  items: readonly PipelineElement[],
  policyTables: Record<string, PolicyEntry[]>,
  s: Sanitizers,
): StageResult {
  const warnings: Issue[] = [];

  for (const { index, path: elementPath, tag, element } of items) {
    const entries = policyTables[tag] ?? [];

    for (const entry of entries) {
      if (entry.kind === 'content') {
        const policy = entry.contentPolicy ?? 'plain';

        for (const hit of resolvePointer(element, entry.pointer)) {
          if (typeof hit.value !== 'string') {
            continue;
          }

          const { value: cleaned, warn } = applyPolicy(hit.value, policy, s);
          hit.set(cleaned);

          if (warn) {
            warnings.push({
              code: WARNING_CODE.CONTENT_SANITIZED,
              severity: SEVERITY.WARNING,
              path: `${elementPath}${hit.path}`,
              elementIndex: index,
              tag,
              message: `Content at ${elementPath}${hit.path} was sanitized (${policy}).`,
            });
          }
        }
      }
    }
  }

  return { errors: [], warnings };
}

/** Raw-HTML-ish source: `<` opening a tag name, closer, or declaration. */
const RAW_HTML_RE = /<[a-zA-Z!/]/;

/**
 * `warn` means the input was altered beyond the policy's normal transform: markup stripped by the
 * html policy, raw HTML neutralized (escaped to literal text) in parsed markdown, metacharacters
 * escaped by plain. The markdown parse itself (text → tags) is the expected transform and never
 * warns.
 */
function applyPolicy(
  value: string,
  policy: ContentPolicy,
  s: Sanitizers,
): { value: string; warn: boolean } {
  switch (policy) {
    case 'markdown': {
      const md = s.markdown(value);

      return { value: md.html, warn: md.stripped || RAW_HTML_RE.test(value) };
    }

    case 'inline-markdown': {
      const md = s.inlineMarkdown(value);

      return { value: md.html, warn: md.stripped || RAW_HTML_RE.test(value) };
    }

    case 'html': {
      const cleaned = s.html(value);

      return { value: cleaned, warn: cleaned !== value };
    }

    // 'plain' and any unknown policy value escape.
    default: {
      const cleaned = s.plain(value);

      return { value: cleaned, warn: cleaned !== value };
    }
  }
}
