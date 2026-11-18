import type { ResolvedElement, ResolvedEntity, Theme } from '@eraserlabs/protocol';
import { renderIdPrefix } from './domIds.js';
import { createFillEngine, type FillEngineInit, type FillFn } from './fill.js';
import { prepareWashMasters, type WashElement } from './masters.js';
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
  /** The exact markup and scoped CSS used by the page runner, also usable in serialized views. */
  registry: ReturnType<typeof templateRegistry>;
  /** Copy props and prepare watercolor definitions, without filling or mounting templates. */
  prepare<T extends WashElement>(
    elements: readonly T[],
    options?: { idPrefix?: string },
  ): Promise<{ elements: T[]; defs: string }>;
  /** Fill already-prepared props synchronously; useful for measurement and stored views. */
  fill(request: RunRequest): RenderedElement[];
  render(request: RunRequest, options?: { idPrefix?: string }): Promise<RenderedElements>;
} {
  const registry = templateRegistry(setup);
  const init: FillEngineInit = { templates: registry.templates, icons: {} };
  let engine: FillFn | undefined;

  async function prepare<T extends WashElement>(
    input: readonly T[],
    options: { idPrefix?: string } = {},
  ): Promise<{ elements: T[]; defs: string }> {
    const prefix = renderIdPrefix(options.idPrefix);
    const elements = input.map((element, index) => ({
      ...element,
      props: {
        ...element.props,
        ...(element.props?.['washTexCss'] || element.props?.['washTexGeo']
          ? { washUid: `${prefix}-${index}` }
          : {}),
      },
    }));
    const defs = await prepareWashMasters(setup.washMaster, elements, { idPrefix: prefix });
    return { elements, defs };
  }

  function fill(
    elements: readonly ResolvedElement[],
    icons: RunRequest['icons'],
    theme?: Theme,
  ): RenderedElement[] {
    // Filling is synchronous: each call sees only its own sidecar, even when preparation overlaps.
    init.icons = icons;
    engine ??= createFillEngine(init);
    return elements.map(({ id, tag, props, theme: elementTheme }) => ({
      id,
      tag,
      html: engine!(tag, props, elementTheme ?? theme),
    }));
  }

  return {
    css: registry.css,
    registry,
    prepare,
    fill(request) {
      return fill([...request.entities, ...request.connections], request.icons, request.theme);
    },
    async render(request, options = {}) {
      const { elements, defs } = await prepare(
        [...request.entities, ...request.connections],
        options,
      );
      return {
        defs,
        elements: fill(elements, request.icons, request.theme),
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
