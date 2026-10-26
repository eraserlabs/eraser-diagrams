import type {
  ValidationResult,
  ResolveResult,
  RegistryInfo,
  Issue,
  TagInfo,
} from './result-types.js';
import type { Resolver, ResolverSetup, ResolveOptions } from './types.js';
import { compileSchemas } from './schema/compile.js';
import { prepareLibrary } from './library/prepare.js';
import { normalizeInput } from './pipeline/input.js';
import { processElements, type PipelineElement } from './pipeline/element.js';
import { normalizeAnnotatedProps, roundAuthoredGeometry } from './pipeline/normalize.js';
import { deriveProps } from './pipeline/derive.js';
import { assignMissingConnectionIds } from './pipeline/identity.js';
import { stageCrossref } from './pipeline/crossref.js';
import { buildSanitizers, stageSanitize } from './pipeline/sanitize.js';
import { stageColors } from './pipeline/colors.js';
import { applyColorTheme } from './pipeline/theme.js';
import {
  stageIcons,
  stageIconsForLayout,
  type IconMode,
  type IconCache,
  type IconStageResult,
} from './pipeline/icons.js';
import { buildResolvedPayload } from './pipeline/emit.js';
import { TimeTracker } from '@eraserlabs/utils';

export type {
  Resolver,
  ResolverSetup,
  ResolveOptions,
  CodeHighlighter,
  HighlightedRun,
  AuthoredLibrary,
  AuthoredRecord,
  TemplateOverrides,
  TemplateLibrary,
  PreparedTemplate,
  IconLoader,
} from './types.js';
export type {
  AuthoredElement,
  AuthoredEntity,
  AuthoredConnection,
  DiagramInput,
} from './authored.js';
export {
  prepareLibrary,
  RegistryError,
  lintTemplate,
  LINT_RULE,
  parseTemplate,
  ParseError,
  mergeTemplates,
  type LintRule,
  type LintIssue,
  type LintContext,
  type ParsedTemplate,
} from './library/index.js';
export {
  isTextRun,
  primaryTextRun,
  type ElementNormalizer,
  type TextRun,
} from './pipeline/derive.js';
export { NAMED_COLOR_HEX, colorToHex, colorToRgba, type RgbaColor } from './pipeline/colors.js';
export { scaleColorForTheme, setColorLightness, type Theme } from './colors/theme.js';
export { planFontStaging, type FontStagingPlan, type FontFetch } from './fonts/setup.js';
export { buildFontsHead, fontFaceRule, cssQuoted } from './fonts/head.js';
export type { FontsConfig, FontSource } from '@eraserlabs/protocol';
export {
  ERROR_CODE,
  WARNING_CODE,
  SEVERITY,
  type ErrorCode,
  type WarningCode,
  type IssueCode,
  type Severity,
  type Issue,
  type ResolveMeta,
  type ResolveResult,
  type ValidationResult,
  type TagInfo,
  type RegistryInfo,
} from './result-types.js';
export { SchemaDefinitionError, type SchemaDefinitionIssue } from './schema/definition.js';

interface PipelineOutput {
  errors: Issue[];
  warnings: Issue[];
  elements: PipelineElement[];
  iconsInlined: number;
  icons: Record<string, string>;
  tracker: TimeTracker;
}

/** The pipeline's checks done (everything before the icon stage); `empty` when nothing was submitted. */
interface Checked {
  errors: Issue[];
  warnings: Issue[];
  elements: PipelineElement[];
  tracker: TimeTracker;
  empty: boolean;
}

/**
 * Warm set-up. All expensive work (library check, schema compile, policy-table build, sanitizer
 * construction) happens here, once, so the per-call path stays light (Constitution VI). A library
 * that fails the check throws `RegistryError` before any validator is compiled. Icons load lazily
 * via the injected loader and stick in a resolver-level cache (negative entries included).
 */
export async function createResolver(setup: ResolverSetup): Promise<Resolver> {
  const library = prepareLibrary(setup.library, setup.overrides);
  const compiled = compileSchemas(
    library.schemas,
    library.palette !== undefined,
    library.renderProps,
  );
  const knownTags = Object.keys(compiled.validators);
  const onUnknownIcon = setup.onUnknownIcon ?? 'placeholder';

  const sanitizers = buildSanitizers(setup.highlightCode);
  const iconCache: IconCache = new Map();

  const registry = {
    knownTags,
    validators: compiled.validators,
    rawSchemas: compiled.rawSchemas,
    kinds: compiled.kinds,
    ...(library.defaultConnectionTag !== undefined
      ? { defaultConnectionTag: library.defaultConnectionTag }
      : {}),
  };

  /** Every stage before the icons: parse, schema, crossref, sanitize. Synchronous. */
  function runChecks(input: unknown, options: ResolveOptions): Checked {
    const errors: Issue[] = [];
    const warnings: Issue[] = [];
    const tracker = new TimeTracker();

    // Argument parsing, not a stage: which arrays to iterate, and the pointer prefix each carries.
    const submitted = normalizeInput(input);
    errors.push(...submitted.errors);
    warnings.push(...submitted.warnings);

    if (submitted.lists.length === 0) {
      return { errors, warnings, elements: [], tracker, empty: true };
    }

    // One pass per element: forbidden-key scan, tag dispatch, schema check, kind classification.
    const pass = processElements(submitted.lists, registry);
    errors.push(...pass.errors);
    warnings.push(...pass.warnings);
    const elements = pass.elements;

    assignMissingConnectionIds(elements);

    for (const item of elements) {
      roundAuthoredGeometry(item.element);
      errors.push(
        ...normalizeAnnotatedProps(
          item,
          compiled.authoredPolicyTables[item.tag] ?? [],
          library.palette,
        ),
      );
      deriveProps(item.element, item.tag, setup.normalizers);
    }
    tracker.mark('schema');

    const crossref = stageCrossref(elements, compiled.policyTables, compiled.containers, options);
    errors.push(...crossref.errors);
    warnings.push(...crossref.warnings);
    tracker.mark('crossref');

    // Sanitize mutates the clones in place.
    const sanitize = stageSanitize(elements, compiled.policyTables, sanitizers);
    warnings.push(...sanitize.warnings);
    tracker.mark('sanitize');

    return { errors, warnings, elements, tracker, empty: false };
  }

  /** The stages after the icons (colors), and the pipeline's output. Synchronous. */
  function afterIcons(checked: Checked, iconStage: IconStageResult): PipelineOutput {
    const { errors, warnings, elements, tracker } = checked;
    errors.push(...iconStage.errors);
    warnings.push(...iconStage.warnings);
    tracker.mark('icons');

    const colors = stageColors(elements, compiled.policyTables);
    errors.push(...colors.errors);
    tracker.mark('colors');

    return {
      errors,
      warnings,
      elements,
      iconsInlined: iconStage.inlined,
      icons: iconStage.icons,
      tracker,
    };
  }

  async function runPipeline(
    input: unknown,
    mode: IconMode,
    options: ResolveOptions = {},
  ): Promise<PipelineOutput> {
    const checked = runChecks(input, options);
    if (checked.empty) {
      return { ...checked, iconsInlined: 0, icons: {} };
    }
    const iconStage = await stageIcons(
      checked.elements,
      compiled.policyTables,
      iconCache,
      setup.iconLoader,
      mode,
      onUnknownIcon,
    );
    return afterIcons(checked, iconStage);
  }

  /** The pipeline with every glyph the placeholder (stageIconsForLayout): no loading, so no await. */
  function runPipelineForLayout(input: unknown, options: ResolveOptions = {}): PipelineOutput {
    const checked = runChecks(input, options);
    if (checked.empty) {
      return { ...checked, iconsInlined: 0, icons: {} };
    }
    return afterIcons(checked, stageIconsForLayout(checked.elements, compiled.policyTables));
  }

  /** A pipeline output as the resolve result (both resolve entries). */
  function toResolveResult(output: PipelineOutput, options: ResolveOptions = {}): ResolveResult {
    const { errors, warnings, elements, iconsInlined, icons, tracker } = output;
    const ok = errors.length === 0;
    const result: ResolveResult = {
      ok,
      errors,
      warnings,
      meta: {
        elementCount: elements.length,
        iconsInlined,
        timingsMs: tracker.timings,
      },
    };

    if (ok) {
      // emit: resolved data only. Markup is the browser render stage's job.
      tracker.reset();
      applyColorTheme(elements, compiled.policyTables, options.theme ?? 'light');
      const payload = buildResolvedPayload(elements, compiled.containers);
      result.theme = options.theme ?? 'light';
      for (const element of [...payload.entities, ...payload.connections]) {
        element.theme = result.theme;
      }
      result.entities = payload.entities;
      result.connections = payload.connections;
      result.icons = icons;
      result.authored = elements.map(({ kind, element, source }) => ({
        id: element.id as string,
        kind,
        source,
      }));
      tracker.mark('emit');
    }

    return result;
  }

  const resolver: Resolver = {
    library,

    async validate(input: unknown, options?: ResolveOptions): Promise<ValidationResult> {
      const { errors, warnings } = await runPipeline(input, 'validate', options);

      return { ok: errors.length === 0, errors, warnings };
    },

    async resolve(input: unknown, options?: ResolveOptions): Promise<ResolveResult> {
      return toResolveResult(await runPipeline(input, 'resolve', options), options);
    },

    resolveForLayout(input: unknown, options?: ResolveOptions): ResolveResult {
      return toResolveResult(runPipelineForLayout(input, options), options);
    },

    registryInfo(): RegistryInfo {
      const tags: TagInfo[] = library.manifest
        .filter((t) => knownTags.includes(t))
        .map((tag) => ({
          tag,
          kind: compiled.kinds[tag]!,
          requiredProps: requiredProps(compiled.rawSchemas[tag]),
          ...(compiled.containers.has(tag) ? { container: true as const } : {}),
        }));

      return {
        tags,
        ...(library.defaultConnectionTag !== undefined
          ? { defaultConnectionTag: library.defaultConnectionTag }
          : {}),
      };
    },

    tagSchema(tag: string): object | undefined {
      return compiled.rawSchemas[tag];
    },
  };

  return resolver;
}

function requiredProps(schema: object | undefined): string[] {
  const required = (schema as { required?: unknown } | undefined)?.required;

  if (!Array.isArray(required)) {
    return [];
  }

  return (required as string[]).filter((p) => p !== 'tag');
}
