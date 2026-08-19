import type { Box, SceneLayout } from '@eraserlabs/render';
import type { MountedElement } from './mount.js';
import type { ElementMeasure } from './measure.js';

/**
 * Write layout geometry into the mounted DOM. Positions and path data are numeric,
 * layout-computed values — `setAttribute`/style writes carry no content-escaping concern (the fill
 * stage's innerHTML rule does not apply here).
 *
 * The scene element is sized to the layout scene box grown by every element's ink — paint outside
 * the layout boxes (badges, shadows, connection labels) must land inside the scene, or PNG
 * screenshots clip it and the HTML export's declared box lies.
 */
export function applyLayout(
  scene: HTMLElement,
  mounted: MountedElement[],
  layout: SceneLayout,
  zIndexById?: Map<string, number>,
  measures?: ElementMeasure[],
): void {
  const sceneBox = inkAwareSceneBox(layout, measures);
  const originX = sceneBox.x;
  const originY = sceneBox.y;
  const measureById = new Map((measures ?? []).map((measure) => [measure.id, measure]));
  // Node ink deliberately spills past its layout box — the shape shadow's 4px offset, the
  // watercolor wash's jitter — so a line sharing a node's layer loses its first pixels to whichever
  // node paints later. Routes never cross a leaf node (the router treats them as obstacles) and
  // container backgrounds are nodes too, so one layer above every node is always safe.
  const topNodeZIndex = Math.max(0, ...(zIndexById?.values() ?? []));
  const connectionZIndex = topNodeZIndex + 1;
  const labelZIndex = topNodeZIndex + 2;
  let maskOrdinal = 0;
  scene.style.position = 'relative';
  scene.style.width = `${sceneBox.width}px`;
  scene.style.height = `${sceneBox.height}px`;

  for (const element of mounted) {
    const box = layout.boxes[element.id];
    const zIndex = zIndexById?.get(element.id);

    if (box) {
      const style = element.wrapper.style;
      style.position = 'absolute';
      style.left = `${box.x - originX}px`;
      style.top = `${box.y - originY}px`;
      style.width = `${box.width}px`;
      style.height = `${box.height}px`;

      if (zIndex !== undefined) {
        style.zIndex = String(zIndex);
      }

      continue;
    }

    const connection = layout.connections[element.id];

    if (!connection) {
      continue;
    }

    // Connections draw on a full-scene overlay so their path data stays in scene coordinates.
    const style = element.wrapper.style;
    style.position = 'absolute';
    style.left = '0';
    style.top = '0';
    style.width = '100%';
    style.height = '100%';
    style.pointerEvents = 'none';
    // A positioned wrapper with a numeric z-index is a stacking context. Leaving connection
    // wrappers at `auto` lets their line and label take independent places in the scene's stack:
    // every line shares one layer above the nodes, every label one layer above the lines.
    style.zIndex = 'auto';

    const anchor = element.wrapper.querySelector('[data-role="anchor"]');
    // A connection template may contain decorative SVGs before its routed anchor. Its owning SVG
    // is the coordinate space that receives the scene viewBox and the label mask.
    const svg =
      (anchor instanceof SVGElement ? anchor.ownerSVGElement : null) ??
      element.wrapper.querySelector('svg');

    if (svg) {
      svg.setAttribute('viewBox', `${originX} ${originY} ${sceneBox.width} ${sceneBox.height}`);
      svg.setAttribute('width', String(sceneBox.width));
      svg.setAttribute('height', String(sceneBox.height));
      svg.style.position = 'absolute';
      svg.style.left = '0';
      svg.style.top = '0';
      svg.style.zIndex = String(connectionZIndex);
    }

    anchor?.setAttribute('d', connection.d);

    const label = element.wrapper.querySelector('[data-role="external-text"]');

    if (label instanceof HTMLElement) {
      // A placed box is authoritative — the routes were kept clear of exactly that rect, so the
      // label must land there. Without one the midpoint anchor carries it.
      const placed = connection.labelBox;
      label.style.position = 'absolute';
      label.style.left = `${(placed?.x ?? connection.label.x) - originX}px`;
      label.style.top = `${(placed?.y ?? connection.label.y) - originY}px`;
      label.style.transform = placed ? '' : 'translate(-50%, -100%)';
      label.style.zIndex = String(labelZIndex);

      const labelBox = placed ?? fallbackLabelBox(connection.label, measureById.get(element.id));

      if (svg && anchor && labelBox) {
        const cutout = {
          x: labelBox.x - LABEL_MASK_CLEARANCE,
          y: labelBox.y - LABEL_MASK_CLEARANCE,
          width: labelBox.width + LABEL_MASK_CLEARANCE * 2,
          height: labelBox.height + LABEL_MASK_CLEARANCE * 2,
        };
        const route = routeVertices(connection.d);
        const strokeWidth = Number.parseFloat(getComputedStyle(anchor).strokeWidth) || 0;

        // A cutout that never lands on the line has no gap to cut — the router placed the label
        // clear of the route — but the mask would still clip this path's markers. Skip it.
        if (cutsTheRoute(cutout, route, strokeWidth / 2)) {
          const hasAuthoredMask =
            anchor.hasAttribute('mask') && anchor.getAttribute('mask')?.trim() !== 'none';
          const hasAuthoredClip =
            anchor.hasAttribute('clip-path') && anchor.getAttribute('clip-path')?.trim() !== 'none';
          const resourceId = uniqueResourceId(
            scene,
            hasAuthoredMask && !hasAuthoredClip
              ? 'eraser-connection-label-clip'
              : 'eraser-connection-label-mask',
            maskOrdinal++,
          );
          installLabelGap(
            svg,
            anchor,
            resourceId,
            element.id,
            sceneBox,
            cutout,
            markerGuards(svg, anchor, route, strokeWidth)
              .map((guard) => intersection(guard, cutout))
              .filter((guard): guard is Box => guard !== undefined),
            hasAuthoredMask,
            hasAuthoredClip,
          );
        }
      }
    }
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';
// Midpoint fallback labels end exactly on their path. Two user-space pixels carry the cut past
// that boundary, removing the full anti-aliased edge of the stock strokes (up to 4px centered)
// instead of leaving a half-stroke beneath a transparent label.
const LABEL_MASK_CLEARANCE = 2;

/** The midpoint pin used by apply projected through the label's measured border-box size. */
function fallbackLabelBox(
  label: { x: number; y: number },
  measure: ElementMeasure | undefined,
): Box | undefined {
  const measured = measure?.roles['external-text']?.[0];

  if (!measured) {
    return undefined;
  }

  return {
    x: label.x - measured.width / 2,
    y: label.y - measured.height,
    width: measured.width,
    height: measured.height,
  };
}

type Point = [number, number];

/** Vertices of a route path; a rounded corner's arc endpoint stands in for the corner it replaced. */
function routeVertices(d: string): Point[] {
  const points: Point[] = [];

  for (const command of d.matchAll(/[MLA]([^MLA]*)/g)) {
    const numbers = [...command[1]!.matchAll(/-?[\d.]+/g)].map((value) => Number(value[0]));

    if (numbers.length >= 2) {
      points.push([numbers[numbers.length - 2]!, numbers[numbers.length - 1]!]);
    }
  }

  return points;
}

/** Does the cutout land on the painted line anywhere? A mask that cuts no gap is pure damage. */
function cutsTheRoute(cutout: Box, route: Point[], strokeHalf: number): boolean {
  return route.slice(1).some(([bx, by], index) => {
    const [ax, ay] = route[index]!;

    return (
      Math.min(ax, bx) - strokeHalf < cutout.x + cutout.width &&
      Math.max(ax, bx) + strokeHalf > cutout.x &&
      Math.min(ay, by) - strokeHalf < cutout.y + cutout.height &&
      Math.max(ay, by) + strokeHalf > cutout.y
    );
  });
}

/**
 * The boxes the label gap must leave intact. A marker sits on a route endpoint with its own
 * `(refX, refY)` pinned to that point, so under any rotation it reaches as far as the farthest
 * corner of its box. Markers paint through the path's own mask, so without these the cutout slices
 * the arrowhead in half wherever a label lands beside an endpoint.
 */
function markerGuards(
  svg: SVGSVGElement,
  anchor: Element,
  route: Point[],
  strokeWidth: number,
): Box[] {
  const ends: [string, Point | undefined][] = [
    ['marker-start', route[0]],
    ['marker-end', route[route.length - 1]],
  ];

  return ends.flatMap(([attribute, point]) => {
    if (!point) {
      return [];
    }

    const reach = markerReach(svg, anchor.getAttribute(attribute), strokeWidth);

    return reach > 0
      ? [{ x: point[0] - reach, y: point[1] - reach, width: reach * 2, height: reach * 2 }]
      : [];
  });
}

/** Marker geometry is the template's to declare, so read it off the referenced `<marker>`. */
function markerReach(svg: SVGSVGElement, reference: string | null, strokeWidth: number): number {
  const id = /^url\(["']?#([^"')]+)["']?\)$/.exec(reference?.trim() ?? '')?.[1];

  if (!id) {
    return 0;
  }

  const marker = [...svg.querySelectorAll<SVGMarkerElement>('marker')].find(
    (candidate) => candidate.id === id,
  );

  if (!marker) {
    return 0;
  }

  const width = marker.markerWidth.baseVal.value;
  const height = marker.markerHeight.baseVal.value;
  const refX = marker.refX.baseVal.value;
  const refY = marker.refY.baseVal.value;
  // `strokeWidth` is the SVG default for markerUnits, and it scales the whole marker box.
  const scale =
    marker.markerUnits.baseVal === SVGMarkerElement.SVG_MARKERUNITS_USERSPACEONUSE
      ? 1
      : strokeWidth;

  return Math.hypot(Math.max(refX, width - refX), Math.max(refY, height - refY)) * scale;
}

function intersection(a: Box, b: Box): Box | undefined {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x;
  const height = Math.min(a.y + a.height, b.y + b.height) - y;

  return width > 0 && height > 0 ? { x, y, width, height } : undefined;
}

/**
 * Cut the label rectangle out of the rendered stroke without splitting or shortening its path.
 * Keeping one authoritative `d` preserves marker attachment and the dash phase on both sides of
 * the transparent gap. `guards` are re-added after the cut, already clipped to it.
 */
function installLabelGap(
  svg: SVGSVGElement,
  anchor: Element,
  id: string,
  connectionId: string,
  sceneBox: Box,
  cutoutBox: Box,
  guards: Box[],
  hasAuthoredMask: boolean,
  hasAuthoredClip: boolean,
): void {
  const defs =
    directDefsOf(svg) ?? svg.insertBefore(document.createElementNS(SVG_NS, 'defs'), svg.firstChild);

  if (hasAuthoredMask && !hasAuthoredClip) {
    installLabelClip(defs, anchor, id, connectionId, sceneBox, cutoutBox, guards);
    return;
  }

  const mask = document.createElementNS(SVG_NS, 'mask');
  mask.id = id;
  mask.setAttribute('data-mdp-connection-mask', connectionId);
  mask.setAttribute('maskUnits', 'userSpaceOnUse');
  mask.setAttribute('maskContentUnits', 'userSpaceOnUse');
  mask.setAttribute('x', String(sceneBox.x));
  mask.setAttribute('y', String(sceneBox.y));
  mask.setAttribute('width', String(sceneBox.width));
  mask.setAttribute('height', String(sceneBox.height));

  const field = document.createElementNS(SVG_NS, 'rect');
  field.setAttribute('x', String(sceneBox.x));
  field.setAttribute('y', String(sceneBox.y));
  field.setAttribute('width', String(sceneBox.width));
  field.setAttribute('height', String(sceneBox.height));
  field.setAttribute('fill', 'white');
  mask.appendChild(field);

  const cutout = document.createElementNS(SVG_NS, 'rect');
  cutout.setAttribute('data-mdp-label-cutout', '');
  cutout.setAttribute('x', String(cutoutBox.x));
  cutout.setAttribute('y', String(cutoutBox.y));
  cutout.setAttribute('width', String(cutoutBox.width));
  cutout.setAttribute('height', String(cutoutBox.height));
  cutout.setAttribute('fill', 'black');
  mask.appendChild(cutout);

  // A mask composites in document order, so painting the marker zones white again after the cutout
  // puts the arrowheads back without narrowing the gap anywhere else.
  for (const guard of guards) {
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('data-mdp-marker-guard', '');
    rect.setAttribute('x', String(guard.x));
    rect.setAttribute('y', String(guard.y));
    rect.setAttribute('width', String(guard.width));
    rect.setAttribute('height', String(guard.height));
    rect.setAttribute('fill', 'white');
    mask.appendChild(rect);
  }

  defs.appendChild(mask);

  if (hasAuthoredMask && hasAuthoredClip) {
    // Both independent paint-effect slots are already authored. Add the label mask on a minimal
    // generated parent so the anchor retains both references and their original target-relative
    // coordinate semantics. This structural fallback is deliberately limited to this case.
    const host = document.createElementNS(SVG_NS, 'g');
    host.setAttribute('data-mdp-label-gap-host', connectionId);
    host.setAttribute('mask', `url(#${id})`);
    anchor.parentNode?.insertBefore(host, anchor);
    host.appendChild(anchor);
    return;
  }

  anchor.setAttribute('mask', `url(#${id})`);
}

/**
 * SVG exposes one `mask` slot but applies clipping and masking as independent effects. When the
 * template already masks its anchor, use an inverse clip for the label gap: the authored mask
 * stays on the exact geometry it was written for, and no wrapper is inserted that could change
 * objectBoundingBox coordinates or direct-child CSS selectors.
 */
function installLabelClip(
  defs: SVGDefsElement,
  anchor: Element,
  id: string,
  connectionId: string,
  sceneBox: Box,
  cutoutBox: Box,
  guards: Box[],
): void {
  const clip = document.createElementNS(SVG_NS, 'clipPath');
  clip.id = id;
  clip.setAttribute('data-mdp-connection-clip', connectionId);
  clip.setAttribute('clipPathUnits', 'userSpaceOnUse');

  const rect = (box: Box): string =>
    `M${box.x} ${box.y}H${box.x + box.width}V${box.y + box.height}H${box.x}Z`;
  const shape = document.createElementNS(SVG_NS, 'path');
  shape.setAttribute('data-mdp-label-cutout', '');
  shape.setAttribute('fill-rule', 'evenodd');
  shape.setAttribute('clip-rule', 'evenodd');
  // Even-odd nesting does the same work as the mask's paint order: scene keeps, cutout removes,
  // and a guard nested inside the cutout keeps again. Guards arrive already clipped to the cutout,
  // so none of them can strand a region outside it at an even winding.
  shape.setAttribute('d', [sceneBox, cutoutBox, ...guards].map(rect).join(''));
  clip.appendChild(shape);
  defs.appendChild(clip);
  anchor.setAttribute('clip-path', `url(#${id})`);
}

function directDefsOf(svg: SVGSVGElement): SVGDefsElement | undefined {
  return [...svg.children].find(
    (child): child is SVGDefsElement => child instanceof SVGDefsElement,
  );
}

/** Avoid both sibling-connection collisions and a template-authored id with the same prefix. */
function uniqueResourceId(scene: HTMLElement, prefix: string, ordinal: number): string {
  let suffix = ordinal;
  let id = `${prefix}-${suffix}`;

  while (scene.ownerDocument.getElementById(id)) {
    suffix += 1;
    id = `${prefix}-${suffix}`;
  }

  return id;
}

/**
 * The layout scene box (layout union + padding) grown to contain all paint: node ink translated
 * to scene coordinates, and connection labels projected around their midpoint anchor (the
 * `translate(-50%, -100%)` pin above). Ink only ever extends the box — the layout padding is not
 * re-applied around it.
 */
function inkAwareSceneBox(layout: SceneLayout, measures?: ElementMeasure[]): Box {
  let left = layout.scene.x;
  let top = layout.scene.y;
  let right = layout.scene.x + layout.scene.width;
  let bottom = layout.scene.y + layout.scene.height;

  for (const measure of measures ?? []) {
    const box = layout.boxes[measure.id];

    if (box) {
      left = Math.min(left, box.x + measure.ink.x);
      top = Math.min(top, box.y + measure.ink.y);
      right = Math.max(right, box.x + measure.ink.x + measure.ink.width);
      bottom = Math.max(bottom, box.y + measure.ink.y + measure.ink.height);
      continue;
    }

    // Connections mount as full-scene overlays, so their flow-time ink is meaningless — only the
    // label paints outside the path.
    const connection = layout.connections[measure.id];
    const measured = connection && measure.roles['external-text']?.[0];

    if (!connection || !measured) {
      continue;
    }

    // A placed box already sits in scene coordinates; the midpoint fallback projects the measured
    // label around its anchor (the `translate(-50%, -100%)` pin above).
    const labelBox = connection.labelBox ?? {
      x: connection.label.x - measured.width / 2,
      y: connection.label.y - measured.height,
      width: measured.width,
      height: measured.height,
    };
    left = Math.min(left, labelBox.x);
    top = Math.min(top, labelBox.y);
    right = Math.max(right, labelBox.x + labelBox.width);
    bottom = Math.max(bottom, labelBox.y + labelBox.height);
  }

  return { x: left, y: top, width: right - left, height: bottom - top };
}
