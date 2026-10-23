export interface HtmlDocumentInit {
  title?: string;
  /** Stylesheet contents, emitted as one `<style>` each, in order. Empty entries are skipped. */
  styles?: string[];
  /** Body markup, emitted verbatim — the caller owns its safety. */
  body: string;
  /**
   * Where the styles' `@font-face` URLs load from, as CSP sources (`file:`, `https://fonts.example`).
   * `data:` is always allowed.
   */
  fontSources?: string[];
}

/** A scheme (`file:`) or an origin (`https://host:port`), the only font sources a policy names. */
const FONT_SOURCE = /^(?:[a-z][a-z\d+.-]*:|https?:\/\/(?:[a-z\d.-]+|\[[\da-f:.]+\])(?::\d+)?)$/i;

/**
 * The policy of a standalone diagram: the artifact is static, so no script runs at all, and it
 * loads nothing but its inline styles, `data:` images, and its fonts. Markup that slipped past
 * sanitization stays inert, and the file makes no request beyond its fonts.
 */
export function standaloneContentPolicy(fontSources: readonly string[] = []): string {
  for (const source of fontSources) {
    if (!FONT_SOURCE.test(source)) {
      throw new Error(`not a font source for a content policy: ${source}`);
    }
  }

  const fonts = ['data:', ...new Set(fontSources)].join(' ');

  return `default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src ${fonts}; base-uri 'none'; form-action 'none'`;
}

/**
 * The one HTML document shell: doctype, charset, content policy, optional title, stylesheets,
 * body. Used for the serialized diagram artifact and for any harness that needs a full page
 * around scene markup. The policy comes first in `<head>`, before anything it governs.
 */
export function buildHtmlDocument(init: HtmlDocumentInit): string {
  const policy = `<meta http-equiv="Content-Security-Policy" content="${standaloneContentPolicy(init.fontSources)}">`;
  const title = init.title === undefined ? '' : `<title>${escapeText(init.title)}</title>`;
  const styles = (init.styles ?? [])
    .filter((css) => css.trim() !== '')
    .map((css) => `<style>${css}</style>`)
    .join('');

  return `<!doctype html><html><head><meta charset="utf-8">${policy}${title}${styles}</head><body>${init.body}</body></html>`;
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
