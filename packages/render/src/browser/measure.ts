import {
  addPaddingToRange,
  combineRanges,
  intersectRanges,
  makePropsFromRange,
  makeRangeFromEntity,
  shiftRange,
  type LayoutRange,
} from '@eraserlabs/layout';
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

/** Union of painted descendant boxes, respecting overflow clips and inert SVG definitions. */
function measureInk(wrapper: HTMLElement, origin: DOMRect): MeasuredBox {
  let ink = makeRangeFromEntity(origin);

  const visit = (node: Element, ancestorClip: LayoutRange) => {
    // Definition geometry has DOM bounds but is not painted at its definition site.
    if (node.matches('defs, mask, clipPath, filter, symbol, title, desc')) {
      return;
    }

    const style = getComputedStyle(node);
    if (style.display === 'none') {
      return;
    }
    const clipPath = svgClipBounds(node, style.clipPath);
    const clip = clipPath ? intersectRanges(ancestorClip, clipPath) : ancestorClip;
    if (!clip) {
      return;
    }
    const rect = node.getBoundingClientRect();
    // SVG groups have no paint of their own; their aggregate bounds include clipped children.
    if (node.localName !== 'g' && style.visibility === 'visible' && (rect.width || rect.height)) {
      const painted = addPaddingToRange(makeRangeFromEntity(rect), shadowExtents(style.boxShadow));
      const visible = intersectRanges(clip, painted);
      if (visible) {
        ink = combineRanges(ink, visible);
      }
    }

    // A node's overflow clips its descendants, not its own shadow. Keep each axis independent.
    const childClip = intersectRanges(clip, {
      minX: style.overflowX === 'visible' ? -Infinity : rect.left,
      maxX: style.overflowX === 'visible' ? Infinity : rect.right,
      minY: style.overflowY === 'visible' ? -Infinity : rect.top,
      maxY: style.overflowY === 'visible' ? Infinity : rect.bottom,
    });
    if (!childClip) {
      return;
    }
    for (const child of node.children) {
      visit(child, childClip);
    }
  };
  for (const child of wrapper.children) {
    visit(child, { minX: -Infinity, minY: -Infinity, maxX: Infinity, maxY: Infinity });
  }

  return makePropsFromRange(shiftRange(ink, { deltaX: -origin.x, deltaY: -origin.y }));
}

/**
 * SVG clip paths bound their painted children, even when getBoundingClientRect reports an
 * oversized <use> master. Transform the clip geometry into viewport coordinates. Its bounding
 * rectangle is conservative for curved/disjoint clips; it never crops the visible silhouette.
 * Other CSS clip forms remain conservative (unclipped) in this geometry-based measurement.
 */
function svgClipBounds(node: Element, value: string): LayoutRange | null {
  if (!(node instanceof SVGGraphicsElement) || !value.startsWith('url(')) {
    return null;
  }
  const id = /#([^"')]+)["']?\)/.exec(value)?.[1];
  const path = id ? document.getElementById(id) : null;
  const screen = node.getScreenCTM();
  if (!(path instanceof SVGClipPathElement) || !screen) {
    return null;
  }
  // Chromium may expose the legacy SVGMatrix here; normalize before composing DOMMatrices.
  let matrix = DOMMatrix.fromMatrix(screen);
  if (path.clipPathUnits.baseVal === SVGUnitTypes.SVG_UNIT_TYPE_OBJECTBOUNDINGBOX) {
    const box = node.getBBox();
    matrix = matrix.translate(box.x, box.y).scale(box.width, box.height);
  }
  matrix = matrix.multiply(svgTransform(path.transform.baseVal));
  let bounds: LayoutRange | null = null;
  for (const child of path.children) {
    if (!(child instanceof SVGGraphicsElement)) {
      continue;
    }
    const box = child.getBBox();
    const toScreen = matrix.multiply(svgTransform(child.transform.baseVal));
    const points = [
      new DOMPoint(box.x, box.y),
      new DOMPoint(box.x + box.width, box.y),
      new DOMPoint(box.x, box.y + box.height),
      new DOMPoint(box.x + box.width, box.y + box.height),
    ].map((point) => point.matrixTransform(toScreen));
    const rect = combineRanges(
      ...points.map(({ x, y }) => ({ minX: x, maxX: x, minY: y, maxY: y })),
    );
    bounds = bounds ? combineRanges(bounds, rect) : rect;
  }
  return bounds;
}

/** Read transforms without consolidate(), which mutates the authored SVG transform list. */
function svgTransform(list: SVGTransformList): DOMMatrix {
  let matrix = new DOMMatrix();
  for (let i = 0; i < list.numberOfItems; i++) {
    matrix = matrix.multiply(list.getItem(i).matrix);
  }
  return matrix;
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
function shadowExtents(shadow: string): ShadowExtents {
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
