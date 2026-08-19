import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/boot.js';

let app: FastifyInstance;
beforeAll(async () => {
  ({ app } = await buildServer({ renderPages: 0 }));
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

describe('POST /validate', () => {
  it('returns 200 with ok:true for valid input', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/validate',
      payload: { elements: [{ tag: 'Shape', id: 's', x: 0, y: 0, texts: [{ text: 'hi' }] }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body).not.toHaveProperty('shell');
  });

  it('requires Eraser entity placement but synthesizes omitted connection identity', async () => {
    const missingPlacement = await app.inject({
      method: 'POST',
      url: '/validate',
      payload: { elements: [{ tag: 'Shape', id: 'a' }] },
    });
    expect(missingPlacement.statusCode).toBe(200);
    expect(missingPlacement.json().ok).toBe(false);

    const idlessConnection = await app.inject({
      method: 'POST',
      url: '/validate',
      payload: {
        elements: [
          { tag: 'Shape', id: 'a', x: 0, y: 0 },
          { tag: 'Shape', id: 'b', x: 200, y: 0 },
          { tag: 'Relationship', from: 'a', to: 'b' },
        ],
      },
    });
    expect(idlessConnection.statusCode).toBe(200);
    expect(idlessConnection.json()).toMatchObject({ ok: true, errors: [] });
  });

  it('returns 200 with structured errors for invalid input (no error transport)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/validate',
      payload: { elements: [{ tag: 'Shpe', id: 'x', x: 0, y: 0 }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.errors[0].code).toBe('E_UNKNOWN_TAG');
    expect(body.errors[0].suggestion).toBe('Shape');
  });

  it('rejects a bare-array body with the E_ENVELOPE teaching message', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/validate',
      payload: [{ tag: 'Shape', id: 's', x: 0, y: 0 }],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.errors[0].code).toBe('E_ENVELOPE');
    expect(body.errors[0].message).toBe(
      'Input must be an object: wrap the array in { "elements": [...] }.',
    );
  });

  it('maps malformed JSON to a 400 E_BAD_JSON envelope', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/validate',
      headers: { 'content-type': 'application/json' },
      payload: '{ not json',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].code).toBe('E_BAD_JSON');
  });

  it('maps an oversized body to a 413 E_PAYLOAD_TOO_LARGE envelope', async () => {
    const { app: small } = await buildServer({ bodyLimit: 1024, renderPages: 0 });
    await small.ready();

    try {
      const res = await small.inject({
        method: 'POST',
        url: '/validate',
        payload: {
          elements: [{ tag: 'Shape', id: 's', x: 0, y: 0, texts: [{ text: 'x'.repeat(2048) }] }],
        },
      });
      expect(res.statusCode).toBe(413);
      expect(res.json().errors[0].code).toBe('E_PAYLOAD_TOO_LARGE');
    } finally {
      await small.close();
    }
  });
});
