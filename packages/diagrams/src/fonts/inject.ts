import type { Page } from 'playwright-core';
// Type-only: pulls in the window.__eraser global declaration for the evaluate callback.
import type { UrlFontFace, WireFontFace } from '@eraserlabs/render/browser';
import type { StagedFonts } from './staging.js';

/** The registerFonts payload, built once per renderer and shared by every pooled page. */
export interface FontsRequest {
  css: string;
  faces: WireFontFace[];
  urlFaces: UrlFontFace[];
}

/**
 * Base64-encode each byte face into the wire payload exactly once — pooled pages all receive
 * the same request, so per-page encoding would repeat multi-MB passes for identical output.
 */
export function prepareFontsRequest(staged: StagedFonts): FontsRequest {
  const faces: WireFontFace[] = staged.faces.map((f) => {
    const wire: WireFontFace = {
      family: f.family,
      bytes64: Buffer.from(f.bytes).toString('base64'),
    };

    if (f.weight) {
      wire.weight = f.weight;
    }

    if (f.style) {
      wire.style = f.style;
    }

    return wire;
  });

  const urlFaces: UrlFontFace[] = staged.config.faces.flatMap((face) => {
    if (face.kind !== 'url') {
      return [];
    }

    const wire: UrlFontFace = { family: face.family };

    if (face.weight) {
      wire.weight = face.weight;
    }

    if (face.style) {
      wire.style = face.style;
    }

    return [wire];
  });

  return { css: staged.css, faces, urlFaces };
}

/**
 * Hand the prepared payload to the page's `__eraser.registerFonts` (the IIFE must already be
 * loaded). Must complete before `run()` — it awaits `document.fonts.ready`.
 */
export async function injectFonts(page: Page, request: FontsRequest): Promise<void> {
  await page.evaluate((r) => window.__eraser.registerFonts(r), request);
}
