import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import tagSchemaMeta from '@eraserlabs/protocol/schemas/tag-schema' with { type: 'json' };
import {
  CONTENT_KEYWORD,
  CSS_COLOR_KEYWORD,
  ELEMENT_KIND_KEYWORD,
  CONTAINER_KEYWORD,
  ICON_NAME_KEYWORD,
  REF_KEYWORD,
  PALETTE_KEYWORD,
  type ElementKind,
} from '@eraserlabs/protocol/schema';

type SchemaNode = Record<string, unknown>;

export interface SchemaDefinitionIssue {
  /** JSON Pointer into the invalid schema. */
  path: string;
  keyword: string;
  message: string;
}

/** Boot-time failure: a supplied tag schema is not in the MDP subset or violates core semantics. */
export class SchemaDefinitionError extends TypeError {
  constructor(
    readonly tag: string,
    readonly issues: readonly SchemaDefinitionIssue[],
  ) {
    super(
      `Invalid MDP schema for tag "${tag}":\n${issues
        .map((issue) => `  ${issue.path}: ${issue.message}`)
        .join('\n')}`,
    );
    this.name = 'SchemaDefinitionError';
  }
}

// The subset definition is itself data published by @eraserlabs/protocol. Compile it once when this
// module boots; every resolver can then validate user-supplied schemas before compiling requests.
const definitionAjv = new Ajv({ allErrors: true, strict: true });
const validateSubset = definitionAjv.compile(tagSchemaMeta) as ValidateFunction<unknown>;

export function assertValidTagSchema(
  tag: string,
  candidate: unknown,
  hasPalette = false,
): asserts candidate is object {
  if (!validateSubset(candidate)) {
    throw new SchemaDefinitionError(tag, (validateSubset.errors ?? []).map(formatSubsetIssue));
  }

  const issues = semanticIssues(tag, candidate as SchemaNode, hasPalette);

  if (issues.length > 0) {
    throw new SchemaDefinitionError(tag, issues);
  }
}

function formatSubsetIssue(error: ErrorObject): SchemaDefinitionIssue {
  if (error.keyword === 'additionalProperties') {
    const property = String(error.params['additionalProperty']);

    return {
      path: `${error.instancePath}/${escapePointer(property)}` || '/',
      keyword: error.keyword,
      message: `unsupported keyword "${property}"`,
    };
  }

  return {
    path: error.instancePath || '/',
    keyword: error.keyword,
    message: error.message ?? 'invalid schema definition',
  };
}

function semanticIssues(
  tag: string,
  root: SchemaNode,
  hasPalette: boolean,
): SchemaDefinitionIssue[] {
  const issues: SchemaDefinitionIssue[] = [];
  const properties = root['properties'] as Record<string, SchemaNode>;
  const required = new Set(root['required'] as string[]);
  const kind = root[ELEMENT_KIND_KEYWORD] as ElementKind;

  requireProperty(required, 'tag', issues);
  requireTagProperty(tag, properties['tag'], issues);
  requireStringProperty('/properties/id', properties['id'], issues, { minLength: true });

  for (const name of required) {
    if (!Object.hasOwn(properties, name)) {
      add(
        issues,
        '/required',
        'required',
        `required property "${name}" is not declared in properties`,
      );
    }
  }

  if (kind === 'entity') {
    requireProperty(required, 'id', issues);

    for (const property of ['x', 'y', 'width', 'height']) {
      requireGeometryProperty(property, properties[property], issues);
    }

    if (properties['from'] !== undefined || properties['to'] !== undefined) {
      add(
        issues,
        '/properties',
        ELEMENT_KIND_KEYWORD,
        'entity schemas may not declare the connection-owned from/to properties',
      );
    }

    requireContainerProperty(properties['containerId'], required, issues);
    requireIsContainerProperty(properties['isContainer'], required, issues);
  } else {
    for (const property of ['x', 'y']) {
      requireGeometryProperty(property, properties[property], issues);

      if (required.has(property)) {
        add(
          issues,
          '/required',
          'required',
          `connection origin property "${property}" must remain optional`,
        );
      }
    }

    for (const property of ['width', 'height']) {
      if (properties[property] !== undefined || required.has(property)) {
        add(
          issues,
          `/properties/${property}`,
          ELEMENT_KIND_KEYWORD,
          `connection schemas may not declare the entity-owned ${property} property`,
        );
      }
    }

    requireProperty(required, 'from', issues);
    requireProperty(required, 'to', issues);
    requireStringProperty('/properties/from', properties['from'], issues, {
      minLength: true,
      reference: true,
    });
    requireStringProperty('/properties/to', properties['to'], issues, {
      minLength: true,
      reference: true,
    });

    if (properties['containerId'] !== undefined || required.has('containerId')) {
      add(
        issues,
        '/properties/containerId',
        ELEMENT_KIND_KEYWORD,
        'connection schemas may not declare containerId',
      );
    }

    if (properties['isContainer'] !== undefined || required.has('isContainer')) {
      add(
        issues,
        '/properties/isContainer',
        ELEMENT_KIND_KEYWORD,
        'connection schemas may not declare isContainer',
      );
    }

    if (root[CONTAINER_KEYWORD] !== undefined) {
      add(
        issues,
        `/${CONTAINER_KEYWORD}`,
        CONTAINER_KEYWORD,
        'connection schemas may not declare x-is-container',
      );
    }
  }

  visitNode(root, '', true, hasPalette, issues);

  return issues;
}

function requireProperty(
  required: ReadonlySet<string>,
  property: string,
  issues: SchemaDefinitionIssue[],
): void {
  if (!required.has(property)) {
    add(issues, '/required', 'required', `must include core property "${property}"`);
  }
}

function requireTagProperty(
  tag: string,
  schema: SchemaNode | undefined,
  issues: SchemaDefinitionIssue[],
): void {
  if (!schema) {
    add(issues, '/properties/tag', 'properties', 'must declare the core tag property');

    return;
  }

  if (schema['type'] !== 'string') {
    add(issues, '/properties/tag/type', 'type', 'must be "string"');
  }

  if (schema['const'] !== tag) {
    add(issues, '/properties/tag/const', 'const', `must equal its registry key "${tag}"`);
  }
}

interface StringPropertyOptions {
  minLength?: boolean;
  reference?: boolean;
}

function requireStringProperty(
  path: string,
  schema: SchemaNode | undefined,
  issues: SchemaDefinitionIssue[],
  options: StringPropertyOptions = {},
): void {
  if (!schema) {
    add(issues, path, 'properties', 'must declare this core string property');

    return;
  }

  if (schema['type'] !== 'string') {
    add(issues, `${path}/type`, 'type', 'must be "string"');
  }

  if (options.minLength && !(typeof schema['minLength'] === 'number' && schema['minLength'] >= 1)) {
    add(issues, `${path}/minLength`, 'minLength', 'must be at least 1');
  }

  if (options.reference && schema[REF_KEYWORD] !== 'element') {
    add(issues, `${path}/${REF_KEYWORD}`, REF_KEYWORD, 'must be "element"');
  }
}

function requireGeometryProperty(
  property: string,
  schema: SchemaNode | undefined,
  issues: SchemaDefinitionIssue[],
): void {
  const path = `/properties/${property}`;

  if (!schema) {
    add(issues, path, 'properties', 'must declare optional MDP geometry');

    return;
  }

  if (schema['type'] !== 'number') {
    add(issues, `${path}/type`, 'type', 'must be "number"');
  }

  if (schema['minimum'] !== 0) {
    add(issues, `${path}/minimum`, 'minimum', 'must be 0');
  }

  if (schema['default'] !== undefined) {
    add(
      issues,
      `${path}/default`,
      'default',
      'geometry properties may not declare a default; absence is distinct from zero',
    );
  }
}

function requireContainerProperty(
  schema: SchemaNode | undefined,
  required: ReadonlySet<string>,
  issues: SchemaDefinitionIssue[],
): void {
  const path = '/properties/containerId';

  if (!schema) {
    add(issues, path, 'properties', 'entity schemas must declare optional nullable containment');

    return;
  }

  if (schema[REF_KEYWORD] !== 'element') {
    add(issues, `${path}/${REF_KEYWORD}`, REF_KEYWORD, 'must be "element"');
  }

  const types = possibleTypes(schema);

  if (!types || !types.has('string') || !types.has('null') || types.size !== 2) {
    add(issues, path, 'anyOf', 'must accept exactly a non-empty string or null');
  }

  const stringBranch = Array.isArray(schema['anyOf'])
    ? (schema['anyOf'] as SchemaNode[]).find((branch) => branch['type'] === 'string')
    : undefined;

  if (!(typeof stringBranch?.['minLength'] === 'number' && stringBranch['minLength'] >= 1)) {
    add(
      issues,
      `${path}/anyOf`,
      'minLength',
      'the string branch must have minLength of at least 1',
    );
  }

  if (required.has('containerId')) {
    add(issues, '/required', 'required', 'containerId must remain optional');
  }
}

function requireIsContainerProperty(
  schema: SchemaNode | undefined,
  required: ReadonlySet<string>,
  issues: SchemaDefinitionIssue[],
): void {
  const path = '/properties/isContainer';

  if (required.has('isContainer')) {
    add(issues, '/required', 'required', 'isContainer must remain optional');
  }

  if (!schema) {
    return;
  }

  if (schema['type'] !== 'boolean') {
    add(issues, `${path}/type`, 'type', 'must be "boolean"');
  }
}

function visitNode(
  node: SchemaNode,
  pointer: string,
  isRoot: boolean,
  hasPalette: boolean,
  issues: SchemaDefinitionIssue[],
): void {
  if (!isRoot && node[ELEMENT_KIND_KEYWORD] !== undefined) {
    add(
      issues,
      `${pointer}/${ELEMENT_KIND_KEYWORD}`,
      ELEMENT_KIND_KEYWORD,
      'is only allowed on the tag-schema root',
    );
  }

  if (!isRoot && node[CONTAINER_KEYWORD] !== undefined) {
    add(
      issues,
      `${pointer}/${CONTAINER_KEYWORD}`,
      CONTAINER_KEYWORD,
      'is only allowed on the tag-schema root',
    );
  }

  requireAnnotationTypes(node, pointer, hasPalette, issues);
  requireDefault(node, pointer, isRoot, issues);

  if (typeof node['minItems'] === 'number' && typeof node['maxItems'] === 'number') {
    if (node['minItems'] > node['maxItems']) {
      add(issues, pointer || '/', 'minItems', 'minItems may not exceed maxItems');
    }
  }

  const properties = node['properties'];
  const requiredNames = Array.isArray(node['required'])
    ? (node['required'] as unknown[]).filter((n): n is string => typeof n === 'string')
    : [];
  const required = new Set(requiredNames);

  if (isRecord(properties)) {
    for (const [name, child] of Object.entries(properties)) {
      if (isRecord(child)) {
        if (required.has(name) && child['default'] !== undefined) {
          add(
            issues,
            `${pointer}/properties/${escapePointer(name)}/default`,
            'default',
            'may not annotate a required property',
          );
        }

        visitNode(child, `${pointer}/properties/${escapePointer(name)}`, false, hasPalette, issues);
      }
    }
  }

  const anyOf = node['anyOf'];

  if (Array.isArray(anyOf)) {
    anyOf.forEach((child, index) => {
      if (isRecord(child)) {
        visitNode(child, `${pointer}/anyOf/${index}`, false, hasPalette, issues);
      }
    });
  }

  const not = node['not'];

  if (isRecord(not)) {
    visitNode(not, `${pointer}/not`, false, hasPalette, issues);
  }

  const items = node['items'];

  if (Array.isArray(items)) {
    items.forEach((child, index) => {
      if (isRecord(child)) {
        visitNode(child, `${pointer}/items/${index}`, false, hasPalette, issues);
      }
    });
  } else if (isRecord(items)) {
    visitNode(items, `${pointer}/items`, false, hasPalette, issues);
  }
}

function requireAnnotationTypes(
  node: SchemaNode,
  pointer: string,
  hasPalette: boolean,
  issues: SchemaDefinitionIssue[],
): void {
  const types = possibleTypes(node);

  for (const keyword of [CONTENT_KEYWORD, CSS_COLOR_KEYWORD, ICON_NAME_KEYWORD, PALETTE_KEYWORD]) {
    if (node[keyword] !== undefined && (!types || types.size !== 1 || !types.has('string'))) {
      add(
        issues,
        `${pointer}/${keyword}`,
        keyword,
        'may only annotate a schema that accepts strings',
      );
    }
  }

  if (
    node[REF_KEYWORD] !== undefined &&
    (!types ||
      !types.has('string') ||
      [...types].some((type) => type !== 'string' && type !== 'null'))
  ) {
    add(
      issues,
      `${pointer}/${REF_KEYWORD}`,
      REF_KEYWORD,
      'may only annotate a string or nullable-string schema',
    );
  }

  if (node[PALETTE_KEYWORD] !== undefined) {
    if (!hasPalette) {
      add(
        issues,
        `${pointer}/${PALETTE_KEYWORD}`,
        PALETTE_KEYWORD,
        'requires the library to declare a palette',
      );
    }

    if (node[CSS_COLOR_KEYWORD] !== undefined) {
      add(
        issues,
        `${pointer}/${PALETTE_KEYWORD}`,
        PALETTE_KEYWORD,
        `may not be combined with ${CSS_COLOR_KEYWORD} on the same schema`,
      );
    }
  }
}

function requireDefault(
  node: SchemaNode,
  pointer: string,
  isRoot: boolean,
  issues: SchemaDefinitionIssue[],
): void {
  if (node['default'] === undefined) {
    return;
  }

  const path = `${pointer}/default`;

  if (isRoot) {
    add(issues, path, 'default', 'is only allowed on properties, not the tag schema root');

    return;
  }

  if (!instanceSatisfies(node, node['default'])) {
    add(issues, path, 'default', 'must be a valid instance of this schema');
  }
}

/** Whether a scalar `default` would validate against this node (type / enum / const / anyOf). */
function instanceSatisfies(node: SchemaNode, value: unknown): boolean {
  if (Array.isArray(node['anyOf'])) {
    return (node['anyOf'] as unknown[]).some(
      (branch) => isRecord(branch) && instanceSatisfies(branch, value),
    );
  }

  if (typeof node['const'] === 'string') {
    return value === node['const'];
  }

  if (Array.isArray(node['enum'])) {
    return (node['enum'] as unknown[]).includes(value);
  }

  const type = node['type'];

  if (type === 'string') {
    if (typeof value !== 'string') {
      return false;
    }

    if (typeof node['minLength'] === 'number' && value.length < node['minLength']) {
      return false;
    }

    if (typeof node['pattern'] === 'string') {
      try {
        return new RegExp(node['pattern']).test(value);
      } catch {
        return false;
      }
    }

    return true;
  }

  if (type === 'number') {
    return (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      (typeof node['minimum'] !== 'number' || value >= node['minimum'])
    );
  }

  if (type === 'boolean') {
    return typeof value === 'boolean';
  }

  if (type === 'null') {
    return value === null;
  }

  return false;
}

/**
 * The exact string vocabulary a string/number schema accepts, or `undefined` when a string branch
 * is unconstrained (a free string admits tokens no map could cover).
 */
function enumeratedStrings(node: SchemaNode): Set<string> | undefined {
  if (Array.isArray(node['enum'])) {
    return new Set((node['enum'] as unknown[]).filter((v): v is string => typeof v === 'string'));
  }

  if (typeof node['const'] === 'string') {
    return new Set([node['const']]);
  }

  if (node['type'] === 'number') {
    return new Set();
  }

  if (node['type'] === 'string') {
    return undefined;
  }

  if (!Array.isArray(node['anyOf'])) {
    return undefined;
  }

  const tokens = new Set<string>();

  for (const branch of node['anyOf']) {
    if (!isRecord(branch)) {
      return undefined;
    }

    const branchTokens = enumeratedStrings(branch);

    if (!branchTokens) {
      return undefined;
    }

    for (const token of branchTokens) {
      tokens.add(token);
    }
  }

  return tokens;
}

function possibleTypes(node: SchemaNode): Set<string> | undefined {
  if (typeof node['type'] === 'string') {
    return new Set([node['type']]);
  }

  if (typeof node['const'] === 'string' || Array.isArray(node['enum'])) {
    return new Set(['string']);
  }

  if (!Array.isArray(node['anyOf'])) {
    return undefined;
  }

  const types = new Set<string>();

  for (const branch of node['anyOf']) {
    if (!isRecord(branch)) {
      return undefined;
    }

    const branchTypes = possibleTypes(branch);

    if (!branchTypes) {
      return undefined;
    }

    for (const type of branchTypes) {
      types.add(type);
    }
  }

  return types;
}

function add(
  issues: SchemaDefinitionIssue[],
  path: string,
  keyword: string,
  message: string,
): void {
  issues.push({ path: path || '/', keyword, message });
}

function isRecord(value: unknown): value is SchemaNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapePointer(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}
