// Template validation: the markup/CSS linter that proves an authored library's templates are ones
// this engine can run. `createResolver` runs `prepareLibrary` at boot; the rest is exported for
// library authors' own tooling and tests. Tag schemas are checked separately, in `schema/`.
export { prepareLibrary, RegistryError } from './prepare.js';
export {
  lintTemplate,
  LINT_RULE,
  type LintRule,
  type LintIssue,
  type LintContext,
} from './lint.js';
export { parseTemplate, ParseError, type ParsedTemplate } from './parse.js';
export { mergeTemplates } from './merge.js';
