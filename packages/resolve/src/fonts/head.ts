import type { FontSource, FontsConfig } from '@eraserlabs/protocol';

export function cssQuoted(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** One `@font-face` rule. `src` is the value inside `url(...)`. */
export function fontFaceRule(face: {
  family: string;
  src: string;
  weight?: string;
  style?: string;
  format?: string;
}): string {
  const weight = face.weight ? `font-weight:${face.weight};` : '';
  const style = face.style ? `font-style:${face.style};` : '';
  const format = face.format ? ` format(${cssQuoted(face.format)})` : '';

  return `@font-face{font-family:${cssQuoted(face.family)};${weight}${style}src:url(${cssQuoted(face.src)})${format}}`;
}

/**
 * Build the `#eraser-fonts` stylesheet: one `--font-<role>` var per role (terminated by a generic
 * family so degradation is guaranteed) plus one `@font-face` rule per `url` face. Absolute
 * `http(s)://` sources load in the render page; `file` / `file-from-url` faces are injected as
 * `FontFace` bytes, not CSS.
 */
export function buildFontsHead(config: FontsConfig): string {
  const vars = Object.entries(config.roles).map(
    ([role, family]) =>
      `--font-${role}:${cssQuoted(family)},${config.fallbacks?.[role] ?? 'sans-serif'}`,
  );
  const urlFaces = config.faces
    .filter((face): face is Extract<FontSource, { kind: 'url' }> => face.kind === 'url')
    .map((face) =>
      fontFaceRule({
        family: face.family,
        src: face.url,
        ...(face.weight ? { weight: face.weight } : {}),
        ...(face.style ? { style: face.style } : {}),
        ...(face.format ? { format: face.format } : {}),
      }),
    );

  return `:root{${vars.join(';')}}${urlFaces.join('')}`;
}
