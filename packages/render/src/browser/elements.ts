import type { ResolvedEntity } from '@eraserlabs/protocol';
import { renderIdPrefix } from './domIds.js';
import { createFillEngine } from './fill.js';
import { prepareWashMasters } from './masters.js';
import { measureIntrinsics, measureScene, type ElementMeasure } from './measure.js';
import type { MountedElement } from './mount.js';
import { resolveTextSizedElements } from './textSizing.js';
import { templateRegistry } from './templates.js';
import type { PageSetup, RunRequest } from './types.js';

export type { PageSetup, RunRequest } from './types.js';
export type { ElementMeasure, MeasuredBox } from './measure.js';
export type { MountedElement } from './mount.js';
export { prepareWashMasters, type WashElement } from './masters.js';
export { applyLayout } from './apply.js';
export { measureText, type TextMeasure } from './textMeasure.js';

export interface RenderedElement {
  id: string;
  tag: string;
  /** Template markup. Mount inside a host carrying data-mdp-tag=tag. */
  html: string;
}

export interface RenderedElements {
  elements: RenderedElement[];
  /** Shared watercolor definitions. Keep with this fragment for as long as its elements are mounted. */
  defs: string;
}

/**
 * Prepare and fill any subset of resolved elements. No layout, reference lookup, global setup,
 * stylesheet injection or DOM mounting. Connections retain the template's anchor for the host
 * to apply its own geometry. Input props are never mutated, including watercolor preparation.
 */
export function createElementRenderer(setup: PageSetup): {
  css: string;
  render(request: RunRequest, options?: { idPrefix?: string }): Promise<RenderedElements>;
} {
  const registry = templateRegistry(setup);
  return {
    css: registry.css,
    async render(request, options = {}) {
      const prefix = renderIdPrefix(options.idPrefix);
      const elements = [...request.entities, ...request.connections].map((element, index) => ({
        ...element,
        props: {
          ...element.props,
          ...(element.props['washTexCss'] || element.props['washTexGeo']
            ? { washUid: `${prefix}-${index}` }
            : {}),
        },
      }));
      const defs = await prepareWashMasters(setup.washMaster, elements, { idPrefix: prefix });
      const fill = createFillEngine({ templates: registry.templates, icons: request.icons });
      return {
        defs,
        elements: elements.map(({ id, tag, props }) => ({ id, tag, html: fill(tag, props) })),
      };
    },
  };
}

/**
 * Measure mounted hosts after their fonts load, without routing or touching #eraser-scene.
 * With entities, run the same intrinsic/text sizing policy as run(); without them, measure the
 * current DOM as-is. Temporary wrapper sizing is restored even if measurement throws.
 * Descendant width probes also restore the original styles and priorities, including on errors.
 * Hosts must be connected, untransformed, and laid out (not display:none) in this document.
 */
export async function measureElements(
  mounted: MountedElement[],
  entities?: ResolvedEntity[],
): Promise<ElementMeasure[]> {
  for (const { wrapper } of mounted) {
    if (!wrapper.isConnected || wrapper.ownerDocument !== document) {
      throw new Error('measureElements requires hosts mounted in the current document');
    }
    // Start layout/font loads before reading FontFaceSet.ready.
    wrapper.getBoundingClientRect();
  }
  await document.fonts.ready;
  if (!entities) {
    return measureScene(mounted, measureIntrinsics(mounted));
  }
  const styles = mounted.map(({ wrapper }) => wrapper.getAttribute('style'));
  try {
    for (const { wrapper } of mounted) {
      wrapper.style.width = 'max-content';
      wrapper.style.height = '';
    }
    const intrinsics = measureIntrinsics(mounted);
    resolveTextSizedElements(entities, mounted);
    return measureScene(mounted, intrinsics);
  } finally {
    for (const [index, { wrapper }] of mounted.entries()) {
      const style = styles[index];
      if (style === null || style === undefined) {
        wrapper.removeAttribute('style');
      } else {
        wrapper.setAttribute('style', style);
      }
    }
  }
}
