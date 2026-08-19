import type { TemplateFile } from '@eraserlabs/protocol';
import type { ElementKind } from '@eraserlabs/protocol/schema';
import type { ValidationResult, ResolveResult, RegistryInfo } from './result-types.js';
import type { PolicyKind, ContentPolicy } from './schema/keywords.js';
import type { ElementNormalizer } from './pipeline/derive.js';

/**
 * Loads one icon's raw SVG source by name. Rejects (or throws) when the icon does not exist or
 * cannot be fetched — the pipeline maps failures onto the `onUnknownIcon` policy. Results are
 * sanitized and cached (including negative entries) at the resolver level, so a loader is only
 * consulted once per name.
 */
export type IconLoader = (name: string) => Promise<string>;

/** A template library as authored: schemas, raw markup + CSS. */
export interface AuthoredLibrary {
  /** Emission order. */
  manifest: readonly string[];
  /** Dispatchable per-tag schemas. */
  schemas: Record<string, object>;
  templates: TemplateFile[];
  /** Shared CSS applied before per-template rules. */
  baseCss: string;
  /**
   * Sub-template schemas by name, absent when the library has none. Sub-templates are exempt from
   * the one-body rule and are not dispatch targets; their allowed placeholders and content policies
   * derive from these schemas, exactly as tag templates derive from `schemas`.
   */
  subTemplates?: Record<string, object>;
  /**
   * The library's named colors: token name → ONE css color. A prop annotated `x-palette` accepts
   * either a token name — translated to its color in place during resolution — or a raw CSS color.
   * Boot rejects a token name outside the identifier charset or a value outside the strict
   * CSS-color grammar, and rejects `x-palette` in a library that declares no palette.
   *
   * Data like the rest of `AuthoredLibrary`: it serializes, and nothing executes it — while
   * every token is live authoring vocabulary, translated to its color during resolution.
   */
  palette?: Record<string, string>;
  /**
   * The tag dispatched for a connection that omits `tag` in the split `{ entities, connections }`
   * form — the common case has exactly one connection kind, so authors (and LLMs) can write
   * `{ "from": "a", "to": "b" }` and nothing else. Boot rejects a name that is not a
   * connection-kind tag in this library. Only the split form defaults: in the `{ elements }`
   * form the list carries no kind, so `tag` stays required there.
   */
  defaultConnectionTag?: string;
}

/** Architect overrides: template files that replace library entries by name. */
export interface TemplateOverrides {
  templates: TemplateFile[];
}

/** One template, already parsed and linted. */
export interface PreparedTemplate {
  name: string;
  html: string;
  /**
   * The template's bare-selector CSS ('' when the template has none). Isolation is the render
   * stage's job: it confines this CSS to the template's mount hosts via a generated @scope block.
   */
  css: string;
}

/** An authored library once `prepareLibrary` has checked it: the render stage's page-setup source. */
export interface TemplateLibrary {
  /** Emission order. */
  manifest: readonly string[];
  /** Per-tag plain JSON Schema objects. */
  schemas: Record<string, object>;
  templates: PreparedTemplate[];
  /** Shared CSS applied before per-template rules. */
  baseCss: string;
  /**
   * The checked palette as a null-prototype token → color map, absent when the library declares
   * none. Resolution reads it; the render stage never does — every palette token is translated to
   * its color before a payload exists.
   */
  palette?: Record<string, string>;
  /** The checked default connection tag, absent when the library declares none. */
  defaultConnectionTag?: string;
}

export interface ResolverSetup {
  /**
   * The authored template library this resolver validates against and emits from. `createResolver`
   * checks its schemas and lints its templates at boot, throwing `RegistryError` on any issue — so
   * no resolver can exist over a library the engine has not proven it can run.
   */
  library: AuthoredLibrary;
  /** Template files that replace library entries by name, merged before the lint pass. */
  overrides?: TemplateOverrides;
  /** Without a loader every icon name is unknown and the `onUnknownIcon` policy applies. */
  iconLoader?: IconLoader;
  onUnknownIcon?: 'placeholder' | 'error';
  /**
   * Per-tag derived-prop normalizers, applied to each validated element clone after the
   * schema-annotation canonicalization pass (`x-palette`) and before the
   * cross-ref / sanitize / icon / color stages (see derive.ts for the authoring contract).
   */
  normalizers?: Record<string, ElementNormalizer>;
}

/** One resolved per-prop policy, produced by the boot-time schema walk. */
export interface PolicyEntry {
  /** Path template relative to an element root, e.g. '/texts/*' then '/text'. `*` matches any array index. */
  pointer: string;
  kind: PolicyKind;
  /** Only set when kind === 'content'. */
  contentPolicy?: ContentPolicy;
}

/**
 * One resolved element's pristine authored source, correlated to the id every later stage and the
 * layout results are keyed by. The clone the pipeline mutates is a separate object, so this stays
 * exactly what the author submitted — the basis of the measured-JSON purity invariant.
 */
export interface AuthoredRecord {
  /** The resolved id: authored for entities, possibly synthesized for connections. */
  id: string;
  kind: ElementKind;
  /** The submitted element object itself. Never mutated by the pipeline. */
  source: Record<string, unknown>;
}

export interface Resolver {
  /** The checked library, in the shape the render stage's page setup consumes. */
  readonly library: TemplateLibrary;
  /**
   * Both methods take the untrusted candidate element array as `unknown` — the pipeline is the
   * proof that turns it into typed output. `validate` never calls the icon loader (icon existence
   * is checked against the cache only).
   */
  validate(input: unknown): Promise<ValidationResult>;
  resolve(input: unknown): Promise<ResolveResult>;
  registryInfo(): RegistryInfo;
  tagSchema(tag: string): object | undefined;
}
