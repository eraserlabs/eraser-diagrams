import postcss from 'postcss';
import { DATA_ROLES } from '@eraserlabs/protocol';
import type { ElementKind } from '@eraserlabs/protocol/schema';
import type { ParsedTemplate } from './parse.js';

// Isolated model: a template's CSS is authored with bare selectors; at render time it is wrapped
// in `@scope([data-mdp-tag="Name"]) to ([data-mdp-tag])` — scoped to the template's mount
// hosts, stopping at nested mount hosts — so selectors can never cross template boundaries. The
// linter therefore validates the raw bare-selector CSS (no global-namespace assumption); it also
// forbids @import/@font-face/url(), the author's own scoping/shadow selectors (which would fight
// the generated wrapping), and the security rules below.

/**
 * The single registry of library lint rules — markup/CSS rules first, then the schema rules the
 * boot-time schema check emits (see ../schema/definition.ts). Every emitted issue carries one of these codes, so a
 * new rule must be added here first — no ad-hoc strings at call sites.
 */
export const LINT_RULE = {
  PALETTE_TOKEN_NAME: 'palette-token-name',
  PALETTE_COLOR: 'palette-color',
  PALETTE_SHAPE: 'palette-shape',
  DEFAULT_CONNECTION_TAG: 'default-connection-tag',
  DUPLICATE_NAME: 'duplicate-template-name',
  MISSING_ELEMENT_KIND: 'missing-element-kind',
  ROOT_TPL_MISMATCH: 'root-tpl-mismatch',
  UNKNOWN_ROLE: 'unknown-role',
  BODY_ROLE_COUNT: 'body-role-count',
  UNKNOWN_PLACEHOLDER: 'unknown-placeholder',
  EACH_GRAMMAR: 'each-grammar',
  FORBIDDEN_MARKUP: 'forbidden-markup',
  FORBIDDEN_CSS: 'forbidden-css',
  CONTENT_IN_ATTRIBUTE: 'content-in-attribute',
  UNQUOTED_ATTRIBUTE: 'unquoted-attribute',
} as const;

export type LintRule = (typeof LINT_RULE)[keyof typeof LINT_RULE];

export interface LintIssue {
  rule: LintRule;
  /**
   * The template name, or — for a schema rule — the tag or sub-template the schema belongs to.
   * Library-wide checks that belong to no template report under `"palette"` and the like.
   */
  template: string;
  message: string;
}

const FORBIDDEN_TAGS = new Set([
  'script',
  'iframe',
  'object',
  'embed',
  'foreignobject',
  'base',
  'meta',
  'link',
]);
const ALLOWED_ROLES = new Set<string>(DATA_ROLES);
// Sanctioned style declarations. Font-role binding: a font role from a (possibly loop-var) prop,
// with an optional role fallback — an absent prop substitutes to the undefined-but-valid name
// `--font-`, so the fallback var kicks in, no schema default needed.
const FONT_ROLE_DECL = /^--f:\s*var\(--font-\{\{\s*[\w.]+\s*\}\}(?:,\s*var\(--font-\w+\))?\)$/;
// Custom-property binding: `--er-name: {{path}}` (optional px suffix). Allowed only for paths the
// schema types as css-color or number — both validated value grammars that cannot break out of a
// style declaration — checked against LintContext.styleBindable below.
const VAR_BINDING_DECL = /^--er-[a-z][\w-]*:\s*\{\{\s*([\w.]+)\s*\}\}(?:px)?$/;

export interface LintContext {
  allowedProps: string[];
  isSubTemplate: boolean;
  elementKind?: ElementKind;
  /** Schema pointers carrying an `x-content` policy (from the tag schema). */
  contentPointers: Set<string>;
  /**
   * Schema pointers (`/prop`, or with a `*` segment per array level) whose values are
   * css-color-typed or number-typed — the only props a `--er-` style binding may substitute.
   */
  styleBindable: Set<string>;
}

/** Lint one parsed template against the coded rules. Returns all issues (empty = clean). */
export function lintTemplate(t: ParsedTemplate, ctx: LintContext): LintIssue[] {
  const issues: LintIssue[] = [];

  const add = (rule: LintRule, message: string): void => {
    issues.push({ rule, template: t.name, message });
  };

  if (t.dataTpl !== t.name) {
    add(
      LINT_RULE.ROOT_TPL_MISMATCH,
      `root data-tpl "${t.dataTpl ?? ''}" must equal template name "${t.name}"`,
    );
  }

  for (const role of t.roles) {
    if (!ALLOWED_ROLES.has(role)) {
      add(LINT_RULE.UNKNOWN_ROLE, `unknown data-role "${role}"`);
    }
  }

  if (!ctx.isSubTemplate && (ctx.elementKind ?? 'entity') === 'entity') {
    const bodies = t.roles.filter((r) => r === 'body').length;

    if (bodies !== 1) {
      add(
        LINT_RULE.BODY_ROLE_COUNT,
        `entity template must have exactly one data-role="body" (found ${bodies})`,
      );
    }
  }

  const allowed = new Set<string>([...ctx.allowedProps, ...t.loopVars, '']);

  for (const head of t.placeholderHeads) {
    if (!allowed.has(head)) {
      add(
        LINT_RULE.UNKNOWN_PLACEHOLDER,
        `placeholder "{{${head}}}" is not a schema property or loop variable`,
      );
    }
  }

  for (const each of t.eachExpressions) {
    if (!/^\s*[A-Za-z_]\w*\s+of\s+\S+/.test(each.expr)) {
      add(
        LINT_RULE.EACH_GRAMMAR,
        `invalid data-each expression "${each.expr}" (expected: VAR of PROP)`,
      );
    }

    if (!each.hasKey) {
      add(LINT_RULE.EACH_GRAMMAR, `data-each "${each.expr}" requires a sibling data-key`);
    }
  }

  for (const tag of t.usedTags) {
    if (FORBIDDEN_TAGS.has(tag)) {
      add(LINT_RULE.FORBIDDEN_MARKUP, `forbidden tag <${tag}>`);
    }
  }

  for (const a of t.usedAttrs) {
    if (a.startsWith('on')) {
      add(LINT_RULE.FORBIDDEN_MARKUP, `forbidden event-handler attribute "${a}"`);
    }

    // A declarative shadow root would hide template content from the light-DOM mount, measure,
    // and scoped-CSS machinery.
    if (a.startsWith('shadowroot')) {
      add(LINT_RULE.FORBIDDEN_MARKUP, `forbidden shadow-root attribute "${a}"`);
    }
  }

  if (/javascript:|data:/i.test(t.file.html)) {
    add(LINT_RULE.FORBIDDEN_MARKUP, 'forbidden javascript:/data: URI in markup');
  }

  checkStyleAttrs(t, ctx, add);
  lintCss(t, add);

  // Content-typed props may never sit in attribute position. Escaped text is safe in a quoted
  // attribute too, but keeping content out of attributes preserves the invariant that attribute
  // substitution never needs escaping (enum/number props carry no x-content keyword). The path
  // resolves against the schema's content pointers (loop-var aware) — a non-content subpath of a
  // content-carrying object (e.g. its enum typeface) stays legal; a whole array/object that
  // contains content is flagged via the prefix check.
  for (const path of t.attrPlaceholderPaths) {
    if (path === '') {
      continue;
    }

    const pointer = pathToPointer(path, eachVarToProp(t));

    // Both directions: a content leaf below the substituted path (whole object in an attribute)
    // and a substituted path below a content pointer (subpath of a content-typed node).
    const hitsContent =
      ctx.contentPointers.has(pointer) ||
      [...ctx.contentPointers].some(
        (p) => p.startsWith(`${pointer}/`) || pointer.startsWith(`${p}/`),
      );

    if (hitsContent) {
      add(
        LINT_RULE.CONTENT_IN_ATTRIBUTE,
        `content-typed prop "{{${path}}}" may not appear in an attribute value`,
      );
    }
  }

  // Every attribute value must be quoted; an unquoted value would let escaped content terminate
  // the attribute. Quoted values are blanked first; a value containing a literal `>` inside quotes
  // would truncate the tag match, so keep authored values free of raw `>`.
  for (const tagMatch of t.file.html.matchAll(/<[a-zA-Z][^>]*/g)) {
    const stripped = tagMatch[0].replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
    const unquoted = /([\w-]+)\s*=\s*(?!["'])\S/.exec(stripped);

    if (unquoted) {
      add(LINT_RULE.UNQUOTED_ATTRIBUTE, `attribute "${unquoted[1]}" must use a quoted value`);
    }
  }

  return issues;
}

function checkStyleAttrs(
  t: ParsedTemplate,
  ctx: LintContext,
  add: (rule: LintRule, m: string) => void,
): void {
  if (!t.usedAttrs.includes('style')) {
    return;
  }

  const loopVars = eachVarToProp(t);

  for (const m of t.file.html.matchAll(/\sstyle\s*=\s*"([^"]*)"/gi)) {
    const declarations = m[1]!
      .split(';')
      .map((d) => d.trim())
      .filter((d) => d !== '');
    const ok = declarations.every(
      (decl) => FONT_ROLE_DECL.test(decl) || varBindingOk(decl, ctx, loopVars),
    );

    if (declarations.length === 0 || !ok) {
      add(
        LINT_RULE.FORBIDDEN_MARKUP,
        `style attribute "${m[1]}" is not a sanctioned font-role or typed --er-* binding`,
      );
    }
  }
}

/**
 * data-each="v of prop" var → prop, for resolving loop-var paths to schema pointers. The prop
 * grammar mirrors parse.ts exactly — a stricter regex here would silently skip mapping and
 * mis-resolve the loop-var paths downstream.
 */
function eachVarToProp(t: ParsedTemplate): Map<string, string> {
  const map = new Map<string, string>();

  for (const each of t.eachExpressions) {
    const m = /^\s*([A-Za-z_]\w*)\s+of\s+(.+?)\s*$/.exec(each.expr);

    if (m) {
      map.set(m[1]!, m[2]!);
    }
  }

  return map;
}

/** Dotted template path → schema pointer, mapping a loop-var head through its array prop. */
function pathToPointer(path: string, loopVars: Map<string, string>): string {
  const segments = path.split('.');
  const eachProp = loopVars.get(segments[0]!);

  if (eachProp === undefined) {
    return `/${segments.join('/')}`;
  }

  return `/${eachProp.split('.').join('/')}/*${segments
    .slice(1)
    .map((s) => `/${s}`)
    .join('')}`;
}

/** A `--er-name: {{path}}` declaration is sanctioned iff the path resolves to a bindable pointer. */
function varBindingOk(decl: string, ctx: LintContext, loopVars: Map<string, string>): boolean {
  const m = VAR_BINDING_DECL.exec(decl);

  if (!m) {
    return false;
  }

  return ctx.styleBindable.has(pathToPointer(m[1]!, loopVars));
}

function lintCss(t: ParsedTemplate, add: (rule: LintRule, m: string) => void): void {
  let root: postcss.Root;

  try {
    root = postcss.parse(t.file.css);
  } catch (e) {
    add(LINT_RULE.FORBIDDEN_CSS, `CSS parse error: ${(e as Error).message}`);

    return;
  }

  root.walkAtRules((at) => {
    if (at.name === 'import' || at.name === 'font-face' || at.name === 'scope') {
      add(LINT_RULE.FORBIDDEN_CSS, `forbidden @${at.name} in template CSS`);
    }
  });
  // Scoping is generated, never authored: an author's own :scope would bind to the generated
  // wrapper unpredictably, and shadow selectors are meaningless in this model.
  root.walkRules((rule) => {
    if (/:scope|:host|::slotted|::part/i.test(rule.selector)) {
      add(LINT_RULE.FORBIDDEN_CSS, `forbidden scoping selector in "${rule.selector}"`);
    }
  });
  root.walkDecls((decl) => {
    if (/url\(/i.test(decl.value)) {
      add(LINT_RULE.FORBIDDEN_CSS, `forbidden url() in CSS declaration "${decl.prop}"`);
    }
  });
}
