import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import type { ElementKind } from '@eraserlabs/protocol/schema';

/**
 * Hand-written minimal templates — deliberately not the Eraser stock library. The suite drives the
 * pipeline through nothing but the dialect contract (data-if/each/use/slot, {{path}}, data-role /
 * data-part), which is the proof that render stays generic mechanism. Every sized box is fixed px
 * in CSS so measurements are deterministic without staging fonts.
 */

export interface MeasuredBox {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

export interface LayoutBox extends MeasuredBox {
  x: number;
  y: number;
}

export interface ElementMeasure {
  id: string;
  tag: string;
  intrinsic: MeasuredBox;
  body: MeasuredBox | null;
  ink: MeasuredBox;
  roles: Record<string, MeasuredBox[]>;
  parts: Record<string, MeasuredBox[]>;
  content?: MeasuredBox;
}

export interface SceneLayout {
  boxes: Record<string, LayoutBox>;
  connections: Record<
    string,
    {
      d: string;
      points: [number, number][];
      label: { x: number; y: number };
      labelBox?: LayoutBox;
    }
  >;
  scene: LayoutBox;
}

export interface RunResult {
  measures: ElementMeasure[];
  layout: SceneLayout;
}

export interface SceneElement {
  tag: string;
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  containerId?: string | null;
  props: Record<string, unknown>;
}

export interface WireFontFace {
  family: string;
  bytes64: string;
  weight?: string;
  style?: string;
}

declare global {
  interface Window {
    __eraser: {
      setup(config: {
        templates: Record<string, { html: string; css: string }>;
        baseCss: string;
      }): void;
      registerFonts(request: { css: string; faces: WireFontFace[] }): Promise<void>;
      run(request: {
        entities: SceneElement[];
        connections: SceneElement[];
        icons: Record<string, string>;
      }): Promise<RunResult>;
      serialize(): { scene: string; css: string };
    };
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));

export const IIFE_PATH = join(HERE, '..', '..', 'dist', 'browser', 'eraser-render.iife.js');

export const BASE_CSS = '#eraser-scene{background:rgb(250,250,250)}';

/**
 * `kind` is harness bookkeeping, not page configuration: the page registry takes markup and CSS
 * alone, and this table stands in for the resolver's `x-schema-kind` classification when splitting
 * a scene into the two lists `run` expects.
 */
export const TEMPLATES: Record<string, { html: string; css: string; kind?: ElementKind }> = {
  // The dialect sampler: attribute + text substitution, conditional subtrees, loops, composition,
  // icon slot. Intrinsic size is exactly 110×30 (100×20 label block + 5px padding).
  Card: {
    kind: 'entity',
    html: `<template name="Card">
<div class="card" data-tpl="Card" data-role="body" data-kind="{{kind}}">
<span class="card-label" data-part="label">{{label}}</span>
<ul class="card-items" data-if="items" data-each="it of items"><li>{{it.text}}</li></ul>
<span class="card-chip" data-if="chip" data-use="Chip" data-props="chip"></span>
<span class="card-icon" data-if="icon" data-slot="icon"></span>
</div>
</template>`,
    // The bare `i` rule targets Chip's root; @scope must stop it at the data-use host.
    css: `.card{display:block;padding:5px}
.card-label{display:block;width:100px;height:20px;overflow:hidden;color:rgb(200,0,0)}
.card-items{margin:0;padding:0;list-style:none}
i{color:rgb(200,0,0)}`,
  },
  Chip: {
    html: '<template name="Chip"><i class="chip" data-tpl="Chip">{{text}}</i></template>',
    css: '.chip{display:inline-block;width:30px;height:10px;overflow:hidden;font-style:normal;color:rgb(0,100,0)}',
  },
  // Author-sized block with an overflowing badge: the ink probe. Badge box is (-30,-30,20,20)
  // wrapper-relative — past the 16px layout padding — and its box-shadow halo is blur 2 + spread
  // 3 = 5px on every side; the inset shadow on the box paints inside the border box and must
  // never extend ink.
  Box: {
    kind: 'entity',
    html: `<template name="Box">
<div class="box" data-tpl="Box" data-role="body">
<span class="box-badge" data-if="badge" data-part="badge">{{badge}}</span>
</div>
</template>`,
    css: `.box{width:100%;height:100%;position:relative;background:rgb(230,230,230);box-shadow:inset 0 0 20px 20px rgb(50,50,50)}
.box-badge{position:absolute;left:-30px;top:-30px;width:20px;height:20px;overflow:hidden;box-shadow:0 0 2px 3px rgb(0,0,0)}`,
  },
  // Connection: svg path anchor filled by apply, external label pinned to the path midpoint.
  // The label is a fixed 80×10 box so its scene projection is font-independent.
  Wire: {
    kind: 'connection',
    html: `<template name="Wire">
<svg class="wire" data-tpl="Wire"><path data-role="anchor" fill="none" stroke="rgb(0,0,0)" d="{{ }}"/></svg>
<span class="wire-label" data-role="external-text">{{label}}</span>
</template>`,
    css: `.wire{display:block}
.wire-label{display:inline-block;width:80px;height:10px;overflow:hidden}`,
  },
  TextPolicy: {
    kind: 'entity',
    html: `<template name="TextPolicy">
<div class="policy" data-tpl="TextPolicy" data-role="body">
<span class="policy-text" data-role="internal-text" data-text-grow-policy="{{policy}}" data-text-max-lines="3" data-text-aspect="0.8">{{label}}</span>
</div>
</template>`,
    css: `.policy{display:block;width:100%;height:100%;box-sizing:border-box}
.policy-text{display:block;min-width:0;white-space:normal;overflow-wrap:anywhere;line-height:16px}`,
  },
  PolicyWire: {
    kind: 'connection',
    html: `<template name="PolicyWire">
<div class="policy-wire" data-tpl="PolicyWire" data-role="body">
<svg class="policy-wire-svg"><path data-role="anchor" d="{{ }}"/></svg>
<span class="policy-wire-label" data-role="external-text" data-text-grow-policy="balanced">{{label}}</span>
</div>
</template>`,
    css: `.policy-wire{display:block}
.policy-wire-svg{display:block}
.policy-wire-label{display:inline-block;white-space:normal;overflow-wrap:anywhere;line-height:16px}`,
  },
  // Connection paint probe: the mask must leave this one path (and therefore its marker
  // attachment and dash phase) intact. The authored mask id deliberately collides with apply's
  // preferred first id so uniqueness is exercised against template content as well as siblings.
  MaskedWire: {
    kind: 'connection',
    html: `<template name="MaskedWire">
<div class="masked-wire" data-tpl="MaskedWire" data-role="body">
<svg class="masked-wire__svg"><defs>
<mask id="eraser-connection-label-mask-0"><rect width="1" height="1" fill="white"/></mask>
<marker id="test-arrow" markerUnits="userSpaceOnUse" markerWidth="6" markerHeight="6" refX="6" refY="3" orient="auto"><path d="M0 0L6 3L0 6Z" fill="context-stroke"/></marker>
</defs><path data-role="anchor" fill="none" stroke="rgb(0,0,0)" stroke-dasharray="8 4" stroke-dashoffset="3" marker-start="url(#test-arrow)" marker-end="url(#test-arrow)" d="{{ }}"/></svg>
<span class="masked-wire__label" data-role="external-text">{{label}}</span>
</div>
</template>`,
    css: `.masked-wire{display:block;--label-ink:rgb(10,20,30)}
.masked-wire__svg{display:block}
.masked-wire__label{display:inline-block;width:80px;height:10px;overflow:hidden;color:var(--label-ink);background:transparent}`,
  },
  // Composition probe: its authored mask removes x=50..70 while the generated inverse clip cuts
  // the independently placed label box. The authored id collides with apply's preferred clip id.
  AuthoredMaskedWire: {
    kind: 'connection',
    html: `<template name="AuthoredMaskedWire">
<div class="authored-masked-wire" data-tpl="AuthoredMaskedWire" data-role="body">
<svg class="authored-masked-wire__svg"><defs>
<mask id="eraser-connection-label-clip-0" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="-1000" y="-1000" width="2000" height="2000"><rect x="-1000" y="-1000" width="2000" height="2000" fill="white"/><rect data-authored-mask-cutout="" x="50" y="-1000" width="20" height="2000" fill="black"/></mask>
</defs><path data-role="anchor" fill="none" stroke="rgb(0,0,0)" mask="url(#eraser-connection-label-clip-0)" d="{{ }}"/></svg>
<span class="authored-masked-wire__label" data-role="external-text">{{label}}</span>
</div>
</template>`,
    css: `.authored-masked-wire{display:block}
.authored-masked-wire__svg{display:block}
.authored-masked-wire__label{display:inline-block;width:80px;height:10px;overflow:hidden;background:transparent}`,
  },
  AuthoredMaskAndClipWire: {
    kind: 'connection',
    html: `<template name="AuthoredMaskAndClipWire">
<div class="authored-mask-clip-wire" data-tpl="AuthoredMaskAndClipWire" data-role="body">
<svg class="authored-mask-clip-wire__svg"><defs>
<mask id="authored-wire-mask" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="-1000" y="-1000" width="2000" height="2000"><rect x="-1000" y="-1000" width="2000" height="2000" fill="white"/></mask>
<clipPath id="authored-wire-clip" clipPathUnits="userSpaceOnUse"><rect x="-1000" y="-1000" width="2000" height="2000"/></clipPath>
</defs><path data-role="anchor" fill="none" stroke="rgb(0,0,0)" mask="url(#authored-wire-mask)" clip-path="url(#authored-wire-clip)" d="{{ }}"/></svg>
<span class="authored-mask-clip-wire__label" data-role="external-text">{{label}}</span>
</div>
</template>`,
    css: `.authored-mask-clip-wire{display:block}
.authored-mask-clip-wire__svg{display:block}
.authored-mask-clip-wire__label{display:inline-block;width:80px;height:10px;overflow:hidden;background:transparent}`,
  },
  // Lookup hardening: prototype-chain names and missing paths must substitute to empty.
  Probe: {
    kind: 'entity',
    html: `<template name="Probe">
<div class="probe" data-tpl="Probe" data-role="body">
<span class="probe-proto">{{constructor.name}}</span>
<span class="probe-missing">{{missing.deep}}</span>
</div>
</template>`,
    css: '',
  },
};

/** Load the IIFE and open a standards-mode page (about:blank is quirks mode). */
export async function openScene(page: Page): Promise<void> {
  await page.addInitScript({ path: IIFE_PATH });
  await page.goto('data:text/html,<!doctype html><html><head></head><body></body></html>');
}

export async function setupScene(page: Page): Promise<void> {
  await openScene(page);
  await page.evaluate((setup) => window.__eraser.setup(setup), {
    templates: Object.fromEntries(
      Object.entries(TEMPLATES).map(([name, { html, css }]) => [name, { html, css }]),
    ),
    baseCss: BASE_CSS,
  });
}

/** Split an authored scene the way the resolver does, from the tag table's declared kind. */
export function splitScene(elements: SceneElement[]): {
  entities: SceneElement[];
  connections: SceneElement[];
} {
  const entities: SceneElement[] = [];
  const connections: SceneElement[] = [];

  for (const element of elements) {
    (TEMPLATES[element.tag]?.kind === 'connection' ? connections : entities).push(element);
  }

  return { entities, connections };
}

export async function runScene(
  page: Page,
  elements: SceneElement[],
  icons: Record<string, string> = {},
): Promise<RunResult> {
  await setupScene(page);

  return page.evaluate((request) => window.__eraser.run(request), {
    ...splitScene(elements),
    icons,
  });
}

export function measureOf(result: RunResult, id: string): ElementMeasure {
  const measure = result.measures.find((m) => m.id === id);

  if (!measure) {
    throw new Error(`no measure for "${id}"`);
  }

  return measure;
}
