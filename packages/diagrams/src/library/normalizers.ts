import { colorToHex, type ElementNormalizer } from '@eraserlabs/resolve';
import { washTextureProps } from './watercolorTexture.js';
import { roundedShapePath } from './roundedPolygon.js';
import { curvedShapePath } from './curvedShapePaths.js';
import { shapeOutline } from './shapeOutlines.js';

/**
 * Derived-prop table injected via `ResolverSetup.normalizers`. Pure derivations from authored
 * props — no measurement, no DOM. Props written here are `Optional` in the tag schemas so
 * authored input may carry them too. Template `--er-*` bindings of props this file may leave
 * absent must be gated (`[data-x]:not([data-x=''])`) — CSS `var()` fallbacks do not fire on
 * empty substitutions.
 */

const CONNECTION_STROKE_PX = 1.3;

const TEXT_ASPECT_BY_SHAPE: Record<string, number> = {
  rectangle: 0.8,
  star: 0.93,
  document: 1.2,
  diamond: 1.2,
};

function positivePx(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Icon captions bind `--f` per run. An absent run typeface would miss the element's, so copy
 * `element.typeface` onto runs that omit one. Shape has no element typeface — set `texts[].typeface`.
 */
function deriveTextRunTypeface(element: Record<string, unknown>): void {
  const runs = element.texts;

  if (!Array.isArray(runs) || element.typeface === undefined) {
    return;
  }

  for (const run of runs as Record<string, unknown>[]) {
    if (run !== null && typeof run === 'object' && run.typeface === undefined) {
      run.typeface = element.typeface;
    }
  }
}

function deriveShapeIconColor(element: Record<string, unknown>): void {
  if (typeof element.icon !== 'string') {
    return;
  }

  const iconProps =
    element.iconProps !== null && typeof element.iconProps === 'object'
      ? (element.iconProps as Record<string, unknown>)
      : undefined;
  const runs = Array.isArray(element.texts) ? element.texts : [];
  const primary = runs[0] as Record<string, unknown> | undefined;

  element.iconColor = iconProps?.color ?? primary?.color ?? '#242424';
}

// Watercolor texture recolors a grayscale master via an SVG luminance LUT. LUT stops are
// concrete `#rrggbb` attribute values, so relative-color CSS cannot reach them — pigment must
// be resolved here before the browser prephase (render masters.ts).

const PASTEL_LIGHTNESS = 0.85;

const HEX6 = /^#([0-9a-f]{6})$/i;

function parseHex(value: unknown): [number, number, number] | null {
  const hex = typeof value === 'string' ? HEX6.exec(value) : null;

  if (!hex) {
    return null;
  }

  const n = Number.parseInt(hex[1]!, 16);

  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** Keep hue and saturation; force lightness — same semantics as `hsl(from value h s L)`. */
function atLightness(value: string, lightness: number): string | null {
  const rgb = parseHex(value);

  if (!rgb) {
    return null;
  }

  const [r, g, b] = rgb.map((c) => c / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const mid = (max + min) / 2;
  let hue = 0;
  let saturation = 0;

  if (delta !== 0) {
    saturation = delta / (1 - Math.abs(2 * mid - 1));

    if (max === r) {
      hue = 60 * (((g - b) / delta) % 6);
    } else if (max === g) {
      hue = 60 * ((b - r) / delta + 2);
    } else {
      hue = 60 * ((r - g) / delta + 4);
    }
  }

  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lightness - c / 2;
  const sector = Math.floor(((hue + 360) % 360) / 60);
  const channels: [number, number, number][] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ];
  const [r1, g1, b1] = channels[sector] ?? [0, 0, 0];
  const hex = (v: number): string =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0');

  return `#${hex(r1)}${hex(g1)}${hex(b1)}`;
}

/** Spill past the shape box so the wash bleed can paint over the border. */
const WASH_SPILL = 14;

const CSS_GEOMETRY_KINDS = new Set(['rectangle', 'oval', 'circle', 'ellipse']);

const UNPAINTED = new Set(['transparent', 'none']);

function hasBody(element: Record<string, unknown>): boolean {
  const bg = element.bgColor;

  if (typeof bg === 'string') {
    return !UNPAINTED.has(bg.toLowerCase());
  }

  return typeof element.color === 'string' && !UNPAINTED.has(element.color.toLowerCase());
}

/** White cannot tint the grayscale master; wash it as barely-there gray instead of nothing. */
const WHITE_WASH_PIGMENT = '#ececec';

/**
 * Any validated CSS color the LUT can be tinted with, canonicalized to `#rrggbb` by resolve's
 * own grammar (`colorToHex`, colocated with validation so the two cannot drift). Null for
 * everything else — `transparent`, `hsl()` and future functions stay untextured.
 */
function pigmentHex(value: unknown): string | null {
  return typeof value === 'string' ? colorToHex(value) : null;
}

function bodyPigment(element: Record<string, unknown>): string | null {
  const pigment =
    typeof element.bgColor === 'string'
      ? pigmentHex(element.bgColor)
      : typeof element.color === 'string'
        ? atLightness(pigmentHex(element.color) ?? element.color, PASTEL_LIGHTNESS)
        : null;

  return pigment === '#ffffff' ? WHITE_WASH_PIGMENT : pigment;
}

function washShadeSource(element: Record<string, unknown>): string | undefined {
  return pigmentHex(element.borderColor) ?? pigmentHex(element.color) ?? undefined;
}

/** Box bodies (Group/Lane/Pool, DatabaseTable) use the shared CSS-mask wash texture. */
function deriveBoxWash(element: Record<string, unknown>): void {
  if (element.styleMode !== 'watercolor' || !hasBody(element)) {
    return;
  }

  const pigment = bodyPigment(element);
  const texture =
    pigment === null
      ? null
      : washTextureProps(pigment, washShadeSource(element), String(element.id ?? ''));

  if (texture !== null) {
    Object.assign(element, texture);
    element.washTexCss = true;
  }
}

/**
 * Texture mode (hex pigment + CSS/dynamic-svg geometry): body fill is the recolored master.
 * Anything the texture cannot serve — white/non-hex pigment, no usable geometry — gets no wash
 * decoration at all: the faded body fill alone is the watercolor treatment.
 */
function deriveWatercolor(element: Record<string, unknown>): void {
  if (element.styleMode !== 'watercolor' || !hasBody(element)) {
    return;
  }

  const pigment = bodyPigment(element);
  const kind = String(element.shape ?? 'rectangle');
  const isCssKind = CSS_GEOMETRY_KINDS.has(kind);
  const hasDynamicGeo = typeof element.geoPath === 'string' && element.geoPath !== '';
  const texture =
    pigment === null || !(isCssKind || hasDynamicGeo)
      ? null
      : washTextureProps(pigment, washShadeSource(element), String(element.id ?? ''));

  if (texture === null) {
    return;
  }

  Object.assign(element, texture);

  if (isCssKind) {
    element.washTexCss = true;
  } else {
    element.washTexGeo = true;
    element.washUseW = (element.geoW as number) + WASH_SPILL * 2;
    element.washUseH = (element.geoH as number) + WASH_SPILL * 2;
  }
}

function deriveLineWidth(element: Record<string, unknown>): void {
  element.lineWidthPx =
    typeof element.lineWidth === 'number' && Number.isFinite(element.lineWidth)
      ? Math.round(element.lineWidth * 1.75 * 100) / 100
      : CONNECTION_STROKE_PX;
}

const normalizeShape: ElementNormalizer = (element) => {
  element.vMargin =
    typeof element.vMargin === 'number' && Number.isFinite(element.vMargin)
      ? Math.max(0, element.vMargin)
      : 10;
  element.textAspectRatio = TEXT_ASPECT_BY_SHAPE[String(element.shape)] ?? 1;
  // Geo before watercolor: texture mode clips the master to the dynamic geometry path.
  deriveGeo(element);
  deriveWatercolor(element);
  deriveOutline(element);
  deriveShapeIconColor(element);
};

/**
 * Polygon kinds: rounded-corner path at real size (radii are absolute px). Document/cylinder:
 * curves scaled to real size. Auto-sized and CSS-geometry kinds keep static template geometry.
 */
function deriveGeo(element: Record<string, unknown>): void {
  const { width, height } = element;

  if (typeof width === 'number' && width > 0 && typeof height === 'number' && height > 0) {
    const kind = String(element.shape);
    const path = roundedShapePath(kind, width, height);

    if (path !== null) {
      element.geoPath = path;
      element.geoW = width;
      element.geoH = height;

      return;
    }

    const curved = curvedShapePath(kind, width, height);

    if (curved !== null) {
      element.geoPath = curved.body;
      element.geoW = width;
      element.geoH = height;

      if (curved.washFloor !== undefined) {
        element.geoWashFloorPath = curved.washFloor;
      }

      if (curved.cap !== undefined) {
        element.geoCapPath = curved.cap;
      }

      return;
    }
  }

  element.staticGeo = true;
}

/** True-boundary outline for kinds whose drawn edge is not the bounding box (router endpoints). */
function deriveOutline(element: Record<string, unknown>): void {
  const outline = shapeOutline(String(element.shape));

  if (outline) {
    element.outline = outline;
  }
}

const normalizeIcon: ElementNormalizer = (element) => {
  // Bounds outrank the `size` token via `[data-sized]` in Icon.style.css.
  const bounds = positivePx(element.width) ?? positivePx(element.height);

  if (bounds !== undefined) {
    element.sizePx = bounds;
  }

  element.color ??= '#242424';
  deriveTextRunTypeface(element);
};

/** BPMN nodes share Icon's run model: an element-level typeface copies onto runs that omit one. */
const normalizeBpmnNode: ElementNormalizer = (element) => {
  deriveTextRunTypeface(element);
};

const normalizeTextbox: ElementNormalizer = (element) => {
  // Render supplies a preferred width even when none is authored.
  element.wrapMode = 'wrap';
  element.color ??= '#242424';
};

const normalizeGroupLike: ElementNormalizer = (element) => {
  deriveBoxWash(element);
};

const normalizeDatabaseTable: ElementNormalizer = (element) => {
  deriveBoxWash(element);
};

const normalizeDivider: ElementNormalizer = (element) => {
  element.color ??= '#1c1c1c';
  deriveLineWidth(element);
};

const REL_TYPE_ARROWHEADS: Record<string, [string, string]> = {
  'one-to-one': ['crowFootSingle', 'crowFootSingle'],
  'one-to-many': ['crowFootSingle', 'crowFootMany'],
  'many-to-one': ['crowFootMany', 'crowFootSingle'],
  'many-to-many': ['crowFootMany', 'crowFootMany'],
};

function normalizeConnectionShared(element: Record<string, unknown>): void {
  element.color ??= '#1c1c1c';
  deriveLineWidth(element);
}

const normalizeRelationship: ElementNormalizer = (element) => {
  normalizeConnectionShared(element);
};

const normalizeDatabaseRelationship: ElementNormalizer = (element) => {
  normalizeConnectionShared(element);

  if (typeof element.relType === 'string') {
    const pair = REL_TYPE_ARROWHEADS[element.relType];

    if (pair !== undefined) {
      element.startArrowhead ??= pair[0];
      element.endArrowhead ??= pair[1];
    }
  }
};

export const stockNormalizers: Record<string, ElementNormalizer> = {
  Shape: normalizeShape,
  Icon: normalizeIcon,
  Activity: normalizeBpmnNode,
  Event: normalizeBpmnNode,
  Gateway: normalizeBpmnNode,
  Textbox: normalizeTextbox,
  Group: normalizeGroupLike,
  Lane: normalizeGroupLike,
  Pool: normalizeGroupLike,
  DatabaseTable: normalizeDatabaseTable,
  Divider: normalizeDivider,
  Relationship: normalizeRelationship,
  DatabaseRelationship: normalizeDatabaseRelationship,
};
