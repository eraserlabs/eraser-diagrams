import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cssQuoted, fontFaceRule } from '@eraserlabs/resolve';
import type { StagedFontFace, StagedFonts } from './staging.js';

/**
 * `@font-face` rules for standalone HTML. `file` and `file-from-url` reference their source
 * (`file:///<abs>` or the original URL) unless `inline` is true, in which case today's base64
 * data-URI rule is emitted. `url` faces are not emitted here — their rules already live in the
 * `#eraser-fonts` CSS. System faces need no rule.
 */
export function buildEmbeddedFontCss(staged: StagedFonts): string {
  return staged.faces.map(embeddedRule).join('');
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
    const src = source.kind === 'file' ? pathToFileURL(resolve(source.path)).href : source.url;

    return fontFaceRule({ ...descriptors, src });
  }

  const weight = face.weight ? `font-weight:${face.weight};` : '';
  const style = face.style ? `font-style:${face.style};` : '';
  const bytes64 = Buffer.from(face.bytes).toString('base64');

  return `@font-face{font-family:${cssQuoted(face.family)};${weight}${style}src:url(data:font/ttf;base64,${bytes64})}`;
}
