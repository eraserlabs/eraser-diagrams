export const ELEMENT_KINDS = ['entity', 'connection'] as const;
export type ElementKind = (typeof ELEMENT_KINDS)[number];

export type ContentPolicy = 'plain' | 'markdown' | 'inline-markdown' | 'html';
export type PolicyKind = 'content' | 'css-color' | 'icon-name' | 'ref' | 'palette';

export const ELEMENT_KIND_KEYWORD = 'x-schema-kind' as const;
export const CONTAINER_KEYWORD = 'x-is-container' as const;
export const CONTENT_KEYWORD = 'x-content' as const;
export const CSS_COLOR_KEYWORD = 'x-css-color' as const;
export const ICON_NAME_KEYWORD = 'x-icon-name' as const;
export const REF_KEYWORD = 'x-ref' as const;
export const PALETTE_KEYWORD = 'x-palette' as const;

/**
 * Token names a library `palette` may declare. Deliberately narrow: a token name is only ever an
 * object key and an error-message fragment, and keeping it to an identifier charset means no
 * profile can smuggle punctuation into a diagnostic or a serialized library.
 */
export const PALETTE_TOKEN_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** Per-property MDP annotations and the JSON type of each keyword's value. */
export const METADATA_KEYWORDS: Record<string, 'string' | 'boolean' | 'object'> = {
  [CONTENT_KEYWORD]: 'string',
  [CSS_COLOR_KEYWORD]: 'boolean',
  [ICON_NAME_KEYWORD]: 'boolean',
  [REF_KEYWORD]: 'string',
  [PALETTE_KEYWORD]: 'boolean',
};

/**
 * Closed JSON Schema subset supported by MDP 0.1. The interface catches unknown structural or MDP
 * annotation keys in TypeScript-authored schemas; serialized schemas are validated as data against
 * the published `@eraserlabs/protocol/schemas/tag-schema` meta-schema before request compilation.
 * `default` is the JSON Schema keyword: a scalar filled onto a missing property at resolve time.
 */
export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
  const?: string;
  enum?: string[];
  anyOf?: JsonSchema[];
  not?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema | JsonSchema[];
  additionalItems?: boolean;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  minimum?: number;
  pattern?: string;
  /** Filled onto a missing property during resolution. Never replaces `null` or a present value. */
  default?: string | number | boolean | null;
  'x-schema-kind'?: ElementKind;
  /** Entity tags only: members of this tag are containers. Absent means not a container. */
  'x-is-container'?: true;
  'x-content'?: ContentPolicy;
  'x-css-color'?: boolean;
  'x-icon-name'?: boolean;
  'x-ref'?: 'element';
  'x-palette'?: boolean;
}

/** A free string validated during resolution against the strict CSS-color grammar. */
export const CssColor: JsonSchema = { type: 'string', 'x-css-color': true };

/**
 * A free string that is either one of the library palette's token names — translated to that
 * token's color in place during resolution — or a raw CSS color in the strict grammar. Only
 * legal in a library that declares a `palette`.
 */
export const PaletteColor: JsonSchema = { type: 'string', 'x-palette': true };

/** Optional authored entity geometry. Connections use only the x/y subset. */
export const GeometryProperties: Record<string, JsonSchema> = {
  x: { type: 'number', minimum: 0 },
  y: { type: 'number', minimum: 0 },
  width: { type: 'number', minimum: 0 },
  height: { type: 'number', minimum: 0 },
};

/** Optional authored connection origin. Connection width/height are not MDP core fields. */
export const ConnectionPositionProperties: Record<string, JsonSchema> = {
  x: GeometryProperties['x']!,
  y: GeometryProperties['y']!,
};

/** Optional containment available only to entity schemas. */
export const EntityContainmentProperties: Record<string, JsonSchema> = {
  containerId: {
    anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
    'x-ref': 'element',
  },
  /** Per-entity container-ness. Tags with `x-is-container` default this to true. */
  isContainer: { type: 'boolean' },
};

/** Required endpoint references supplied by every connection schema. */
export const ConnectionEndpointProperties: Record<string, JsonSchema> = {
  from: { type: 'string', minLength: 1, 'x-ref': 'element' },
  to: { type: 'string', minLength: 1, 'x-ref': 'element' },
};

const CORE_PROPERTY_NAMES = new Set([
  'tag',
  'id',
  'x',
  'y',
  'width',
  'height',
  'containerId',
  'isContainer',
  'from',
  'to',
]);

export interface TagSchemaOptions {
  required?: string[];
}

export interface EntitySchemaOptions extends TagSchemaOptions {
  /**
   * Members of this tag are containers by default (`x-is-container`, and `isContainer` defaults
   * to true). An entity may still author `isContainer` to opt in or out.
   */
  isContainer?: boolean;
}

/** Compose a strict, dispatchable entity schema. A profile may require declared geometry. */
export function entitySchema(
  tag: string,
  props: Record<string, JsonSchema>,
  options: EntitySchemaOptions = {},
): JsonSchema {
  return tagSchema('entity', tag, props, options);
}

/**
 * Compose a strict connection schema. Endpoints are required; authored id and origin are optional;
 * connection bounds and containment are unavailable. Pass `required: ['id']` for a profile that
 * requires authors to supply connection ids instead of accepting resolver-generated identities.
 */
export function connectionSchema(
  tag: string,
  props: Record<string, JsonSchema>,
  options: TagSchemaOptions = {},
): JsonSchema {
  return tagSchema('connection', tag, props, options);
}

/** Read a tag's declared kind without inspecting any authored element properties. */
export function elementKindOf(schema: object | undefined): ElementKind | undefined {
  const kind = (schema as Record<string, unknown> | undefined)?.[ELEMENT_KIND_KEYWORD];

  return typeof kind === 'string' && (ELEMENT_KINDS as readonly string[]).includes(kind)
    ? (kind as ElementKind)
    : undefined;
}

/** True when the tag schema declares its members as containers (`x-is-container`). */
export function isContainerTag(schema: object | undefined): boolean {
  return (schema as Record<string, unknown> | undefined)?.[CONTAINER_KEYWORD] === true;
}

function tagSchema(
  kind: ElementKind,
  tag: string,
  props: Record<string, JsonSchema>,
  options: EntitySchemaOptions,
): JsonSchema {
  const profileProperties = Object.fromEntries(
    Object.entries(props).filter(([name]) => !CORE_PROPERTY_NAMES.has(name)),
  );
  const requestedRequired = options.required ?? [];
  const additionallyRequired = requestedRequired.filter((name) => {
    if (Object.hasOwn(profileProperties, name)) {
      return true;
    }

    return kind === 'entity' && Object.hasOwn(GeometryProperties, name);
  });
  const containerTag = kind === 'entity' && options.isContainer === true;
  const coreProperties =
    kind === 'entity'
      ? {
          ...GeometryProperties,
          ...EntityContainmentProperties,
          isContainer: {
            type: 'boolean' as const,
            ...(containerTag ? { default: true as const } : {}),
          },
        }
      : { ...ConnectionPositionProperties, ...ConnectionEndpointProperties };
  const alwaysRequired = [
    'tag',
    ...(kind === 'entity' || requestedRequired.includes('id') ? ['id'] : []),
    ...(kind === 'connection' ? ['from', 'to'] : []),
  ];
  const required = [...new Set([...alwaysRequired, ...additionallyRequired])];
  const kindExclusions: JsonSchema[] =
    kind === 'entity'
      ? [{ required: ['from'] }, { required: ['to'] }]
      : [{ required: ['containerId'] }, { required: ['width'] }, { required: ['height'] }];
  return {
    type: 'object',
    'x-schema-kind': kind,
    ...(containerTag ? { 'x-is-container': true as const } : {}),
    not: { anyOf: kindExclusions },
    additionalProperties: false,
    required,
    properties: {
      ...profileProperties,
      tag: { const: tag, type: 'string' },
      id: { type: 'string', minLength: 1 },
      ...coreProperties,
    },
  };
}
