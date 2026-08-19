/**
 * Page-side font registration. Byte-backed faces (`file` / `file-from-url`) arrive as base64 and
 * become `FontFace` objects — Chromium blocks `file://` subresources from an origin-less page, so
 * those faces cannot load from disk natively. `url` faces are declared as `@font-face` rules in
 * `css`; absolute `http(s)://` URLs load from an origin-less page. After writing the stylesheet,
 * each url family is force-started with `document.fonts.load` so `run()`'s `document.fonts.ready`
 * wait is deterministic. A face that fails to parse degrades (status 'error') without crashing.
 */

/** The stylesheet this stage owns; `serialize()` reads it back. */
export const FONTS_STYLE_ID = 'eraser-fonts';

export interface WireFontFace {
  family: string;
  /** Raw font bytes, base64-encoded (structured clones across the page boundary carry no buffers). */
  bytes64: string;
  weight?: string;
  style?: string;
}

export interface UrlFontFace {
  family: string;
  weight?: string;
  style?: string;
}

export interface RegisterFontsRequest {
  /** Role-var stylesheet plus `@font-face` rules for `url` faces — becomes `#eraser-fonts`. */
  css: string;
  faces: WireFontFace[];
  /** `url` faces whose loads must start before `run()` samples `document.fonts.ready`. */
  urlFaces?: UrlFontFace[];
}

export async function registerFonts(request: RegisterFontsRequest): Promise<void> {
  let style = document.getElementById(FONTS_STYLE_ID);

  if (!style) {
    style = document.createElement('style');
    style.id = FONTS_STYLE_ID;
    document.head.appendChild(style);
  }

  style.textContent = request.css;

  for (const face of request.urlFaces ?? []) {
    void document.fonts.load(fontLoadSpec(face));
  }

  for (const face of request.faces) {
    const bin = atob(face.bytes64);
    const bytes = new Uint8Array(bin.length);

    for (let i = 0; i < bin.length; i += 1) {
      bytes[i] = bin.charCodeAt(i);
    }

    const descriptors: FontFaceDescriptors = {};

    if (face.weight) {
      descriptors.weight = face.weight;
    }

    if (face.style) {
      descriptors.style = face.style;
    }

    const fontFace = new FontFace(face.family, bytes.buffer, descriptors);
    document.fonts.add(fontFace);

    try {
      await fontFace.load();
    } catch {
      // Face status 'error' is the observable signal; the page must not crash.
    }
  }
}

function fontLoadSpec(face: UrlFontFace): string {
  const parts: string[] = [];

  if (face.style) {
    parts.push(face.style);
  }

  if (face.weight) {
    parts.push(face.weight);
  }

  parts.push('1em');
  parts.push(`"${face.family.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);

  return parts.join(' ');
}
