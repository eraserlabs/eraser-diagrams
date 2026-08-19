import { elementKindOf } from '@eraserlabs/protocol/schema';
import type {
  TemplateLibrary,
  PreparedTemplate,
  AuthoredLibrary,
  TemplateOverrides,
} from '../types.js';
import { walkPolicies } from '../schema/compile.js';
import { CSS_COLOR_KEYWORD, PALETTE_KEYWORD } from '../schema/keywords.js';
import { walkSchema } from '../schema/walk.js';
import { parseTemplate } from './parse.js';
import { lintTemplate, LINT_RULE, type LintIssue } from './lint.js';
import { mergeTemplates } from './merge.js';
import { checkPalette } from './palette.js';

export class RegistryError extends Error {
  constructor(public issues: LintIssue[]) {
    super(
      `template library rejected:\n${issues.map((i) => `  [${i.rule}] ${i.template}: ${i.message}`).join('\n')}`,
    );
    this.name = 'RegistryError';
  }
}

/**
 * Prepare an authored library at boot: merge overrides, parse, and lint the templates against the
 * schemas they render. Any issue throws (fail fast). `createResolver` runs this itself, so the
 * engine can never validate against an unlinted library; the schemas themselves are checked against
 * the published MDP subset a moment later, in `compileSchemas`. CSS ships bare: the render stage
 * confines each template's stylesheet to its mount hosts with a generated host-scoped @scope block,
 * so isolation needs no selector rewriting here.
 */
export function prepareLibrary(
  library: AuthoredLibrary,
  overrides?: TemplateOverrides,
): TemplateLibrary {
  const merged = mergeTemplates(library.templates, overrides?.templates ?? []);
  const subTemplates = library.subTemplates ?? {};
  const paletteIssues: LintIssue[] = [];
  const palette = checkPalette(library.palette, paletteIssues);
  const defaultConnectionTag = checkDefaultConnectionTag(library, paletteIssues);
  const seen = new Set<string>();
  const prepared: PreparedTemplate[] = [];
  const issues: LintIssue[] = [...paletteIssues];

  for (const file of merged) {
    const parsed = parseTemplate(file);

    if (seen.has(parsed.name)) {
      issues.push({
        rule: LINT_RULE.DUPLICATE_NAME,
        template: parsed.name,
        message: 'duplicate template name',
      });
      continue;
    }

    seen.add(parsed.name);

    const schema = library.schemas[parsed.name] ?? subTemplates[parsed.name];
    const isSubTemplate = parsed.name in subTemplates;
    const elementKind = elementKindOf(schema);

    if (!isSubTemplate && !elementKind) {
      issues.push({
        rule: LINT_RULE.MISSING_ELEMENT_KIND,
        template: parsed.name,
        message: 'dispatchable tag schema must declare x-schema-kind',
      });
    }

    issues.push(
      ...lintTemplate(parsed, {
        allowedProps: propsOf(schema),
        isSubTemplate,
        ...(elementKind ? { elementKind } : {}),
        contentPointers: contentPointersOf(schema),
        styleBindable: styleBindablePointersOf(schema),
      }),
    );

    prepared.push({
      name: parsed.name,
      html: file.html,
      css: file.css,
    });
  }

  if (issues.length > 0) {
    throw new RegistryError(issues);
  }

  const byName = new Set(prepared.map((t) => t.name));
  const order = library.manifest.filter((name) => byName.has(name));
  const extras = prepared.filter((t) => !order.includes(t.name)).map((t) => t.name);

  return {
    manifest: [...order, ...extras],
    schemas: library.schemas,
    templates: prepared,
    baseCss: library.baseCss,
    ...(palette ? { palette } : {}),
    ...(defaultConnectionTag !== undefined ? { defaultConnectionTag } : {}),
  };
}

/**
 * A declared default connection tag must name a connection-kind schema in this library — an
 * unknown or entity-kind default would turn every tag-less connection into a confusing dispatch
 * failure at request time, so it is a boot-time library error instead.
 */
function checkDefaultConnectionTag(
  library: AuthoredLibrary,
  issues: LintIssue[],
): string | undefined {
  const tag = library.defaultConnectionTag;

  if (tag === undefined) {
    return undefined;
  }

  const schema = (library.schemas as Record<string, object | undefined>)[tag];

  if (schema === undefined) {
    issues.push({
      rule: LINT_RULE.DEFAULT_CONNECTION_TAG,
      template: tag,
      message: `defaultConnectionTag "${tag}" is not a tag in this library.`,
    });

    return undefined;
  }

  if (elementKindOf(schema) !== 'connection') {
    issues.push({
      rule: LINT_RULE.DEFAULT_CONNECTION_TAG,
      template: tag,
      message: `defaultConnectionTag "${tag}" is not a connection-kind tag.`,
    });

    return undefined;
  }

  return tag;
}

/** Top-level property names of a template's schema — the allowed placeholder heads. */
function propsOf(schema: object | undefined): string[] {
  const properties = (schema as { properties?: Record<string, unknown> } | undefined)?.properties;

  return properties ? Object.keys(properties) : [];
}

/**
 * Pointers (`/prop`, or with a `*` segment per array level) whose values are css-color-typed or
 * number-typed — the only props a template's `--er-` style binding may substitute (see lint.ts
 * VAR_BINDING_DECL). An `x-palette` prop qualifies: both arms of its union land in the CSS-color
 * domain — a token is translated to a palette color checked at boot, a raw value passes the same
 * grammar as `x-css-color` — so what a template binds is always one validated color.
 */
function styleBindablePointersOf(schema: object | undefined): Set<string> {
  const pointers = new Set<string>();

  if (!schema) {
    return pointers;
  }

  walkSchema(schema, (node, pointer) => {
    if (
      pointer !== '' &&
      (node[CSS_COLOR_KEYWORD] === true ||
        node[PALETTE_KEYWORD] === true ||
        node['type'] === 'number')
    ) {
      pointers.add(pointer);
    }
  });

  return pointers;
}

/**
 * Schema pointers carrying an `x-content` policy — the content-in-attribute rule forbids these
 * (and any path containing them) in attribute position. Applies to tag and sub-template schemas.
 */
function contentPointersOf(schema: object | undefined): Set<string> {
  const pointers = new Set<string>();

  if (!schema) {
    return pointers;
  }

  for (const entry of walkPolicies(schema)) {
    if (entry.kind === 'content') {
      pointers.add(entry.pointer);
    }
  }

  return pointers;
}
