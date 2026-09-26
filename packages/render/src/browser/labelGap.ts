import type { Box } from '@eraserlabs/render';

/**
 * The label gap: a connection's label is transparent, so the stroke under it is cut out of the line
 * with an SVG mask (or an inverse clip when the template already masks its anchor), never by
 * splitting the path — one `d` keeps marker attachment and the dash phase on both sides of the gap.
 *
 * `applyLayout` cuts it once per render. An editor that moves lines itself (the DOM canvas) calls
 * `cutLabelGap` after every path or label change: it first removes the gap it cut last time for the
 * same connection, so it can be called again and again on the same anchor.
 */
const SVG_NS = 'http://www.w3.org/2000/svg';
// Midpoint fallback labels end exactly on their path. Two user-space pixels carry the cut past
// that boundary, removing the full anti-aliased edge of the stock strokes (up to 4px centered)
// instead of leaving a half-stroke beneath a transparent label.
const LABEL_MASK_CLEARANCE = 2;

export interface LabelGapOptions {
  /** The connection's identity, stored as metadata but never used as an SVG id or CSS selector. */
  readonly connectionId: string;
  /** The user-space box the mask must cover: every point the stroke can paint (the scene box in `applyLayout`). */
  readonly field: Box;
}

interface InstalledGap {
  readonly svg: SVGSVGElement;
  readonly connectionId: string;
  readonly resource: SVGMaskElement | SVGClipPathElement;
  readonly attribute: 'mask' | 'clip-path';
  readonly previousValue: string | null;
  readonly host?: SVGGElement;
}

// Ownership follows the actual anchor, including while it is detached or its connection id changes.
const installedGaps = new WeakMap<Element, InstalledGap>();
const nextResourceOrdinal = new WeakMap<Document, number>();

/**
 * Cut the label's box (grown by LABEL_MASK_CLEARANCE) out of the anchor's stroke, in the anchor's
 * user space. Nothing is cut when the box does not touch the route (a label the router kept clear
 * of the line), and the arrowheads are kept whole. Returns whether a gap was cut.
 */
export function cutLabelGap(
  svg: SVGSVGElement,
  anchor: Element,
  labelBox: Box,
  options: LabelGapOptions,
): boolean {
  const previous = installedGaps.get(anchor);
  if (previous) {
    clearLabelGap(previous.svg, anchor, previous.connectionId);
  }
  const cutout = {
    x: labelBox.x - LABEL_MASK_CLEARANCE,
    y: labelBox.y - LABEL_MASK_CLEARANCE,
    width: labelBox.width + LABEL_MASK_CLEARANCE * 2,
    height: labelBox.height + LABEL_MASK_CLEARANCE * 2,
  };
  const route = routeVertices(anchor.getAttribute('d') ?? '');
  const strokeWidth = Number.parseFloat(getComputedStyle(anchor).strokeWidth) || 0;

  // A cutout that never lands on the line has no gap to cut — the router placed the label
  // clear of the route — but the mask would still clip this path's markers. Skip it.
  if (!cutsTheRoute(cutout, route, strokeWidth / 2)) {
    return false;
  }

  const hasAuthoredMask =
    anchor.hasAttribute('mask') && anchor.getAttribute('mask')?.trim() !== 'none';
  const hasAuthoredClip =
    anchor.hasAttribute('clip-path') && anchor.getAttribute('clip-path')?.trim() !== 'none';
  const prefix =
    hasAuthoredMask && !hasAuthoredClip
      ? 'eraser-connection-label-clip'
      : 'eraser-connection-label-mask';
  const id = uniqueResourceId(svg, prefix);
  installLabelGap(
    svg,
    anchor,
    id,
    options.connectionId,
    options.field,
    cutout,
    markerGuards(svg, anchor, route, strokeWidth)
      .map((guard) => intersection(guard, cutout))
      .filter((guard): guard is Box => guard !== undefined),
    hasAuthoredMask,
    hasAuthoredClip,
  );
  return true;
}

/**
 * Undo what `cutLabelGap` did for this connection: its mask or clip leaves the defs, the anchor's
 * reference to it goes, and a generated wrapper gives its anchor back. Anything the template
 * authored is left as it was.
 */
export function clearLabelGap(svg: SVGSVGElement, anchor: Element, connectionId: string): void {
  const gap = installedGaps.get(anchor);
  if (!gap || gap.svg !== svg || gap.connectionId !== connectionId) {
    return;
  }

  const target = gap.host ?? anchor;
  if (target.getAttribute(gap.attribute)?.trim() === `url(#${gap.resource.id})`) {
    if (gap.previousValue === null) {
      target.removeAttribute(gap.attribute);
    } else {
      target.setAttribute(gap.attribute, gap.previousValue);
    }
  }
  if (gap.host) {
    if (anchor.parentNode === gap.host) {
      gap.host.parentNode?.insertBefore(anchor, gap.host);
    }
    gap.host.remove();
  }
  gap.resource.remove();
  installedGaps.delete(anchor);
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

  // The animated values where the DOM has them; the attributes otherwise (a DOM without SVG
  // geometry, such as jsdom), with the SVG defaults: a 3 × 3 box at (0, 0), in stroke widths.
  const length = (
    name: 'markerWidth' | 'markerHeight' | 'refX' | 'refY',
    fallback: number,
  ): number =>
    marker[name]?.baseVal?.value ??
    (Number.parseFloat(marker.getAttribute(name) ?? '') || fallback);
  const width = length('markerWidth', 3);
  const height = length('markerHeight', 3);
  const refX = length('refX', 0);
  const refY = length('refY', 0);
  // `strokeWidth` is the SVG default for markerUnits, and it scales the whole marker box.
  const userSpace =
    marker.markerUnits?.baseVal !== undefined
      ? marker.markerUnits.baseVal === 1 // SVGMarkerElement.SVG_MARKERUNITS_USERSPACEONUSE
      : marker.getAttribute('markerUnits') === 'userSpaceOnUse';
  const scale = userSpace ? 1 : strokeWidth;

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
    const clip = installLabelClip(defs, id, connectionId, sceneBox, cutoutBox, guards);
    installedGaps.set(anchor, {
      svg,
      connectionId,
      resource: clip,
      attribute: 'clip-path',
      previousValue: anchor.getAttribute('clip-path'),
    });
    anchor.setAttribute('clip-path', `url(#${id})`);
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
    installedGaps.set(anchor, {
      svg,
      connectionId,
      resource: mask,
      attribute: 'mask',
      previousValue: null,
      host,
    });
    return;
  }

  installedGaps.set(anchor, {
    svg,
    connectionId,
    resource: mask,
    attribute: 'mask',
    previousValue: anchor.getAttribute('mask'),
  });
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
  id: string,
  connectionId: string,
  sceneBox: Box,
  cutoutBox: Box,
  guards: Box[],
): SVGClipPathElement {
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
  return clip;
}

function directDefsOf(svg: SVGSVGElement): SVGDefsElement | undefined {
  return [...svg.children].find(
    (child): child is SVGDefsElement => child.namespaceURI === SVG_NS && child.localName === 'defs',
  );
}

/** Reserve safe ids across SVGs, including resources created before their SVG is mounted. */
function uniqueResourceId(svg: SVGSVGElement, prefix: string): string {
  const document = svg.ownerDocument;
  const root = svg.getRootNode() as Document | DocumentFragment | Element;
  let ordinal = nextResourceOrdinal.get(document) ?? 0;
  let id: string;
  do {
    id = `${prefix}-${ordinal++}`;
  } while (
    document.getElementById(id) ||
    ('id' in root && root.id === id) ||
    root.querySelector(`[id="${id}"]`)
  );
  nextResourceOrdinal.set(document, ordinal);
  return id;
}
