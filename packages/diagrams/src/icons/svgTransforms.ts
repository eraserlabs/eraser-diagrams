/**
 * Icon SVG normalization for assets fetched from the public bucket (docs/icon-service.md).
 * Environment-free string work — usable in Node and browser.
 *
 * Pipeline: inlineStyleClasses → sanitizeSvgString → ensureViewBox → uniquifyIds
 * (→ normalizeToCurrentColor for monochrome callers).
 */

/**
 * The fetch-time normalization chain for bucket icons. Classification-free: only the brand
 * assets need class-inlining, sanitization, viewBox synthesis and id prefixing to survive as
 * CSS-scaled inline SVG.
 */
export function normalizeFetchedIcon(svg: string, name: string): string {
  return uniquifyIds(ensureViewBox(sanitizeSvgString(inlineStyleClasses(svg))), `er-${name}`);
}

/**
 * Prefix every `id` and its in-document references (`url(#…)`, `href="#…"`) so icons from sets
 * that share generic ids (`a`, `b`, gradient names) can coexist in one document. The same icon
 * mounted twice still shares ids — harmless, the defs are identical.
 */
export function uniquifyIds(svg: string, prefix: string): string {
  const ids = [...new Set([...svg.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]!))];

  if (ids.length === 0) {
    return svg;
  }

  // Longest first, so rewriting #a can never clobber the middle of #ab.
  ids.sort((a, b) => b.length - a.length);
  let out = svg;

  for (const id of ids) {
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const safe = `${prefix}-${id}`;
    out = out
      .replace(new RegExp(`\\bid\\s*=\\s*(["'])${esc}\\1`, 'g'), `id="${safe}"`)
      .replace(new RegExp(`url\\(\\s*(['"]?)#${esc}\\1\\s*\\)`, 'g'), `url(#${safe})`)
      .replace(new RegExp(`\\b(href\\s*=\\s*)(["'])#${esc}\\2`, 'g'), `$1"#${safe}"`);
  }

  return out;
}

const FORBIDDEN_SVG_TAGS = ['script', 'foreignobject', 'iframe', 'style'];

function stripForbiddenTags(svg: string): string {
  let out = svg;

  for (const tag of FORBIDDEN_SVG_TAGS) {
    // Paired and self-closing forms; case-insensitive tag names.
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'gi'), '');
    out = out.replace(new RegExp(`<${tag}\\b[^>]*/>`, 'gi'), '');
  }

  return out;
}

function stripEventHandlerAttrs(svg: string): string {
  return svg.replace(/\son[a-z]+\s*=\s*(".*?"|'.*?')/gi, '');
}

function stripExternalRefs(svg: string): string {
  // Only in-document fragment refs like "#gradient-a" are legitimate inside a vendored icon.
  return svg.replace(
    /\s(xlink:href|href)\s*=\s*(".*?"|'.*?')/gi,
    (full, _attr: string, quoted: string) => {
      const value = quoted.slice(1, -1);

      return value.startsWith('#') ? full : '';
    },
  );
}

export function sanitizeSvgString(svg: string): string {
  return stripExternalRefs(stripEventHandlerAttrs(stripForbiddenTags(svg)));
}

function shouldPreservePaint(paint: string): boolean {
  const normalized = paint.trim().toLowerCase();

  return (
    normalized === '' ||
    normalized === 'none' ||
    normalized === 'transparent' ||
    normalized === 'inherit' ||
    normalized === 'initial' ||
    normalized === 'unset' ||
    normalized === 'currentcolor' ||
    normalized.startsWith('url(')
  );
}

/** Rewrite hardcoded fill/stroke/color/stop-color paint (attribute and inline-style forms) to
 * currentColor, preserving the meaningful sentinels (none/transparent/inherit/url() refs). */
export function normalizeToCurrentColor(svg: string): string {
  const replaceAttrPaint = (match: string, name: string, quote: string, paint: string): string => {
    if (shouldPreservePaint(paint)) {
      return match;
    }

    return `${name}=${quote}currentColor${quote}`;
  };

  const replaceCssPaint = (match: string, name: string, paint: string): string => {
    if (shouldPreservePaint(paint)) {
      return match;
    }

    return `${name}: currentColor`;
  };

  return svg
    .replace(/\b(fill|stroke|color|stop-color)=(["'])([^"']*)\2/gi, replaceAttrPaint)
    .replace(/\b(fill|stroke|color|stop-color)\s*:\s*([^;}"']+)/gi, replaceCssPaint);
}

/**
 * Adds `viewBox="0 0 w h"` to the root `<svg>` when it has numeric width/height attributes (bare
 * or px-suffixed) but no viewBox. Non-numeric dimensions are left alone — there is no coordinate
 * system to infer from them.
 */
export function ensureViewBox(svg: string): string {
  // First <svg ...> tag only (the root); quoted attr values may contain '>'.
  return svg.replace(/<svg\b((?:[^>"']|"[^"]*"|'[^']*')*)>/i, (full, attrs: string) => {
    if (/(?:^|\s)viewBox\s*=/i.test(attrs)) {
      return full;
    }

    const width = readNumericDimension(attrs, 'width');
    const height = readNumericDimension(attrs, 'height');

    if (width === null || height === null) {
      return full;
    }

    return `<svg${attrs} viewBox="0 0 ${width} ${height}">`;
  });
}

function readNumericDimension(attrs: string, name: string): string | null {
  // (?:^|\s) so `width` never matches inside `stroke-width`.
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']\\s*([0-9.]+)(?:px)?\\s*["']`, 'i').exec(
    attrs,
  );

  return match === null ? null : match[1]!;
}

type ClassRule = {
  className: string;
  declarations: [property: string, value: string][];
};

function parseClassRules(cssText: string): ClassRule[] {
  const rules: ClassRule[] = [];
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  let ruleMatch = rulePattern.exec(cssText);

  while (ruleMatch !== null) {
    const declarations: [string, string][] = [];

    for (const declaration of ruleMatch[2]!.split(';')) {
      const colonIndex = declaration.indexOf(':');

      if (colonIndex > 0) {
        const property = declaration.slice(0, colonIndex).trim().toLowerCase();
        const value = declaration.slice(colonIndex + 1).trim();

        // Guard against values that would break out of the style="" attribute they fold into.
        if (property !== '' && value !== '' && !/["'<>]/.test(value)) {
          declarations.push([property, value]);
        }
      }
    }

    if (declarations.length > 0) {
      for (const selector of ruleMatch[1]!.split(',')) {
        const classMatch = /^\.([A-Za-z_][\w-]*)$/.exec(selector.trim());

        if (classMatch !== null) {
          rules.push({ className: classMatch[1]!, declarations });
        }
      }
    }

    ruleMatch = rulePattern.exec(cssText);
  }

  return rules;
}

function parseInlineStyleProperties(styleText: string): Set<string> {
  const properties = new Set<string>();

  for (const declaration of styleText.split(';')) {
    const colonIndex = declaration.indexOf(':');

    if (colonIndex > 0) {
      properties.add(declaration.slice(0, colonIndex).trim().toLowerCase());
    }
  }

  return properties;
}

const CLASS_ATTR_PATTERN = /\s+class\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const STYLE_ATTR_PATTERN = /(\s+style\s*=\s*)(?:"([^"]*)"|'([^']*)')/i;

/**
 * Folds `<style>` class rules into per-element `style` attributes and removes the `<style>`
 * blocks. Rules apply in source order (later rules win for the same property, matching the CSS
 * cascade at equal specificity); properties already present in an element's inline `style` are
 * left alone. Matched elements lose their `class` attribute — it has no remaining purpose once
 * the rules are inlined.
 */
export function inlineStyleClasses(svg: string): string {
  const cssBlocks: string[] = [];
  const withoutStyleTags = svg.replace(
    /<style\b[^>]*>([\s\S]*?)<\/style>/gi,
    (_full, css: string) => {
      cssBlocks.push(css);

      return '';
    },
  );

  if (cssBlocks.length === 0) {
    return svg;
  }

  const rules = parseClassRules(cssBlocks.join('\n'));

  if (rules.length === 0) {
    return withoutStyleTags;
  }

  return withoutStyleTags.replace(
    /<([A-Za-z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g,
    (full, tag: string, attrs: string, selfClose: string) => {
      const classMatch = CLASS_ATTR_PATTERN.exec(attrs);

      if (classMatch === null) {
        return full;
      }

      const classNames = new Set((classMatch[1] ?? classMatch[2]!).split(/\s+/).filter(Boolean));
      const merged = new Map<string, string>();

      for (const rule of rules) {
        if (classNames.has(rule.className)) {
          for (const [property, value] of rule.declarations) {
            merged.set(property, value);
          }
        }
      }

      if (merged.size === 0) {
        return full;
      }

      let newAttrs = attrs.replace(CLASS_ATTR_PATTERN, '');
      const styleMatch = STYLE_ATTR_PATTERN.exec(newAttrs);
      const inlineProperties =
        styleMatch === null
          ? new Set<string>()
          : parseInlineStyleProperties(styleMatch[2] ?? styleMatch[3]!);
      const additions = Array.from(merged)
        .filter(([property]) => !inlineProperties.has(property))
        .map(([property, value]) => `${property}:${value}`)
        .join(';');

      if (additions === '') {
        return `<${tag}${newAttrs}${selfClose}>`;
      }

      if (styleMatch === null) {
        newAttrs += ` style="${additions}"`;
      } else {
        const existing = styleMatch[2] ?? styleMatch[3]!;
        const separator = existing.trim() === '' || existing.trim().endsWith(';') ? '' : ';';
        const quote = existing.includes('"') ? "'" : '"';
        newAttrs = newAttrs.replace(
          STYLE_ATTR_PATTERN,
          (_styleFull, prefix: string) =>
            `${prefix}${quote}${existing}${separator}${additions}${quote}`,
        );
      }

      return `<${tag}${newAttrs}${selfClose}>`;
    },
  );
}
