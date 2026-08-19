export {
  stockLibrary,
  MANIFEST,
  tagSchemas,
  subTemplateSchemas,
  templateProps,
} from './library/index.js';
export { stockNormalizers } from './library/normalizers.js';
export { buildRenderPageSetup } from './library/pageSetup.js';
export {
  createEraserIconLoader,
  ERASER_ICON_BASE_URL,
  type EraserIconLoaderOptions,
} from './icons/eraserLoader.js';
export {
  sanitizeSvgString,
  normalizeToCurrentColor,
  ensureViewBox,
  inlineStyleClasses,
  normalizeFetchedIcon,
  uniquifyIds,
} from './icons/svgTransforms.js';
export { stageFonts, type StagedFonts, type StagedFontFace } from './fonts/staging.js';
export { eraserFonts } from './fonts/eraserFonts.js';
export { injectFonts } from './fonts/inject.js';
export type {
  AuthoredElement,
  AuthoredEntity,
  AuthoredConnection,
  DiagramInput,
} from '@eraserlabs/resolve';
export {
  createRenderer,
  type BrowserProvider,
  type RendererOptions,
  type Renderer,
  type RenderRequest,
  type OutputRequest,
  type DiagramJson,
  type DiagramJsonElement,
  type RenderSuccess,
  type RenderOutcome,
  type RenderFailure,
} from './diagrams.js';

// The consumer surface of the underlying engine packages, re-exported so `@eraserlabs/diagrams` is the
// only import most users need: authoring a library, composing tag schemas, and naming the types
// the API above takes and returns. Curated on purpose — engine internals (pipeline stages, lint
// and parse machinery, browser-page plumbing) stay behind deep imports from `@eraserlabs/resolve`,
// `@eraserlabs/render`, and `@eraserlabs/protocol`, which keep working unchanged.

// Library authoring: assemble, merge, and validate a template library.
export {
  prepareLibrary,
  mergeTemplates,
  RegistryError,
  type AuthoredLibrary,
  type TemplateOverrides,
  type TemplateLibrary,
  type PreparedTemplate,
} from '@eraserlabs/resolve';

// Schema authoring: compose tag schemas and annotate their properties.
export {
  entitySchema,
  connectionSchema,
  elementKindOf,
  isContainerTag,
  CssColor,
  type JsonSchema,
  type TagSchemaOptions,
  type EntitySchemaOptions,
  type ElementKind,
  type ContentPolicy,
} from '@eraserlabs/protocol/schema';

// Templates and fonts as data.
export type { TemplateFile, FontsConfig, FontRoles, FontSource } from '@eraserlabs/protocol';

// Results, issues, and the callback shapes `RendererOptions` and `Renderer` are written against.
export {
  ERROR_CODE,
  WARNING_CODE,
  SEVERITY,
  type Issue,
  type IssueCode,
  type ErrorCode,
  type WarningCode,
  type Severity,
  type ValidationResult,
  type RegistryInfo,
  type TagInfo,
  type IconLoader,
  type ElementNormalizer,
} from '@eraserlabs/resolve';
