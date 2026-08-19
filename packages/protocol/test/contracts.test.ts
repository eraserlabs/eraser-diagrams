import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  connectionSchema,
  DATA_ROLES,
  elementKindOf,
  entitySchema,
  isContainerTag,
  PROTOCOL_ACRONYM,
  PROTOCOL_ID,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  TEXT_SIZE_POLICIES,
} from '../src/index.js';

const schemas = ['document', 'tag-schema'] as const;

describe('@eraserlabs/protocol contracts', () => {
  it('publishes one internally consistent experimental version', () => {
    expect(PROTOCOL_NAME).toBe('Model Diagramming Protocol');
    expect(PROTOCOL_ACRONYM).toBe('MDP');
    expect(PROTOCOL_VERSION).toBe('0.1');
    expect(PROTOCOL_ID).toBe(`mdp/${PROTOCOL_VERSION}`);
  });

  it('keeps the semantic template-role vocabulary stable', () => {
    expect(DATA_ROLES).toEqual(['body', 'anchor', 'badge', 'external-text', 'internal-text']);
    expect(TEXT_SIZE_POLICIES).toEqual(['balanced', 'width-only', 'height-only']);
  });

  it('classifies tags in schemas rather than authored items', () => {
    const entity = entitySchema(
      'Card',
      {
        title: { type: 'string' },
        variant: { type: 'string', enum: ['primary', 'secondary'], default: 'primary' },
      },
      { required: ['x', 'width', 'title'] },
    );
    const connection = connectionSchema('Flow', {});

    expect(elementKindOf(entity)).toBe('entity');
    expect(entity.required).toEqual(['tag', 'id', 'x', 'width', 'title']);
    expect(entity.properties?.['variant']).toEqual({
      type: 'string',
      enum: ['primary', 'secondary'],
      default: 'primary',
    });
    expect(entity.not).toEqual({
      anyOf: [{ required: ['from'] }, { required: ['to'] }],
    });
    expect(entity.properties?.['isContainer']).toEqual({ type: 'boolean' });
    expect(elementKindOf(connection)).toBe('connection');
    expect(connection.required).toEqual(['tag', 'from', 'to']);
    expect(connection.properties?.['id']).toEqual({ type: 'string', minLength: 1 });
    expect(connection.properties?.['x']).toEqual({ type: 'number', minimum: 0 });
    expect(connection.properties?.['y']).toEqual({ type: 'number', minimum: 0 });
    expect(connection.properties?.['width']).toBeUndefined();
    expect(connection.properties?.['height']).toBeUndefined();
    expect(connection.properties?.['containerId']).toBeUndefined();
    expect(connection.not).toEqual({
      anyOf: [{ required: ['containerId'] }, { required: ['width'] }, { required: ['height'] }],
    });

    const authoredIdConnection = connectionSchema('IdentifiedFlow', {}, { required: ['id'] });
    expect(authoredIdConnection.required).toEqual(['tag', 'id', 'from', 'to']);
  });

  it('does not let profile properties redefine kind-owned fields', () => {
    const connection = connectionSchema('Flow', {
      tag: { const: 'Wrong' },
      from: { type: 'number' },
      containerId: { type: 'string' },
    });

    expect(connection.properties?.['tag']).toEqual({ const: 'Flow', type: 'string' });
    expect(connection.properties?.['from']).toEqual({
      type: 'string',
      minLength: 1,
      'x-ref': 'element',
    });
    expect(connection.properties?.['width']).toBeUndefined();
    expect(connection.properties?.['containerId']).toBeUndefined();

    const entity = entitySchema('Card', { x: { type: 'number' } }, { required: ['x'] });
    expect(entity.required).toEqual(['tag', 'id', 'x']);

    const stripped = entitySchema(
      'Card',
      { isContainer: { type: 'boolean' } },
      { isContainer: true },
    );
    expect(stripped['x-is-container']).toBe(true);
    expect(stripped.properties?.['isContainer']).toEqual({ type: 'boolean', default: true });
  });

  it('declares container-ness on the tag and allows per-entity isContainer', () => {
    const group = entitySchema('Group', {}, { isContainer: true });
    const shape = entitySchema('Shape', {});

    expect(isContainerTag(group)).toBe(true);
    expect(group['x-is-container']).toBe(true);
    expect(group.properties?.['isContainer']).toEqual({ type: 'boolean', default: true });
    expect(isContainerTag(shape)).toBe(false);
    expect(shape['x-is-container']).toBeUndefined();
    expect(shape.properties?.['isContainer']).toEqual({ type: 'boolean' });
  });

  it('publishes authored kind boundaries', () => {
    const authoredPath = fileURLToPath(new URL('../schemas/document.schema.json', import.meta.url));
    const authored = JSON.parse(readFileSync(authoredPath, 'utf8')) as {
      oneOf: { $ref: string }[];
      definitions: Record<string, { required: string[]; properties: Record<string, unknown> }>;
    };

    // Two interchangeable input forms, both object envelopes — a bare array is not a document.
    // The split form demands both keys so an empty connection list is stated rather than forgotten.
    expect(authored.oneOf.map((branch) => branch.$ref)).toEqual([
      '#/definitions/elementsEnvelope',
      '#/definitions/splitEnvelope',
    ]);
    expect(authored.definitions).not.toHaveProperty('bareArray');
    expect(authored.definitions['splitEnvelope']!.required).toEqual(['entities', 'connections']);
    expect(authored.definitions['elementsEnvelope']!.required).toEqual(['elements']);
    expect(authored.definitions['elementsEnvelope']!.properties).toHaveProperty('title');
    expect(authored.definitions['splitEnvelope']!.properties).toHaveProperty('title');

    expect(authored.definitions['entity']!.required).toContain('id');
    expect(authored.definitions['connection']!.required).toEqual(['tag', 'from', 'to']);
    expect(authored.definitions['connection']!.properties).not.toHaveProperty('width');
    expect(authored.definitions['connection']!.properties).not.toHaveProperty('height');
  });

  it.each(schemas)('%s schema is valid JSON for protocol 0.1', (name) => {
    const path = fileURLToPath(new URL(`../schemas/${name}.schema.json`, import.meta.url));
    const schema = JSON.parse(readFileSync(path, 'utf8')) as {
      $schema?: string;
      $id?: string;
    };

    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(schema.$id).toContain(PROTOCOL_VERSION);
  });
});
