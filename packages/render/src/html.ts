export interface HtmlDocumentInit {
  title?: string;
  /** Stylesheet contents, emitted as one `<style>` each, in order. Empty entries are skipped. */
  styles?: string[];
  /** Body markup, emitted verbatim — the caller owns its safety. */
  body: string;
}

/**
 * The one HTML document shell: doctype, charset, optional title, stylesheets, body. Used for the
 * serialized diagram artifact and for any harness that needs a full page around scene markup.
 */
export function buildHtmlDocument(init: HtmlDocumentInit): string {
  const title = init.title === undefined ? '' : `<title>${escapeText(init.title)}</title>`;
  const styles = (init.styles ?? [])
    .filter((css) => css.trim() !== '')
    .map((css) => `<style>${css}</style>`)
    .join('');

  return `<!doctype html><html><head><meta charset="utf-8">${title}${styles}</head><body>${init.body}</body></html>`;
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
