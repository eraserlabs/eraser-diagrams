const MAX_SVG_BYTES = 64 * 1024;

// Fail-closed patterns: any match drops the icon rather than attempting a risky in-place strip.
const DANGEROUS = [
  /<script[\s>]/i,
  /<foreignObject[\s>]/i,
  /<(iframe|object|embed)[\s>]/i,
  /<!ENTITY/i,
  /<!DOCTYPE/i,
  /\son\w+\s*=/i,
  /javascript:/i,
  /\sstyle\s*=\s*["'][^"']*url\(/i,
  // External references in href / xlink:href (local "#id" refs are allowed).
  /(?:xlink:)?href\s*=\s*["'](?!#)/i,
];

export interface SvgSanitizeResult {
  ok: boolean;
  svg?: string;
  reason?: string;
}

/**
 * Validate an SVG for safe inline embedding. Sanitized once when first loaded, never per call.
 * Conservative and fail-closed: a suspect icon is rejected and skipped, not partially cleaned.
 */
export function sanitizeSvg(raw: string): SvgSanitizeResult {
  if (raw.length > MAX_SVG_BYTES) {
    return { ok: false, reason: `exceeds ${MAX_SVG_BYTES} bytes` };
  }

  const trimmed = raw.replace(/^\s*<\?xml[^>]*\?>\s*/i, '').trim();

  if (!trimmed.startsWith('<svg') || !trimmed.endsWith('</svg>')) {
    return { ok: false, reason: 'must be a single <svg> root element' };
  }

  const svgOpenCount = (trimmed.match(/<svg[\s>]/gi) ?? []).length;

  if (svgOpenCount !== 1) {
    return { ok: false, reason: 'must contain exactly one <svg> root' };
  }

  for (const pattern of DANGEROUS) {
    if (pattern.test(trimmed)) {
      return { ok: false, reason: `matched forbidden pattern ${pattern.source}` };
    }
  }

  return { ok: true, svg: trimmed };
}
