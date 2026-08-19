import type { Box } from '@eraserlabs/render';
import type { MountedElement } from './mount.js';

/** Same shape as the scene's `Box`; aliased so measurement and layout output cannot drift apart. */
export type MeasuredBox = Box;

export interface ElementMeasure {
  id: string;
  tag: string;
  /** Natural max-content box from pass 1, before authored minimums were applied. */
  intrinsic: MeasuredBox;
  /**
   * The routable layout box: bounding box of the template root (`[data-tpl]`), relative to the
   * wrapper origin. Null if the template mounted nothing.
   */
  body: MeasuredBox | null;
  /**
   * Ink extent relative to the wrapper origin: union of every rendered descendant rect plus
   * box-shadow extents — badges, overflowing labels, shadows. Drives PNG cropping.
   */
  ink: MeasuredBox;
  /** Bounding boxes of every `[data-role]` node, wrapper-relative, grouped by role. */
  roles: Record<string, MeasuredBox[]>;
  /** Bounding boxes of every `[data-part]` node, wrapper-relative, grouped by part name. */
  parts: Record<string, MeasuredBox[]>;
  /** Containers only: union of member body boxes (fit diagnostics). Filled by the caller. */
  content?: MeasuredBox;
}

/** Pass 1: the wrappers are max-content sized — their rects are the intrinsic boxes. */
export function measureIntrinsics(mounted: MountedElement[]): Map<string, MeasuredBox> {
  return new Map(
    mounted.map(({ id, wrapper }) => {
      const rect = wrapper.getBoundingClientRect();

      return [id, { x: 0, y: 0, width: rect.width, height: rect.height }];
    }),
  );
}

/** Pass 2: final boxes after sizes were resolved onto the wrappers. All boxes wrapper-relative. */
export function measureScene(
  mounted: MountedElement[],
  intrinsics: Map<string, MeasuredBox>,
): ElementMeasure[] {
  return mounted.map(({ id, tag, wrapper }) => {
    const origin = wrapper.getBoundingClientRect();
    const relative = (rect: DOMRect): MeasuredBox => ({
      x: rect.x - origin.x,
      y: rect.y - origin.y,
      width: rect.width,
      height: rect.height,
    });

    // First [data-tpl] in document order is the element's own template root; nested (data-use)
    // template roots come later in the subtree.
    const root = wrapper.querySelector('[data-tpl]');
    const roles: Record<string, MeasuredBox[]> = {};
    const parts: Record<string, MeasuredBox[]> = {};

    for (const node of wrapper.querySelectorAll('[data-role]')) {
      const role = node.getAttribute('data-role')!;
      const measures = roles[role] ?? [];
      measures.push(relative(node.getBoundingClientRect()));
      roles[role] = measures;
    }

    for (const node of wrapper.querySelectorAll('[data-part]')) {
      const part = node.getAttribute('data-part')!;
      const measures = parts[part] ?? [];
      measures.push(relative(node.getBoundingClientRect()));
      parts[part] = measures;
    }

    return {
      id,
      tag,
      intrinsic: intrinsics.get(id) ?? { x: 0, y: 0, width: origin.width, height: origin.height },
      body: root ? relative(root.getBoundingClientRect()) : null,
      ink: measureInk(wrapper, origin),
      roles,
      parts,
    };
  });
}

/** Union of every rendered descendant rect plus box-shadow extents, wrapper-relative. */
function measureInk(wrapper: HTMLElement, origin: DOMRect): MeasuredBox {
  let left = 0;
  let top = 0;
  let right = origin.width;
  let bottom = origin.height;

  for (const node of wrapper.querySelectorAll('*')) {
    const rect = node.getBoundingClientRect();

    // display:none subtrees report zero rects at the viewport origin — not ink.
    if (rect.width === 0 && rect.height === 0) {
      continue;
    }

    const shadow = shadowExtents(node);
    left = Math.min(left, rect.x - origin.x - shadow.left);
    top = Math.min(top, rect.y - origin.y - shadow.top);
    right = Math.max(right, rect.x - origin.x + rect.width + shadow.right);
    bottom = Math.max(bottom, rect.y - origin.y + rect.height + shadow.bottom);
  }

  return { x: left, y: top, width: right - left, height: bottom - top };
}

interface ShadowExtents {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const NO_SHADOW: ShadowExtents = { left: 0, top: 0, right: 0, bottom: 0 };

/**
 * Box-shadow paints outside every rect, so it must be added explicitly. Computed style expands
 * each shadow to four px lengths (offset-x, offset-y, blur, spread) after its color; the list is
 * walked per shadow so `inset` entries — which paint inside the border box — never extend ink.
 */
function shadowExtents(node: Element): ShadowExtents {
  const shadow = getComputedStyle(node).boxShadow;

  if (shadow === '' || shadow === 'none') {
    return NO_SHADOW;
  }

  const extents: ShadowExtents = { ...NO_SHADOW };

  // Split the shadow list on top-level commas only (color functions carry their own commas).
  for (const single of shadow.split(/,(?![^(]*\))/)) {
    if (single.includes('inset')) {
      continue;
    }

    const lengths = [...single.matchAll(/(-?\d*\.?\d+)px/g)].map((m) => Number(m[1]));
    const [offsetX = 0, offsetY = 0, blur = 0, spread = 0] = lengths;
    const halo = blur + spread;
    extents.left = Math.max(extents.left, halo - offsetX);
    extents.top = Math.max(extents.top, halo - offsetY);
    extents.right = Math.max(extents.right, halo + offsetX);
    extents.bottom = Math.max(extents.bottom, halo + offsetY);
  }

  return extents;
}
