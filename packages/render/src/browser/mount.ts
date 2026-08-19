import type { ResolvedElement } from '@eraserlabs/protocol';
import type { FillFn } from './fill.js';

export interface MountedElement {
  id: string;
  tag: string;
  wrapper: HTMLElement;
}

export interface MountedScene {
  scene: HTMLElement;
  mounted: MountedElement[];
}

const SCENE_ID = 'eraser-scene';

/**
 * Mount every element as a wrapper div holding its filled template markup. The wrapper carries
 * `data-mdp-tag` and is the template's CSS scope root (see setup's `@scope` wrapping) — the
 * styled template content always sits strictly below it. Wrappers are unstyled flow content at
 * this stage; positioning is the apply stage's job, after layout has run over the measured boxes.
 */
export function mountScene(elements: ResolvedElement[], fill: FillFn): MountedScene {
  document.getElementById(SCENE_ID)?.remove();
  const scene = document.createElement('div');
  scene.id = SCENE_ID;

  const mounted: MountedElement[] = elements.map((element) => {
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-mdp-id', element.id);
    wrapper.setAttribute('data-mdp-tag', element.tag);
    // Pass-1 sizing: a plain block div measures full-width, not intrinsic — max-content makes
    // the wrapper's rect the element's natural box. The size-resolution step overwrites this
    // with concrete px before the final measure pass.
    wrapper.style.width = 'max-content';
    wrapper.innerHTML = fill(element.tag, element.props);
    scene.appendChild(wrapper);

    return { id: element.id, tag: element.tag, wrapper };
  });

  document.body.appendChild(scene);

  return { scene, mounted };
}

/** Inject the page stylesheet (base CSS + per-template host-scoped blocks) once per page. */
export function injectStyles(css: string): void {
  const existing = document.getElementById('eraser-styles');

  if (existing) {
    existing.textContent = css;

    return;
  }

  const style = document.createElement('style');
  style.id = 'eraser-styles';
  style.textContent = css;
  document.head.appendChild(style);
}
