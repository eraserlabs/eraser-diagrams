import type { ResolvedConnection, ResolvedElement, ResolvedEntity } from '@eraserlabs/protocol';
import type { SceneLayout } from '@eraserlabs/render';
import { externalTextOf, routeScene } from './route.js';
import { createFillEngine } from './fill.js';
import { injectStyles, mountScene } from './mount.js';
import {
  measureIntrinsics,
  measureScene,
  type ElementMeasure,
  type MeasuredBox,
} from './measure.js';
import { applyLayout } from './apply.js';
import { registerFonts, FONTS_STYLE_ID } from './fonts.js';
import { prepareWashMasters } from './masters.js';
import {
  constrainConnectionLabels,
  deferConstrainedConnectionLabels,
  resolveTextSizedElements,
} from './textSizing.js';

export type { WireFontFace, UrlFontFace, RegisterFontsRequest } from './fonts.js';
export type { ElementMeasure, MeasuredBox } from './measure.js';

/** Page-lifetime configuration: injected once per page by the orchestrator, reused per request. */
export interface PageSetup {
  /** Template name → template file HTML and its bare-selector CSS. */
  templates: Record<string, { html: string; css: string }>;
  /** Shared CSS applied before per-template rules (unscoped). */
  baseCss: string;
  /** Grayscale watercolor master (data URI) — tinted per pigment pair before fill (masters.ts). */
  washMaster?: string;
}

/**
 * The per-request payload. The lists arrive already split: kind is a per-tag fact the resolver
 * read off `x-schema-kind`, so nothing in the browser re-derives it.
 */
export interface RunRequest {
  entities: ResolvedEntity[];
  connections: ResolvedConnection[];
  /** Icon name → sanitized SVG sidecar. */
  icons: Record<string, string>;
}

export interface RunResult {
  /** Natural pass-1 boxes plus final policy-sized body/role/part/ink boxes. */
  measures: ElementMeasure[];
  layout: SceneLayout;
}

/** The scene as standalone markup: laid-out DOM plus the page stylesheet that styles it. */
export interface SerializedScene {
  /** `#eraser-scene` outerHTML after apply — positioned wrappers, filled templates, inline SVGs. */
  scene: string;
  /** The injected stylesheets (font role vars + base + scoped template CSS). */
  css: string;
}

let templatesHtml: Record<string, string> | undefined;
let washMaster: string | undefined;

function setup(config: PageSetup): void {
  templatesHtml = {};
  washMaster = config.washMaster;
  const scoped: string[] = [];

  for (const [name, template] of Object.entries(config.templates)) {
    templatesHtml[name] = template.html;

    if (template.css.trim() !== '') {
      scoped.push(scopeCss(name, template.css));
    }
  }

  injectStyles(config.baseCss + scoped.join(''));
}

/**
 * Confine a template's bare-selector CSS to its mount hosts. The scope root is the host element
 * (`[data-mdp-tag]`), never the styled template root itself, so bare selectors match the whole
 * template — root included. The `to` boundary stops matching at nested mount hosts, walling
 * data-use compositions off from the enclosing template's CSS. (A scope root matching the
 * boundary selector does not limit its own scope; the boundary hosts themselves are outside the
 * scope, so a template cannot style a nested mount host directly — wrap the host to position it.)
 */
function scopeCss(name: string, css: string): string {
  return `@scope([data-mdp-tag="${name}"]) to ([data-mdp-tag]){${css}}`;
}

/**
 * fill → max-content measure → resolve entity text policies → measure → provisional route →
 * constrain route-bound labels → final route → apply.
 */
async function run(request: RunRequest): Promise<RunResult> {
  if (!templatesHtml) {
    throw new Error('__eraser.run before __eraser.setup');
  }

  // Mount order is entities then connections. Connections paint into their own SVG and label
  // layers above every node, so the flat DOM order between the two groups is not paint order.
  const { entities, connections } = request;
  const all: ResolvedElement[] = [...entities, ...connections];

  // Tinted wash masters gate the fill the way fonts gate measurement: nothing mounts until
  // every distinct pigment pair has its recolored master registered and washSym stamped. The
  // returned defs block carries one <symbol> per pair; elements reference them via <use>.
  const washDefs = await prepareWashMasters(washMaster, all);
  const fill = createFillEngine({ templates: templatesHtml, icons: request.icons });
  const { scene, mounted } = mountScene(all, fill);

  if (washDefs !== '') {
    scene.insertAdjacentHTML('afterbegin', washDefs);
  }
  await document.fonts.ready;
  const intrinsics = measureIntrinsics(mounted);
  const resolvedSizes = resolveTextSizedElements(entities, mounted, intrinsics);
  let measures = measureScene(mounted, intrinsics);
  let finalExternalText = externalTextOf(measures);
  const provisional = deferConstrainedConnectionLabels(connections, mounted, finalExternalText);
  let layout = routeScene(entities, connections, resolvedSizes, provisional.externalText);

  if (provisional.deferred) {
    constrainConnectionLabels(connections, mounted, layout);
    measures = measureScene(mounted, intrinsics);
    finalExternalText = externalTextOf(measures);
    layout = routeScene(entities, connections, resolvedSizes, finalExternalText);
  }

  // A changed final route can change its longest run. Stabilize that cap without an unbounded
  // layout loop; in practice the provisional pass above usually makes the first result final.
  for (let pass = 0; pass < 2; pass += 1) {
    if (!constrainConnectionLabels(connections, mounted, layout)) {
      break;
    }

    measures = measureScene(mounted, intrinsics);
    finalExternalText = externalTextOf(measures);
    layout = routeScene(entities, connections, resolvedSizes, finalExternalText);
  }
  applyLayout(scene, mounted, layout, containmentZIndex(all), measures);
  attachContainerContent(all, measures, layout);

  return { measures, layout };
}

/**
 * Paint order from the flat containment relationship (the DOM never nests): each containment
 * level gets two layers — containers behind their members, nested containers above their parent.
 */
function containmentZIndex(elements: ResolvedElement[]): Map<string, number> {
  const byId = new Map(elements.map((element) => [element.id, element]));
  const nestedIds = new Set(
    elements
      .map((element) => element.containerId)
      .filter((id): id is string => typeof id === 'string'),
  );

  const depthOf = (element: ResolvedElement): number => {
    let depth = 0;
    let current = typeof element.containerId === 'string' ? element.containerId : undefined;

    // Cycles are rejected at resolve time; the size guard keeps a hostile payload from spinning.
    while (current !== undefined && depth <= elements.length) {
      depth += 1;
      const parent = byId.get(current)?.containerId;
      current = typeof parent === 'string' ? parent : undefined;
    }

    return depth;
  };

  return new Map(
    elements.map((element) => [
      element.id,
      depthOf(element) * 2 + (isPaintContainer(element, nestedIds) ? 0 : 1),
    ]),
  );
}

function isPaintContainer(element: ResolvedElement, nestedIds: ReadonlySet<string>): boolean {
  return (element as ResolvedEntity).isContainer === true || nestedIds.has(element.id);
}

/** Containers get `content`: the union of their members' final boxes, in scene coordinates. */
function attachContainerContent(
  elements: ResolvedElement[],
  measures: ElementMeasure[],
  layout: SceneLayout,
): void {
  const contentById = new Map<string, MeasuredBox>();

  for (const element of elements) {
    const box = layout.boxes[element.id];

    if (typeof element.containerId !== 'string' || !box) {
      continue;
    }

    const current = contentById.get(element.containerId);

    if (!current) {
      contentById.set(element.containerId, { ...box });
      continue;
    }

    const right = Math.max(current.x + current.width, box.x + box.width);
    const bottom = Math.max(current.y + current.height, box.y + box.height);
    current.x = Math.min(current.x, box.x);
    current.y = Math.min(current.y, box.y);
    current.width = right - current.x;
    current.height = bottom - current.y;
  }

  for (const measure of measures) {
    const content = contentById.get(measure.id);

    if (content) {
      measure.content = content;
    }
  }
}

/**
 * Serialize the scene the last `run` produced. The document shell is the caller's job. Both
 * stylesheets are this bundle's own: `#eraser-fonts` from `registerFonts`, `#eraser-styles` from
 * `setup` — a page that never registered fonts serializes with the styles alone.
 */
function serialize(): SerializedScene {
  const scene = document.getElementById('eraser-scene');

  if (!scene) {
    throw new Error('__eraser.serialize before __eraser.run');
  }

  const css = [FONTS_STYLE_ID, 'eraser-styles']
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join('');

  return { scene: scene.outerHTML, css };
}

const api = { setup, registerFonts, run, serialize };

export type EraserBrowserApi = typeof api;

declare global {
  interface Window {
    __eraser: EraserBrowserApi;
  }
}

window.__eraser = api;
