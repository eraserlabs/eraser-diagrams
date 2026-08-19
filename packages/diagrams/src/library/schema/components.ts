import { CssColor, PaletteColor, type JsonSchema } from '@eraserlabs/resolve/schema';
import { FontSizePx } from './text.js';
import {
  STYLE_MODES,
  TYPEFACES,
  BORDER_STYLES,
  H_ALIGNS,
  ICON_SIZE_PRESETS,
  GROUP_TITLE_WIDTHS,
  CORNER_STYLES,
} from './enums.js';

/** Composite prop fragments shared across stock per-tag schemas. */

export const CornerRadius: JsonSchema = {
  anyOf: [
    { const: 'round', type: 'string' },
    { const: 'sharp', type: 'string' },
    {
      type: 'array',
      items: [{ type: 'number' }, { type: 'number' }, { type: 'number' }, { type: 'number' }],
      additionalItems: false,
      minItems: 4,
      maxItems: 4,
    },
  ],
};

/**
 * Identity/stroke trio. `color` is the identity; body/hairline/tint formulas derive from it in
 * CSS. `bgColor` / `borderColor` are raw paint that outrank those formulas.
 */
export const ShapeStyleProps: Record<string, JsonSchema> = {
  color: PaletteColor,
  bgColor: CssColor,
  borderColor: CssColor,
  styleMode: { type: 'string', enum: [...STYLE_MODES], default: 'shadow' },
  cornerRadius: CornerRadius,
  borderStyle: { type: 'string', enum: [...BORDER_STYLES] },
  borderWidth: { type: 'number' },
};

/**
 * Watercolor texture stain (CSS-mask flavor). Derived by normalizers: washTexCss + pigment pair
 * for the browser prephase. `washSym` is stamped at render time, not resolve.
 */
export const WashTexProps: Record<string, JsonSchema> = {
  washTexCss: { type: 'boolean' },
  washUid: { type: 'string', pattern: '^[A-Za-z0-9_-]+$' },
  washShade: { type: 'string', pattern: '^#[0-9a-f]{6}$' },
  washMid: { type: 'string', pattern: '^#[0-9a-f]{6}$' },
  /** Stamped by the browser prephase: shared tinted-master symbol id. */
  washSym: { type: 'string', pattern: '^[A-Za-z0-9_-]+$' },
};

import { Badge as BadgeProperties } from '../templates/Badge/Badge.schema.js';

export { BadgeProperties };

/** Per-icon overrides. Size token is paint-only — host CSS maps it to a px bucket. */
export const IconProps: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    color: CssColor,
    size: { type: 'string', enum: [...ICON_SIZE_PRESETS] },
  },
};

export const TitleIconProps: JsonSchema = IconProps;

export const GroupTitle: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', 'x-content': 'inline-markdown' },
    icon: { type: 'string', 'x-icon-name': true },
    iconProps: TitleIconProps,
    width: { type: 'string', enum: [...GROUP_TITLE_WIDTHS], default: 'snug' },
    bgColor: CssColor,
    border: { type: 'boolean', default: true },
    color: CssColor,
    fontSize: FontSizePx,
    hAlign: { type: 'string', enum: [...H_ALIGNS] },
    typeface: { type: 'string', enum: [...TYPEFACES] },
  },
};

/**
 * Lane/Pool titles render as the vertical side band, where the full-height band is the stock
 * BPMN look — so their `width` defaults to `full`. Group keeps the snug chip via `GroupTitle`.
 */
export const GroupTitleBand: JsonSchema = {
  ...GroupTitle,
  properties: {
    ...(GroupTitle['properties'] as Record<string, JsonSchema>),
    width: { type: 'string', enum: [...GROUP_TITLE_WIDTHS], default: 'full' },
  },
};

/**
 * Persisted label geometry: top-left relative to the element origin, optional measured box.
 * Presence of `lineOffset` is the manual-pin sentinel for layout.
 */
export const LabelPlacement: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['x', 'y'],
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    width: { type: 'number' },
    height: { type: 'number' },
    lineOffset: { type: 'number' },
  },
};

/** Authored point; coordinates may lie outside the diagram bounds. */
export const Point: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['x', 'y'],
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
  },
};

export const ConnectionBase: Record<string, JsonSchema> = {
  points: { type: 'array', items: Point, minItems: 2 },
  typeface: { type: 'string', enum: [...TYPEFACES] },
  fontSize: FontSizePx,
  label: { type: 'string', 'x-content': 'inline-markdown' },
  labelPlacement: LabelPlacement,
  lineStyle: { type: 'string', enum: [...BORDER_STYLES] },
  /** Paint-only corner treatment for the route stage. Absent is `'straight'`. */
  cornerStyle: { type: 'string', enum: [...CORNER_STYLES] },
  lineWidth: { type: 'number' },
  color: PaletteColor,
  badge: BadgeProperties,
  /** Derived: rendered stroke px from authored `lineWidth`. */
  lineWidthPx: { type: 'number' },
};
