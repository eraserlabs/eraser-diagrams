import { parseFragment, serialize, type DefaultTreeAdapterMap } from 'parse5';

const MAX_SVG_BYTES = 64 * 1024;
const SVG_NS = 'http://www.w3.org/2000/svg';

// Static drawing primitives only: no animation, foreign content, scripts, or images.
const TAGS = new Set([
  'svg',
  'g',
  'defs',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'title',
  'desc',
  'a',
  'use',
  'symbol',
  'clipPath',
  'mask',
  'pattern',
  'marker',
  'linearGradient',
  'radialGradient',
  'stop',
]);
const ATTRS = new Set([
  'id',
  'class',
  'role',
  'aria-label',
  'aria-hidden',
  'aria-labelledby',
  'aria-describedby',
  'data-name',
  'version',
  'viewBox',
  'preserveAspectRatio',
  'width',
  'height',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'd',
  'points',
  'transform',
  'gradientTransform',
  'gradientUnits',
  'spreadMethod',
  'offset',
  'fx',
  'fy',
  'fr',
  'clipPathUnits',
  'maskUnits',
  'maskContentUnits',
  'patternUnits',
  'patternContentUnits',
  'patternTransform',
  'markerWidth',
  'markerHeight',
  'markerUnits',
  'refX',
  'refY',
  'orient',
  'textLength',
  'lengthAdjust',
  'dx',
  'dy',
  'rotate',
]);
const PRESENTATION = new Set([
  'fill',
  'fill-rule',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-opacity',
  'opacity',
  'color',
  'stop-color',
  'stop-opacity',
  'clip-path',
  'clip-rule',
  'mask',
  'vector-effect',
  'paint-order',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-anchor',
  'dominant-baseline',
  'visibility',
  'display',
  'overflow',
  'shape-rendering',
  'color-interpolation',
]);
const FRAGMENT = /^#[A-Za-z_][\w.:-]*$/;

// A deliberately small CSS value language. Reject escapes/comments and all nonlocal URLs;
// the property allowlist prevents positioning, imports, animation, and custom properties.
function safePresentation(value: string): boolean {
  const withoutUrls = value.replace(/url\(\s*(['"]?)(#[A-Za-z_][\w.:-]*)\1\s*\)/gi, '');
  return (
    !/url\s*\(/i.test(withoutUrls) &&
    /^[\w\s#.,%()+\-]*$/.test(withoutUrls) &&
    !/(?:expression|var|env)\s*\(/i.test(withoutUrls)
  );
}

function safeStyle(value: string): boolean {
  return value.split(';').every((declaration) => {
    if (declaration.trim() === '') {
      return true;
    }
    const colon = declaration.indexOf(':');
    return (
      colon > 0 &&
      PRESENTATION.has(declaration.slice(0, colon).trim().toLowerCase()) &&
      safePresentation(declaration.slice(colon + 1).trim())
    );
  });
}

export interface SvgSanitizeResult {
  ok: boolean;
  svg?: string;
  reason?: string;
}

/** Validate using the same HTML parsing rules as the renderer's innerHTML sink. */
export function sanitizeSvg(raw: string): SvgSanitizeResult {
  const reject = (reason: string): SvgSanitizeResult => ({ ok: false, reason });
  if (new TextEncoder().encode(raw).length > MAX_SVG_BYTES) {
    return reject(`exceeds ${MAX_SVG_BYTES} bytes`);
  }
  const trimmed = raw.replace(/^\s*<\?xml[^>]*\?>\s*/i, '').trim();
  if (/<!DOCTYPE|<!ENTITY/i.test(trimmed)) {
    return reject('declarations are forbidden');
  }
  let malformed = false;
  const fragment = parseFragment(trimmed, {
    onParseError: () => {
      malformed = true;
    },
  });
  if (malformed) {
    return reject('malformed SVG markup');
  }
  const roots = fragment.childNodes.filter((node) => node.nodeName !== '#comment');
  const root = roots[0];
  if (roots.length !== 1 || !root || !('tagName' in root) || root.tagName !== 'svg') {
    return reject('must be a single <svg> root element');
  }

  const pending: { node: DefaultTreeAdapterMap['childNode']; depth: number }[] = [
    { node: root, depth: 0 },
  ];
  while (pending.length > 0) {
    const { node, depth } = pending.pop()!;
    if (depth > 64) {
      return reject('SVG nesting exceeds 64 levels');
    }
    if (node.nodeName === '#text' || node.nodeName === '#comment') {
      continue;
    }
    if (!('tagName' in node) || node.namespaceURI !== SVG_NS || !TAGS.has(node.tagName)) {
      return reject('forbidden SVG element');
    }
    if (node !== root && node.tagName === 'svg') {
      return reject('nested SVG is forbidden');
    }
    for (const attr of node.attrs) {
      const { name, value, namespace, prefix } = attr;
      if (name === 'xmlns' && !prefix && value === SVG_NS) {
        continue;
      }
      if (prefix === 'xmlns' && name === 'xlink' && value === 'http://www.w3.org/1999/xlink') {
        continue;
      }
      if (
        name === 'href' &&
        (!namespace || namespace === 'http://www.w3.org/1999/xlink') &&
        FRAGMENT.test(value)
      ) {
        continue;
      }
      if (namespace || prefix) {
        return reject('forbidden attribute namespace');
      }
      if (name === 'style' && safeStyle(value)) {
        continue;
      }
      if (PRESENTATION.has(name) && safePresentation(value)) {
        continue;
      }
      if (ATTRS.has(name)) {
        continue;
      }
      return reject(`forbidden SVG attribute: ${name}`);
    }
    pending.push(...node.childNodes.map((child) => ({ node: child, depth: depth + 1 })));
  }
  // Emit the parsed tree, so browser consumers never reinterpret unchecked source syntax.
  return { ok: true, svg: serialize(fragment) };
}
