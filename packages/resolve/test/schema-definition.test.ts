import { describe, expect, it } from 'vitest';
import { createResolver, SchemaDefinitionError, type TemplateLibrary } from '../src/index.js';
import { connectionSchema, entitySchema, type JsonSchema } from '@eraserlabs/protocol/schema';

/**
 * An intentionally small variation of the stock Eraser Shape schema. It exercises nested objects,
 * arrays, enums, patterns, and every common annotation while remaining plain serializable data.
 */
const ERASER_SHAPE_EXAMPLE = entitySchema(
  'Shape',
  {
    shape: { type: 'string', enum: ['rectangle', 'ellipse', 'diamond'] },
    texts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: { type: 'string', 'x-content': 'markdown' },
        },
      },
    },
    icon: { type: 'string', 'x-icon-name': true },
    bgColor: { type: 'string', 'x-css-color': true },
    fontSize: {
      anyOf: [
        { type: 'string', enum: ['sm', 'md', 'lg'] },
        { type: 'number', minimum: 0 },
      ],
    },
    geoPath: { type: 'string', pattern: '^[MLAZ0-9,. \\-]+$' },
  },
  { required: ['shape'] },
);

function cloneExample(): Record<string, unknown> {
  // This is the user-facing contract: the validator receives JSON data, not TypeScript builders.
  return JSON.parse(JSON.stringify(ERASER_SHAPE_EXAMPLE)) as Record<string, unknown>;
}

async function boot(schema: object): Promise<void> {
  const library: TemplateLibrary = {
    manifest: ['Shape'],
    schemas: { Shape: schema },
    templates: [
      {
        name: 'Shape',
        html: '<template name="Shape"><div data-tpl="Shape" data-role="body"></div></template>',
        css: '',
      },
    ],
    baseCss: '',
  };

  await createResolver({ library });
}

async function definitionError(schema: object): Promise<SchemaDefinitionError> {
  try {
    await boot(schema);
  } catch (error) {
    expect(error).toBeInstanceOf(SchemaDefinitionError);

    return error as SchemaDefinitionError;
  }

  throw new Error('expected schema definition to be rejected');
}

describe('MDP schema-definition validation', () => {
  it('accepts a stock-like schema after a JSON serialization round trip', async () => {
    await expect(boot(cloneExample())).resolves.toBeUndefined();
  });

  it('rejects misspelled and unsupported JSON Schema keywords with all errors', async () => {
    const schema = cloneExample();
    schema['requird'] = ['tag', 'id'];
    const properties = schema['properties'] as Record<string, Record<string, unknown>>;
    properties['shape']!['$ref'] = '#/definitions/anything';
    const error = await definitionError(schema);

    expect(error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/requird', message: 'unsupported keyword "requird"' }),
        expect.objectContaining({
          path: '/properties/shape/$ref',
          message: 'unsupported keyword "$ref"',
        }),
      ]),
    );
  });

  it('rejects invalid MDP annotation values', async () => {
    const schema = cloneExample();
    const properties = schema['properties'] as Record<string, Record<string, unknown>>;
    const texts = properties['texts']!['items'] as Record<string, unknown>;
    const textProperties = texts['properties'] as Record<string, Record<string, unknown>>;
    textProperties['text']!['x-content'] = 'raw-script';
    const error = await definitionError(schema);

    expect(error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/properties/texts/items/properties/text/x-content',
          keyword: 'enum',
        }),
      ]),
    );
  });

  it('rejects a registry key that disagrees with the tag const', async () => {
    const schema = cloneExample();
    const properties = schema['properties'] as Record<string, Record<string, unknown>>;
    properties['tag']!['const'] = 'NotShape';
    const error = await definitionError(schema);

    expect(error.issues).toContainEqual({
      path: '/properties/tag/const',
      keyword: 'const',
      message: 'must equal its registry key "Shape"',
    });
  });

  it('rejects kind-owned field violations', async () => {
    const schema = cloneExample();
    schema['x-schema-kind'] = 'connection';
    const error = await definitionError(schema);

    expect(error.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        '/required',
        '/properties/from',
        '/properties/to',
        '/properties/containerId',
      ]),
    );
  });

  it('rejects x-is-container on connections and nested nodes', async () => {
    const connection = connectionSchema('Wire', {}) as Record<string, unknown>;
    connection['x-is-container'] = true;
    const connectionError = await definitionError(connection);
    expect(connectionError.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/x-is-container',
          keyword: 'x-is-container',
          message: 'connection schemas may not declare x-is-container',
        }),
      ]),
    );

    const nested = cloneExample();
    const nestedProperties = nested['properties'] as Record<string, Record<string, unknown>>;
    nestedProperties['shape']!['x-is-container'] = true;
    const nestedError = await definitionError(nested);
    expect(nestedError.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/properties/shape/x-is-container',
          keyword: 'x-is-container',
        }),
      ]),
    );

    const authored = cloneExample();
    const authoredProperties = authored['properties'] as Record<string, unknown>;
    authoredProperties['isContainer'] = { type: 'string' };
    const authoredError = await definitionError(authored);
    expect(authoredError.issues).toContainEqual({
      path: '/properties/isContainer/type',
      keyword: 'type',
      message: 'must be "boolean"',
    });
  });

  it('accepts x-is-container on an entity tag root', async () => {
    await expect(boot(entitySchema('Shape', {}, { isContainer: true }))).resolves.toBeUndefined();
  });

  it('does not require entity schemas to declare isContainer', async () => {
    const schema = cloneExample();
    const properties = schema['properties'] as Record<string, unknown>;
    Reflect.deleteProperty(properties, 'isContainer');
    await expect(boot(schema)).resolves.toBeUndefined();
  });

  it('rejects schema-kind below the tag root and annotations on incompatible types', async () => {
    const schema = cloneExample();
    const properties = schema['properties'] as Record<string, Record<string, unknown>>;
    properties['shape']!['x-schema-kind'] = 'entity';
    properties['fontSize']!['x-content'] = 'plain';
    const error = await definitionError(schema);

    expect(error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/properties/shape/x-schema-kind',
          keyword: 'x-schema-kind',
        }),
        expect.objectContaining({
          path: '/properties/fontSize/x-content',
          keyword: 'x-content',
        }),
      ]),
    );
  });

  it('rejects required names that have no property schema', async () => {
    const schema = cloneExample();
    (schema['required'] as string[]).push('missingProfileProperty');
    const error = await definitionError(schema);

    expect(error.issues).toContainEqual({
      path: '/required',
      keyword: 'required',
      message: 'required property "missingProfileProperty" is not declared in properties',
    });
  });

  it('rejects malformed core geometry even when the rest of the profile is valid', async () => {
    const schema = cloneExample();
    const properties = schema['properties'] as Record<string, JsonSchema>;
    properties['width'] = { type: 'number', minimum: -1 };
    const error = await definitionError(schema);

    expect(error.issues).toContainEqual({
      path: '/properties/width/minimum',
      keyword: 'minimum',
      message: 'must be 0',
    });
  });

  it('accepts a scalar default on an optional enum', async () => {
    await expect(
      boot(
        entitySchema('Shape', {
          shape: { type: 'string', enum: ['rectangle', 'ellipse'], default: 'rectangle' },
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects a default that is not a valid instance of its schema', async () => {
    const error = await definitionError(
      entitySchema('Shape', {
        shape: { type: 'string', enum: ['rectangle', 'ellipse'], default: 'circle' },
      }),
    );

    expect(error.issues).toContainEqual({
      path: '/properties/shape/default',
      keyword: 'default',
      message: 'must be a valid instance of this schema',
    });
  });

  it('rejects default on a required property', async () => {
    const error = await definitionError(
      entitySchema(
        'Shape',
        { shape: { type: 'string', enum: ['rectangle'], default: 'rectangle' } },
        { required: ['shape'] },
      ),
    );

    expect(error.issues).toContainEqual({
      path: '/properties/shape/default',
      keyword: 'default',
      message: 'may not annotate a required property',
    });
  });

  it('rejects default on core geometry', async () => {
    const schema = cloneExample();
    const properties = schema['properties'] as Record<string, Record<string, unknown>>;
    properties['x']!['default'] = 0;
    const error = await definitionError(schema);

    expect(error.issues).toContainEqual({
      path: '/properties/x/default',
      keyword: 'default',
      message: 'geometry properties may not declare a default; absence is distinct from zero',
    });
  });

  it('rejects default on the tag schema root', async () => {
    const schema = cloneExample();
    schema['default'] = null;
    const error = await definitionError(schema);

    expect(error.issues).toContainEqual({
      path: '/default',
      keyword: 'default',
      message: 'is only allowed on properties, not the tag schema root',
    });
  });

  it('allows entity schemas to require their non-negative geometry', async () => {
    const schema = entitySchema('Shape', {}, { required: ['x', 'y', 'width', 'height'] });

    await expect(boot(schema)).resolves.toBeUndefined();
  });

  it('allows optional or explicitly required connection ids', async () => {
    await expect(boot(connectionSchema('Shape', {}))).resolves.toBeUndefined();
    await expect(
      boot(connectionSchema('Shape', {}, { required: ['id'] })),
    ).resolves.toBeUndefined();
  });

  it('rejects connection bounds and required connection origins', async () => {
    const schema = connectionSchema('Shape', {}) as Record<string, unknown>;
    const properties = schema['properties'] as Record<string, JsonSchema>;
    properties['width'] = { type: 'number', minimum: 0 };
    (schema['required'] as string[]).push('x');
    const error = await definitionError(schema);

    expect(error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/required',
          message: 'connection origin property "x" must remain optional',
        }),
        expect.objectContaining({
          path: '/properties/width',
          message: 'connection schemas may not declare the entity-owned width property',
        }),
      ]),
    );
  });
});
