import { describe, it, expect } from 'vitest';
import {
  sanitizeSvgString,
  normalizeToCurrentColor,
  ensureViewBox,
  inlineStyleClasses,
  uniquifyIds,
  normalizeFetchedIcon,
} from '../src/icons/svgTransforms.js';

describe('icon svg transforms (icon-service build-time normalization)', () => {
  it('sanitize strips scripts, handlers and external refs; fragment refs survive', () => {
    const hostile =
      '<svg><script>alert(1)</script><a href="https://evil" onclick="x()">' +
      '<use href="#frag"/></a></svg>';
    const clean = sanitizeSvgString(hostile);
    expect(clean).not.toContain('script');
    expect(clean).not.toContain('onclick');
    expect(clean).not.toContain('https://evil');
    expect(clean).toContain('href="#frag"');
  });

  it('inlineStyleClasses folds class rules into style attrs and drops the block', () => {
    const gcpLike =
      '<svg><style>.cls-1{fill:#4285f4}.cls-2{fill:#669df6;fill-rule:evenodd}</style>' +
      '<path class="cls-1" d="M0 0"/><path class="cls-2" d="M1 1"/></svg>';
    const inlined = inlineStyleClasses(gcpLike);
    expect(inlined).not.toContain('<style');
    expect(inlined).not.toContain('class=');
    expect(inlined).toContain('style="fill:#4285f4"');
    expect(inlined).toContain('style="fill:#669df6;fill-rule:evenodd"');
  });

  it('ensureViewBox synthesizes from numeric dimensions, leaves existing/non-numeric alone', () => {
    expect(ensureViewBox('<svg width="24" height="24px"><path/></svg>')).toContain(
      'viewBox="0 0 24 24"',
    );
    const existing = '<svg viewBox="0 0 10 10" width="24" height="24"/>';
    expect(ensureViewBox(existing)).toBe(existing);
    const percent = '<svg width="100%" height="24"/>';
    expect(ensureViewBox(percent)).toBe(percent);
  });

  it('normalizeToCurrentColor rewrites paint but preserves the sentinels', () => {
    const svg = '<svg fill="none" stroke="#242424" style="stop-color:#ff0000;fill:url(#g)"/>';
    const normalized = normalizeToCurrentColor(svg);
    expect(normalized).toContain('fill="none"');
    expect(normalized).toContain('stroke="currentColor"');
    expect(normalized).toContain('stop-color: currentColor');
    expect(normalized).toContain('fill:url(#g)');
  });

  it('uniquifyIds prefixes ids and every in-document reference', () => {
    const svg =
      '<svg><defs><linearGradient id="a"/><linearGradient id="ab"/></defs>' +
      '<path fill="url(#a)"/><rect fill="url(#ab)"/><use href="#a"/></svg>';
    const out = uniquifyIds(svg, 'er-azure-x');
    expect(out).toContain('id="er-azure-x-a"');
    expect(out).toContain('id="er-azure-x-ab"');
    expect(out).toContain('url(#er-azure-x-a)');
    expect(out).toContain('url(#er-azure-x-ab)');
    expect(out).toContain('href="#er-azure-x-a"');
    expect(out).not.toContain('id="a"');
    expect(out).not.toContain('er-azure-x-er-azure-x');
  });

  it('uniquifyIds leaves id-free icons untouched', () => {
    const svg = '<svg viewBox="0 0 24 24"><path d="M0 0"/></svg>';
    expect(uniquifyIds(svg, 'er-db')).toBe(svg);
  });

  it('normalizeFetchedIcon applies the id prefix from the icon name', () => {
    const raw =
      '<svg width="24" height="24"><defs><linearGradient id="a"/></defs><path fill="url(#a)"/></svg>';
    const out = normalizeFetchedIcon(raw, 'aws-s3');
    expect(out).toContain('viewBox="0 0 24 24"');
    expect(out).toContain('id="er-aws-s3-a"');
    expect(out).toContain('url(#er-aws-s3-a)');
  });
});
