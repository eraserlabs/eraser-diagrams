import type { Page } from '@playwright/test';

/** Ahem draws every glyph as a full em square, so 'AAAA' at 100px is exactly 400px wide. */
export const AHEM_PROBE_WIDTH = 400;

/**
 * Force-load a family and report the browser's ground truth. Shell content sits in inert
 * <template> elements, so nothing triggers font loads until we ask document.fonts directly.
 */
export async function loadFont(
  page: Page,
  family: string,
): Promise<{ loaded: boolean; statuses: Record<string, string> }> {
  return page.evaluate(async (fam) => {
    try {
      await document.fonts.load(`16px "${fam}"`);
    } catch {
      // A failing face rejects the promise; its status below still tells the story.
    }

    await document.fonts.ready;

    const statuses: Record<string, string> = {};

    document.fonts.forEach((face) => {
      statuses[face.family.replace(/["']/g, '')] = face.status;
    });

    return { loaded: document.fonts.check(`16px "${fam}"`), statuses };
  }, family);
}

/** Width of 'AAAA' at 100px in the given family — proves which glyphs actually render. */
export async function probeWidth(page: Page, family: string): Promise<number> {
  return page.evaluate(async (fam) => {
    await document.fonts.ready;
    const el = document.createElement('div');
    el.style.cssText = `position:absolute;font-size:100px;font-family:'${fam}',serif;white-space:pre`;
    el.textContent = 'AAAA';
    document.body.appendChild(el);
    const width = el.getBoundingClientRect().width;
    el.remove();

    return width;
  }, family);
}

/** Collect http(s) font requests the page makes — zero for properly staged local fonts. */
export function trackFontRequests(page: Page): string[] {
  const urls: string[] = [];

  page.on('request', (req) => {
    if (req.resourceType() === 'font' && req.url().startsWith('http')) {
      urls.push(req.url());
    }
  });

  return urls;
}
