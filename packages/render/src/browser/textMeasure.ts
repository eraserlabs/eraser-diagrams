import type { Box } from '@eraserlabs/render';

export interface TextMeasure {
  /** Text fragments in CSS pixels relative to the supplied element, including inline formatting. */
  fragments: Box[];
  /** Union of text fragments; null for empty/non-rendered text. Excludes the element's padding. */
  bounds: Box | null;
}

/** Measure the browser's actual text layout at its current width/font; never inserts or changes text. */
export async function measureText(root: HTMLElement): Promise<TextMeasure> {
  if (!root.isConnected || root.ownerDocument !== document) {
    throw new Error('measureText requires an element mounted in the current document');
  }
  root.getBoundingClientRect();
  await document.fonts.ready;
  const origin = root.getBoundingClientRect();
  const fragments = textRects(root)
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .map((rect) => ({
      x: rect.x - origin.x,
      y: rect.y - origin.y,
      width: rect.width,
      height: rect.height,
    }));
  if (fragments.length === 0) {
    return { fragments, bounds: null };
  }
  const x = Math.min(...fragments.map((rect) => rect.x));
  const y = Math.min(...fragments.map((rect) => rect.y));
  return {
    fragments,
    bounds: {
      x,
      y,
      width: Math.max(...fragments.map((rect) => rect.x + rect.width)) - x,
      height: Math.max(...fragments.map((rect) => rect.y + rect.height)) - y,
    },
  };
}

export function textRects(root: HTMLElement): DOMRect[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const rects: DOMRect[] = [];
  let current = walker.nextNode();

  while (current) {
    if (current.textContent?.trim()) {
      const range = document.createRange();
      range.selectNodeContents(current);
      rects.push(...range.getClientRects());
    }

    current = walker.nextNode();
  }

  return rects;
}
