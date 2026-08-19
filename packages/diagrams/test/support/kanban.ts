import type { AuthoredLibrary, ElementNormalizer } from '@eraserlabs/resolve';
import type { JsonSchema } from '@eraserlabs/resolve/schema';

/**
 * A deliberately non-Eraser vocabulary, authored the way a third party would: plain JSON Schema
 * literals (no stock combinators), own tag names, own prop names, own normalizer table, own
 * markup/CSS. The suite drives the whole conductor through it — proof that resolve/render/layout
 * are generic mechanism and that measurement/layout ride on the dialect's `data-*` attributes
 * rather than on stock tag or prop names.
 *
 * These conventions are exercised on purpose:
 * - each dispatchable schema declares its entity/connection kind once through `x-schema-kind`;
 * - a container tag declares that once through `x-is-container`; entities may still author `isContainer`;
 * - every sized box below is fixed px in CSS, so measurements are exact without staging fonts.
 */

const PositionBase: Record<string, JsonSchema> = {
  id: { type: 'string', minLength: 1 },
  x: { type: 'number', minimum: 0 },
  y: { type: 'number', minimum: 0 },
  width: { type: 'number', minimum: 0 },
  height: { type: 'number', minimum: 0 },
  containerId: {
    anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
    'x-ref': 'element',
  },
};

const ConnectionPositionBase: Record<string, JsonSchema> = {
  id: PositionBase['id']!,
  x: PositionBase['x']!,
  y: PositionBase['y']!,
};

/** Sub-template contract: composed into Card via `data-use`, never dispatched to. */
const Pill: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: {
    text: { type: 'string', 'x-content': 'plain' },
    color: { type: 'string', 'x-css-color': true },
  },
};

const Card: JsonSchema = {
  type: 'object',
  'x-schema-kind': 'entity',
  additionalProperties: false,
  required: ['tag', 'id', 'x', 'y', 'title'],
  properties: {
    tag: { const: 'Card', type: 'string' },
    ...PositionBase,
    title: { type: 'string', 'x-content': 'plain' },
    /** Icon prop deliberately not named `icon` — `data-slot` names the prop, nothing else does. */
    glyph: { type: 'string', 'x-icon-name': true },
    priority: { type: 'string', enum: ['low', 'normal', 'high'] },
    checklist: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label'],
        properties: { label: { type: 'string', 'x-content': 'plain' } },
      },
    },
    pill: Pill,
    /** Derived by the kanban normalizers below, from `priority`. */
    accent: { type: 'string', 'x-css-color': true },
    stripePx: { type: 'number' },
  },
};

const Column: JsonSchema = {
  type: 'object',
  'x-schema-kind': 'entity',
  'x-is-container': true,
  additionalProperties: false,
  required: ['tag', 'id', 'x', 'y', 'heading'],
  properties: {
    tag: { const: 'Column', type: 'string' },
    ...PositionBase,
    heading: { type: 'string', 'x-content': 'plain' },
    tint: { type: 'string', 'x-css-color': true },
  },
};

const Flow: JsonSchema = {
  type: 'object',
  'x-schema-kind': 'connection',
  additionalProperties: false,
  required: ['tag', 'from', 'to'],
  properties: {
    tag: { const: 'Flow', type: 'string' },
    ...ConnectionPositionBase,
    from: { type: 'string', minLength: 1, 'x-ref': 'element' },
    to: { type: 'string', minLength: 1, 'x-ref': 'element' },
    points: {
      type: 'array',
      minItems: 2,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['x', 'y'],
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
        },
      },
    },
    caption: { type: 'string', 'x-content': 'plain' },
    stroke: { type: 'string', 'x-css-color': true },
  },
};

const ACCENT_BY_PRIORITY: Record<string, string> = {
  low: '#94a3b8',
  normal: '#3b82f6',
  high: '#ef4444',
};

export const kanbanNormalizers: Record<string, ElementNormalizer> = {
  Card(element) {
    const priority = typeof element['priority'] === 'string' ? element['priority'] : 'normal';

    element['accent'] = ACCENT_BY_PRIORITY[priority] ?? ACCENT_BY_PRIORITY['normal']!;
    element['stripePx'] = priority === 'high' ? 6 : 2;
  },
};

const CARD_HTML = `<template name="Card">
<article class="kb-card" data-tpl="Card" data-role="body" data-priority="{{priority}}" style="--er-accent: {{accent}}; --er-stripe: {{stripePx}}px">
<header class="kb-card__head" data-part="head">
<span class="kb-card__title" data-role="internal-text">{{title}}</span>
<span class="kb-card__glyph" data-slot="glyph" data-if="glyph"></span>
</header>
<ul class="kb-card__checks" data-each="c of checklist" data-key="label">
<li class="kb-card__check" data-part="check">{{c.label}}</li>
</ul>
<span data-use="Pill" data-props="pill" data-if="pill"></span>
</article>
</template>`;

const CARD_CSS = `.kb-card{box-sizing:border-box;display:block;width:160px;padding:8px;background:#ffffff;border-left:var(--er-stripe,2px) solid var(--er-accent,#94a3b8)}
.kb-card__head{display:block;height:24px;overflow:hidden}
.kb-card__title{display:inline-block;height:24px;overflow:hidden}
.kb-card__glyph{display:inline-block;width:16px;height:16px}
.kb-card__glyph svg{width:16px;height:16px}
.kb-card__checks{margin:0;padding:0;list-style:none}
.kb-card__check{display:block;height:12px;overflow:hidden}`;

const PILL_HTML = `<template name="Pill">
<em class="kb-pill" data-tpl="Pill" data-part="pill" style="--er-pill: {{color}}">{{text}}</em>
</template>`;

const PILL_CSS = `.kb-pill{display:block;width:40px;height:14px;overflow:hidden;font-style:normal;background:var(--er-pill,#e2e8f0)}`;

const COLUMN_HTML = `<template name="Column">
<section class="kb-col" data-tpl="Column" data-role="body" style="--er-tint: {{tint}}">
<h3 class="kb-col__heading" data-role="internal-text" data-part="heading">{{heading}}</h3>
</section>
</template>`;

const COLUMN_CSS = `.kb-col{box-sizing:border-box;display:block;width:240px;height:200px;background:var(--er-tint,#f1f5f9)}
.kb-col__heading{display:block;height:28px;margin:0;overflow:hidden}`;

const FLOW_HTML = `<template name="Flow">
<div class="kb-flow" data-tpl="Flow" data-role="body" style="--er-stroke: {{stroke}}">
<svg class="kb-flow__svg"><path class="kb-flow__line" data-role="anchor" d="{{ }}"></path></svg>
<span class="kb-flow__caption" data-role="external-text" data-part="caption" data-if="caption">{{caption}}</span>
</div>
</template>`;

const FLOW_CSS = `.kb-flow{display:block}
.kb-flow__svg{display:block;overflow:visible}
.kb-flow__line{fill:none;stroke:var(--er-stroke,#334155);stroke-width:2}
.kb-flow__caption{display:inline-block;width:64px;height:10px;overflow:hidden}`;

export const kanbanLibrary: AuthoredLibrary = {
  manifest: ['Column', 'Card', 'Flow', 'Pill'],
  schemas: { Column, Card, Flow },
  subTemplates: { Pill },
  baseCss: '#eraser-scene{background:#ffffff}',
  templates: [
    { name: 'Column', html: COLUMN_HTML, css: COLUMN_CSS },
    { name: 'Card', html: CARD_HTML, css: CARD_CSS },
    { name: 'Flow', html: FLOW_HTML, css: FLOW_CSS },
    { name: 'Pill', html: PILL_HTML, css: PILL_CSS },
  ],
};

/**
 * Card intrinsic height: 8px padding × 2 + 24px head + 12px per checklist row + 14px pill.
 * Width is fixed by CSS, so both axes are font-independent.
 */
export function cardHeight(options: { checks: number; pill?: boolean }): number {
  return 16 + 24 + options.checks * 12 + (options.pill ? 14 : 0);
}

export const CARD_WIDTH = 160;

/**
 * A scene in the custom vocabulary: containment, a sub-template, an icon, and a connection.
 * An `{ elements }` document, the only shape the engine takes — never a bare list.
 */
export const kanbanScene = {
  elements: [
    { tag: 'Column', id: 'todo', x: 0, y: 0, heading: 'To do', tint: '#eef2ff' },
    {
      tag: 'Card',
      id: 'card-a',
      x: 20,
      y: 40,
      containerId: 'todo',
      title: 'Swap <b>schema</b>',
      priority: 'high',
      glyph: 'lucide-server',
      checklist: [{ label: 'draft' }, { label: 'review' }],
      pill: { text: 'infra', color: '#fde68a' },
    },
    { tag: 'Card', id: 'card-b', x: 400, y: 60, title: 'Measure', checklist: [{ label: 'one' }] },
    { tag: 'Flow', id: 'flow-1', from: 'card-a', to: 'card-b', caption: 'then', stroke: '#334155' },
  ],
};
