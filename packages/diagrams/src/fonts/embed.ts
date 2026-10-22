import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cssQuoted, fontFaceRule } from '@eraserlabs/resolve';
import type { StagedByteSource, StagedFontFace, StagedFonts } from './staging.js';

/**
 * `@font-face` rules for standalone HTML. `file` and `file-from-url` reference their source
 * (`file:///<abs>` or the original URL) unless `inline` is true, in which case today's base64
 * data-URI rule is emitted. `url` faces are not emitted here — their rules already live in the
 * `#eraser-fonts` CSS. System faces need no rule.
 */
export function buildEmbeddedFontCss(staged: StagedFonts): string {
  return staged.faces.map(embeddedRule).join('');
}

/**
 * Where the standalone HTML's fonts load from, as content-policy sources: `file:` for a file
 * face that is not inlined, and the origin of each other referenced face (`file-from-url` not
 * inlined, `url`). Inlined faces are `data:`, which the policy always allows; a URL the policy
 * cannot name is left out, so that face does not load.
 */
export function htmlFontSources(staged: StagedFonts): string[] {
  const urls = [
    ...staged.faces.flatMap(({ source }) =>
      source && source.inline !== true ? [referencedUrl(source)] : [],
    ),
    ...staged.config.faces.flatMap((face) => (face.kind === 'url' ? [face.url] : [])),
  ];

  return [...new Set(urls.flatMap(policySource))];
}

function referencedUrl(source: StagedByteSource): string {
  return source.kind === 'file' ? pathToFileURL(resolve(source.path)).href : source.url;
}

function policySource(url: string): string[] {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return [];
  }

  if (parsed.protocol === 'file:') {
    return ['file:'];
  }

  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? [parsed.origin] : [];
}

function embeddedRule(face: StagedFontFace): string {
  const source = face.source;
  const descriptors = {
    family: face.family,
    ...(face.weight ? { weight: face.weight } : {}),
    ...(face.style ? { style: face.style } : {}),
    ...(source?.format ? { format: source.format } : {}),
  };

  if (source && source.inline !== true) {
    return fontFaceRule({ ...descriptors, src: referencedUrl(source) });
  }

  const weight = face.weight ? `font-weight:${face.weight};` : '';
  const style = face.style ? `font-style:${face.style};` : '';
  const bytes64 = Buffer.from(face.bytes).toString('base64');

  return `@font-face{font-family:${cssQuoted(face.family)};${weight}${style}src:url(data:font/ttf;base64,${bytes64})}`;
}
