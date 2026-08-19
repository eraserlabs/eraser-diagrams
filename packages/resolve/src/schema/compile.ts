import { Ajv, type ValidateFunction } from 'ajv';
import type { PolicyEntry } from '../types.js';
import { elementKindOf, isContainerTag, type ElementKind } from '@eraserlabs/protocol/schema';
import {
  registerMetadataKeywords,
  CONTENT_KEYWORD,
  CSS_COLOR_KEYWORD,
  ICON_NAME_KEYWORD,
  REF_KEYWORD,
  PALETTE_KEYWORD,
  type ContentPolicy,
} from './keywords.js';
import { walkSchema } from './walk.js';
import { assertValidTagSchema } from './definition.js';

export interface CompiledSchemas {
  /** Null-prototype map tag → validator (Object.create(null) to resist prototype pollution). */
  validators: Record<string, ValidateFunction>;
  /** Null-prototype map tag → per-prop policy entries (iterated by stages 4–7). */
  policyTables: Record<string, PolicyEntry[]>;
  rawSchemas: Record<string, object>;
  /** Tag classification declared once on each schema root. */
  kinds: Record<string, ElementKind>;
  /** Tags whose schema declares `x-is-container`. */
  containers: ReadonlySet<string>;
}

export function createAjv(): Ajv {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    allowUnionTypes: true,
    removeAdditional: false,
    // Schema `default` fills missing props on the validated clone. Present values, including
    // `null`, are left alone — so an explicit opt-out is distinct from an omitted field.
    useDefaults: true,
  });

  registerMetadataKeywords(ajv);

  return ajv;
}

/**
 * `hasPalette` reaches the schema check because `x-palette` is the one annotation whose validity
 * depends on the rest of the library: the keyword promises a token vocabulary, and a library with
 * no palette has none to promise.
 */
export function compileSchemas(
  schemas: Record<string, object>,
  hasPalette = false,
): CompiledSchemas {
  const ajv = createAjv();
  const validators: Record<string, ValidateFunction> = Object.create(null);
  const policyTables: Record<string, PolicyEntry[]> = Object.create(null);
  const rawSchemas: Record<string, object> = Object.create(null);
  const kinds: Record<string, ElementKind> = Object.create(null);
  const containers = new Set<string>();

  for (const [tag, schema] of Object.entries(schemas)) {
    assertValidTagSchema(tag, schema, hasPalette);
    const kind = elementKindOf(schema);

    if (!kind) {
      throw new TypeError(`schema for tag "${tag}" must declare x-schema-kind`);
    }

    validators[tag] = ajv.compile(withEntityIsContainer(schema, kind));
    policyTables[tag] = walkPolicies(schema);
    rawSchemas[tag] = schema;
    kinds[tag] = kind;

    if (isContainerTag(schema)) {
      containers.add(tag);
    }
  }

  return { validators, policyTables, rawSchemas, kinds, containers };
}

/**
 * Entity authors may set `isContainer` even when the tag schema omitted the property.
 * Compile a copy that admits the boolean so `additionalProperties: false` does not reject it.
 * Container tags also default the property to true — the same auto-fill as `x-is-container`.
 */
function withEntityIsContainer(schema: object, kind: ElementKind): object {
  if (kind !== 'entity') {
    return schema;
  }

  const root = schema as Record<string, unknown>;
  const properties = root['properties'];

  if (
    typeof properties !== 'object' ||
    properties === null ||
    Array.isArray(properties) ||
    Object.hasOwn(properties, 'isContainer')
  ) {
    return schema;
  }

  return {
    ...root,
    properties: {
      ...properties,
      isContainer: {
        type: 'boolean',
        ...(isContainerTag(schema) ? { default: true } : {}),
      },
    },
  };
}

/** Walk a per-tag JSON schema, collecting policy entries keyed by pointer template (relative to element). */
export function walkPolicies(schema: object): PolicyEntry[] {
  const entries: PolicyEntry[] = [];

  // Metadata keywords sit on the (string) node they annotate.
  walkSchema(schema, (node, pointer) => {
    if (typeof node[CONTENT_KEYWORD] === 'string') {
      entries.push({
        pointer,
        kind: 'content',
        contentPolicy: node[CONTENT_KEYWORD] as ContentPolicy,
      });
    }

    if (node[CSS_COLOR_KEYWORD] === true) {
      entries.push({ pointer, kind: 'css-color' });
    }

    if (node[ICON_NAME_KEYWORD] === true) {
      entries.push({ pointer, kind: 'icon-name' });
    }

    if (typeof node[REF_KEYWORD] === 'string') {
      entries.push({ pointer, kind: 'ref' });
    }

    if (node[PALETTE_KEYWORD] === true) {
      // Two entries on purpose. The palette entry translates a token before anything reads the
      // prop; the css-color entry keeps the post-derive safety net every colour prop has, so a
      // normalizer that writes into an `x-palette` slot is validated exactly like authored input.
      entries.push({ pointer, kind: 'palette' });
      entries.push({ pointer, kind: 'css-color' });
    }
  });

  return entries;
}
