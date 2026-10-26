import { elementKindOf } from '@eraserlabs/protocol/schema';
import { assertValidTagSchema, SchemaDefinitionError } from './definition.js';
import { PALETTE_KEYWORD } from './keywords.js';
import { walkSchema } from './walk.js';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** A private view for template lint and post-normalizer policies, never an input validator. */
export function withRenderProps(
  schema: object,
  renderProps: Record<string, object> | undefined,
): object {
  if (renderProps === undefined) {
    return schema;
  }

  const root = schema as Record<string, unknown>;

  return {
    ...root,
    properties: { ...(root['properties'] as object), ...renderProps },
  };
}

/** Validate a library's internal declarations before they authorize template bindings. */
export function checkRenderProps(
  schemas: Record<string, object>,
  renderProps: Record<string, Record<string, object>> | undefined,
  hasPalette: boolean,
): void {
  if (renderProps === undefined) {
    return;
  }

  if (!isRecord(renderProps)) {
    fail('renderProps', '/', 'must be an object mapping dispatchable tags to property schemas');
  }

  for (const [tag, properties] of Object.entries(renderProps)) {
    if (!Object.hasOwn(schemas, tag) || FORBIDDEN_KEYS.has(tag)) {
      fail(tag, '/', 'renderProps must name a dispatchable tag in the library');
    }
    if (!isRecord(properties)) {
      fail(tag, '/properties', 'renderProps entry must be an object of property schemas');
    }

    const schema = schemas[tag]!;
    const authoredProperties = (schema as { properties?: Record<string, unknown> }).properties;
    for (const name of Object.keys(properties)) {
      if (Object.hasOwn(authoredProperties ?? {}, name) || name === 'isContainer') {
        fail(
          tag,
          `/properties/${escapePointer(name)}`,
          'render property conflicts with authored input',
        );
      }
    }
    checkKeys(tag, properties, '/properties');

    const combined = withRenderProps(schema, properties);
    // Preserve the template linter's missing-element-kind diagnostic. An unclassified authored
    // schema cannot pass library boot; defer its schema failure to that existing check.
    if (elementKindOf(schema)) {
      assertValidTagSchema(tag, combined, hasPalette);
    }
    walkSchema({ type: 'object', properties }, (node, pointer) => {
      if (node[PALETTE_KEYWORD] !== undefined) {
        fail(
          tag,
          pointer,
          'render properties must use CssColor instead of PaletteColor; palette lookup precedes normalizers',
        );
      }
    });
  }
}

function checkKeys(tag: string, value: unknown, path: string): void {
  if (value === null || typeof value !== 'object') {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}/${escapePointer(key)}`;
    if (FORBIDDEN_KEYS.has(key)) {
      fail(tag, childPath, 'forbidden key in render property declaration');
    }
    checkKeys(tag, child, childPath);
  }
}

function isRecord(value: unknown): value is Record<string, object> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(tag: string, path: string, message: string): never {
  throw new SchemaDefinitionError(tag, [{ path, keyword: 'renderProps', message }]);
}

function escapePointer(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}
