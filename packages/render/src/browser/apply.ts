import type { Box, SceneLayout } from '@eraserlabs/render';
import type { MountedElement } from './mount.js';
import type { ElementMeasure } from './measure.js';
import { cutLabelGap, labelGapIdPrefix, uniqueResourceId } from './labelGap.js';

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
        cutLabelGap(svg, anchor, labelBox, {
          connectionId: element.id,
          field: sceneBox,
          id: () => uniqueResourceId(scene, labelGapIdPrefix(anchor), maskOrdinal++),
        });
      }
    }
  }
}



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
