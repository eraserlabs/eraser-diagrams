import sanitizeHtml from 'sanitize-html';
import { Marked } from 'marked';
import type { Issue } from '../result-types.js';
import { WARNING_CODE, SEVERITY } from '../result-types.js';
import type { PolicyEntry } from '../types.js';
import type { ContentPolicy } from '../schema/keywords.js';
import type { PipelineElement } from './element.js';
import { resolvePointer } from './pointer.js';

const SAFE_SCHEMES = ['http', 'https', 'mailto'];

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p',
    'br',
    'b',
    'i',
    'em',
    'strong',
    'code',
    'ul',
    'ol',
    'li',
    'a',
    'span',
    'h1',
    'h2',
    'h3',
  ],
  // `ol.start` keeps ordered lists numbered as authored: each text run parses as its own
  // single-item list, so dropping `start` renumbered every one of them to "1." — and made
  // sanitized output differ from parser output, firing a spurious W_CONTENT_SANITIZED.
  allowedAttributes: { a: ['href'], ol: ['start'] },
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
  const marked = new Marked({ async: false, gfm: true });

  // Raw HTML in markdown source renders as literal text, never as markup.
  marked.use({
    renderer: {
      html: (token: { text: string } | string) =>
        escapePlain(typeof token === 'string' ? token : token.text),
    },
  });

  const sanitizeParsed = (parsed: string): SanitizedMarkdown => {
    const html = sanitizeHtml(parsed, SANITIZE_OPTIONS);

    return { html, stripped: html !== parsed };
  };

  return {
    html: (dirty) => sanitizeHtml(dirty, SANITIZE_OPTIONS),
    markdown: (md) => sanitizeParsed(marked.parse(unescapeNewlines(md)) as string),
    // Inline marks only; block starters like `#` / `1.` stay literal.
    inlineMarkdown: (md) => sanitizeParsed(marked.parseInline(unescapeNewlines(md)) as string),
    plain: escapePlain,
  };
}

/**
 * Authored text often carries newlines as the two-character `\n` escape; treat them as real
 * line breaks for both markdown policies.
 */
function unescapeNewlines(md: string): string {
  return md.replace(/\\n/g, '\n');
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
