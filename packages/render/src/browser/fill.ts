/**
 * Browser-side fill engine: expands the declarative template dialect into ready-to-mount HTML
 * strings. All value insertion is string substitution followed by HTML-parser assignment — resolve
 * pre-escapes content (plain policy escapes `& < > " '`), so the parser decodes entities
 * correctly in both text and quoted-attribute positions. Never `textContent`/`setAttribute` for
 * content values: that would double-escape.
 *
 * Every template mounts inside a host element carrying `data-mdp-tag` — the wrapper div for
 * top-level elements, the `data-use` host for compositions (this stage stamps the attribute).
 * Isolation happens in CSS: each template's stylesheet is wrapped in
 * `@scope([data-mdp-tag="Name"]) to ([data-mdp-tag])`, so its selectors reach only the
 * host's subtree and stop at nested mount hosts. Because the scope root is the host — never the
 * styled template root itself — bare selectors match the whole template, root included.
 *
 * Dialect:
 * - `data-if="prop"`        — falsy prop removes the element and its subtree.
 * - `data-each="v of prop"` — repeats the element's child subtree per array item; `data-key` is a
 *                             lint-enforced authoring concern, ignored at fill time.
 * - `data-use="Name"` + `data-props="prop"` — fills template Name with the prop object as scope,
 *                             mounted inside the host element.
 * - `data-slot="prop"`      — mounts the sanitized SVG for the icon named by that prop, looked up
 *                             in the icons sidecar.
 * - `{{prop}}` / `{{v.field}}` — path substitution; loop vars shadow props inside `data-each`.
 * - `{{ }}`                 — empty placeholder, left verbatim for the layout/apply stage.
 */

export interface FillEngineInit {
  /** Template name → template file HTML (the `<template name="X">…</template>` wrapper included). */
  templates: Record<string, string>;
  /** Icon name → sanitized SVG source (the sidecar shipped alongside the elements). */
  icons: Record<string, string>;
}

/** Fills a template and returns its mount markup (host content). */
export type FillFn = (name: string, props: Record<string, unknown>) => string;

const PLACEHOLDER_RE = /\{\{\s*([^}]*?)\s*\}\}/g;
const EACH_RE = /^\s*([A-Za-z_]\w*)\s+of\s+(.+?)\s*$/;
const MAX_USE_DEPTH = 32;

export function createFillEngine(init: FillEngineInit): FillFn {
  const contents = new Map<string, string>();

  for (const [name, html] of Object.entries(init.templates)) {
    contents.set(name, extractTemplateContent(name, html));
  }

  function fill(name: string, props: Record<string, unknown>, depth = 0): string {
    if (depth > MAX_USE_DEPTH) {
      throw new Error(`template "${name}": data-use recursion exceeds ${MAX_USE_DEPTH}`);
    }

    const raw = contents.get(name);

    if (raw === undefined) {
      throw new Error(`unknown template "${name}"`);
    }

    const work = document.createElement('template');
    work.innerHTML = raw;

    for (const el of [...work.content.children]) {
      processElement(el, props, depth);
    }

    return substitute(work.innerHTML, props);
  }

  function processElement(el: Element, props: Record<string, unknown>, depth: number): void {
    const ifExpr = el.getAttribute('data-if');

    if (ifExpr !== null && !lookup(props, ifExpr)) {
      el.remove();

      return;
    }

    const eachExpr = el.getAttribute('data-each');

    if (eachExpr !== null) {
      expandEach(el, eachExpr, props);

      return;
    }

    const useTarget = el.getAttribute('data-use');

    if (useTarget !== null) {
      const propsAttr = el.getAttribute('data-props');
      const sub = propsAttr === null ? undefined : lookup(props, propsAttr);
      // The host becomes the sub-template's scope root — and the enclosing template's scope
      // boundary — via this attribute.
      el.setAttribute('data-mdp-tag', useTarget);
      el.innerHTML = fill(useTarget, asPropsObject(sub), depth + 1);

      return;
    }

    const slotProp = el.getAttribute('data-slot');

    if (slotProp !== null) {
      const iconName = lookup(props, slotProp);
      el.innerHTML = typeof iconName === 'string' ? (init.icons[iconName] ?? '') : '';

      return;
    }

    for (const child of [...el.children]) {
      processElement(child, props, depth);
    }
  }

  function expandEach(el: Element, expr: string, props: Record<string, unknown>): void {
    const m = EACH_RE.exec(expr);

    if (!m) {
      el.innerHTML = '';

      return;
    }

    const [, varName, path] = m;
    const items = lookup(props, path!);
    const itemTemplate = el.innerHTML;
    const list = Array.isArray(items) ? items : [];
    el.innerHTML = list
      .map((item) => substitute(itemTemplate, { ...props, [varName!]: item }))
      .join('');
  }

  return (name, props) => fill(name, props);
}

/**
 * Replace `{{path}}` placeholders with scope values. `{{ }}` (empty) is left verbatim for the
 * layout stage. Substituted values are already HTML-safe by contract (resolve escaped/sanitized
 * them), so a value that happens to contain literal `{{…}}` cannot execute — at worst it is
 * replaced as text on a later pass.
 */
function substitute(html: string, scope: Record<string, unknown>): string {
  return html.replace(PLACEHOLDER_RE, (match, inner: string) => {
    if (inner === '') {
      return match;
    }

    const value = lookup(scope, inner);

    if (value === undefined || value === null) {
      return '';
    }

    return String(value);
  });
}

/** Own-property dotted-path lookup; never walks the prototype chain. */
function lookup(scope: Record<string, unknown>, path: string): unknown {
  let current: unknown = scope;

  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, part)) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

function asPropsObject(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function extractTemplateContent(name: string, fileHtml: string): string {
  const host = document.createElement('template');
  host.innerHTML = fileHtml;
  const tpl = host.content.querySelector('template');

  if (!tpl) {
    throw new Error(`template "${name}": no <template> element found`);
  }

  return tpl.innerHTML;
}
