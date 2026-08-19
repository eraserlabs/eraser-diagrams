import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { stockLibrary } from '@eraserlabs/diagrams';
import { buildServer } from '../src/boot.js';

let app: FastifyInstance;
beforeAll(async () => {
  ({ app } = await buildServer({ renderPages: 0 }));
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

describe('GET /registry', () => {
  it('lists exactly the stock library tags', async () => {
    const res = await app.inject({ method: 'GET', url: '/registry' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const listed = body.tags.map((t: { tag: string }) => t.tag).sort();
    expect(listed).toEqual(Object.keys(stockLibrary.schemas).sort());
  });
});

describe('GET /registry/schema/:tag', () => {
  it('publishes the Eraser entity placement requirements', async () => {
    const res = await app.inject({ method: 'GET', url: '/registry/schema/Shape' });
    expect(res.statusCode).toBe(200);
    const schema = res.json();
    expect(schema.properties.tag).toBeDefined();
    expect(schema.required).toEqual(expect.arrayContaining(['tag', 'id', 'x', 'y']));
    expect(schema.required).not.toContain('width');
    expect(schema.required).not.toContain('height');
  });

  it('publishes optional connection identity and object waypoint data', async () => {
    const res = await app.inject({ method: 'GET', url: '/registry/schema/Relationship' });
    expect(res.statusCode).toBe(200);
    const schema = res.json();
    expect(schema.required).toEqual(expect.arrayContaining(['tag', 'from', 'to']));
    expect(schema.required).not.toContain('id');
    expect(schema.properties).not.toHaveProperty('width');
    expect(schema.properties).not.toHaveProperty('height');
    expect(schema.properties.points).toMatchObject({
      type: 'array',
      minItems: 2,
      items: {
        type: 'object',
        required: ['x', 'y'],
        additionalProperties: false,
      },
    });
  });

  it('404s for an unknown tag', async () => {
    const res = await app.inject({ method: 'GET', url: '/registry/schema/Nope' });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /health', () => {
  it('reports ok once warm', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
  });
});
